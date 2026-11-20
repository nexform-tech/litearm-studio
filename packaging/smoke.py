"""Start the built Debian package on the Ubuntu releases it has to run on.

Usage (repository root, after `packaging/deb.py` produced the package):

```bash
python packaging/smoke.py upload/litearm-studio_0.25.1_amd64.deb
python packaging/smoke.py --release 24.04 --release 26.04 --timeout 30 ...
```

**Why this exists.** The Linux package is built on Ubuntu 22.04 so the frozen
runtime keeps the `libc6 (>= 2.35)` floor, but it runs on newer LTS releases with
a newer system GTK/WebKit stack. A build-machine library inside `_internal/` can
shadow the target's copy: v0.25.0 carried Ubuntu 22.04's `libstdc++.so.6`, which
lacks `CXXABI_1.3.15`; WebKitGTK on 26.04 consequently failed to load its
typelib and the window never opened. Unit tests cannot see that failure. Starting
the package on the target release can.

Each release runs in its own Docker container: install the package, Xvfb and a
DBus session, start the app against the fake arm, and require that it is still
running when `timeout` kills it, that it reported an open window, and that the UI
connected over its WebSocket. The package is never exercised against hardware
here; `--fake` is what makes this possible in CI.
"""
from __future__ import annotations

import argparse
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import List, NamedTuple, Optional, Sequence, Union

#: The LTS releases the Linux package must start on. Keep this list aligned with
#: docs/INSTALL.md; the package is built on 22.04, which is covered by the build
#: itself (the frozen runtime is linked against its glibc).
RELEASES = ("24.04", "26.04")

#: The daemon's own line once pywebview created the window.
#: `window.py` logs it before entering `webview.start()`, so it proves the GTK
#: backend loaded rather than merely that the HTTP server came up.
WINDOW_OPENED = "应用窗口已打开"

#: uvicorn's access line for the page's WebSocket. If the window opened but the
#: UI never connected, the operator still sees a blank window.
UI_CONNECTED = "connection open"

#: The failure signatures this smoke test exists to catch (plus any other reason
#: the window could not be created). A log containing one of these fails even if
#: the process somehow stayed alive.
FAILURE_MARKERS = (
    "无法打开应用窗口",
    "Failed to load shared library",
    "CXXABI_",
    "GLIBC_",
)

#: `timeout(1)` exits with 124 when the command was still running at the deadline.
STILL_RUNNING = 124

#: How long the app must survive after opening the window, in seconds. The window
#: opens within a second or two; 15 s leaves a wide margin without paying a full
#: half-minute per release on every release build.
DEFAULT_TIMEOUT = 15

#: Extra wall-clock allowance for the in-container steps, on top of the app
#: timeout. The image pull is *not* covered here: it gets its own budget, so a
#: stalled registry is named instead of being charged to the container.
SETUP_TIMEOUT = 600

#: How long pulling the target image may take. `docker pull` has no deadline of
#: its own — a registry connection that stops answering sits until the job-level
#: timeout. On 2026-11-19 (v0.25.4) both containers sat out the job deadline with
#: an empty log, and nothing could say whether the pull, apt or the app was the
#: one stuck; that release went out with the Windows artifact only.
PULL_TIMEOUT = 300

#: How long each apt step inside the container may take before it is called a
#: stall. On a healthy runner both steps finish in well under a minute; without a
#: bound, apt's own per-connection waits and retries can consume the whole
#: container budget and leave the smoke log empty.
APT_UPDATE_TIMEOUT = 180
APT_INSTALL_TIMEOUT = 300

#: How long the app may ignore SIGTERM before `timeout` kills it outright.
#: Without this, an app that handles the signal but never finishes shutting down
#: would hang the container past every deadline.
KILL_AFTER = 5


def container_script(version: str, timeout: int,
                     apt_mirror: Optional[str] = None) -> str:
    """The shell script that runs inside one target distribution.

    `version` is checked against the installed package so a stale `.deb` cannot
    silently make the smoke test green. The app is killed by `timeout`, hence
    :data:`STILL_RUNNING` is the success exit code; one that exits earlier means
    it crashed or closed its window, and one that has to be SIGKILLed after the
    deadline (137) means it never finished shutting down.

    Every step prints where it is and carries its own deadline, so a stall names
    the step it happened in instead of surfacing as an empty log at the outer
    timeout.

    `apt_mirror` is only for local runs where the default Ubuntu archive is slow;
    CI leaves it unset and uses the image's own sources.
    """
    mirror_lines = ""
    if apt_mirror:
        mirror_lines = (
            "for file in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do\n"
            '    if [ -f "$file" ]; then\n'
            f'        sed -i "s|http://archive.ubuntu.com/ubuntu/|{apt_mirror}|g; '
            f's|http://security.ubuntu.com/ubuntu/|{apt_mirror}|g" "$file"\n'
            "    fi\n"
            "done\n"
        )
    return f"""\
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
{mirror_lines}echo "[smoke] container started"
# Force IPv4: a container with a broken IPv6 route can otherwise sit on
# a connection until the whole smoke step times out.
# ⚠ 每一步都自带上限, 超时时报出自己的名字: apt 默认会为每个连接等上两分钟再
# 重试, 一次镜像站卡住就能把外层预算耗光, 而日志里只剩"the container did not
# finish" —— 2026-11-19 的 v0.25.4 发布正是这样, 看不出卡在哪一步。
apt_options=(-qq -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=30 \\
    -o Acquire::https::Timeout=30 -o Acquire::Retries=1)
echo "[smoke] apt-get update (limit {APT_UPDATE_TIMEOUT}s)"
timeout {APT_UPDATE_TIMEOUT} apt-get update "${{apt_options[@]}}" || {{
    echo "[smoke] apt-get update failed or did not finish within {APT_UPDATE_TIMEOUT}s" >&2
    exit 1
}}
echo "[smoke] apt-get install (limit {APT_INSTALL_TIMEOUT}s)"
timeout {APT_INSTALL_TIMEOUT} apt-get install -y "${{apt_options[@]}}" \\
    --no-install-recommends /tmp/litearm-studio.deb xvfb xauth dbus-x11 bubblewrap || {{
    echo "[smoke] apt-get install failed or did not finish within {APT_INSTALL_TIMEOUT}s" >&2
    exit 1
}}
installed="$(dpkg-query -W -f='${{Version}}' litearm-studio)"
if [ "$installed" != "{version}" ]; then
    echo "installed version $installed, expected {version}" >&2
    exit 1
fi
Xvfb :99 -screen 0 1440x900x24 >/tmp/xvfb.log 2>&1 &
sleep 1
export DISPLAY=:99
echo "[smoke] starting the package (must stay up for {timeout}s)"
set +e
timeout -k {KILL_AFTER} {timeout} dbus-run-session -- litearm-studio --fake --no-gripper >/tmp/app.log 2>&1
code=$?
set -e
cat /tmp/app.log
if [ "$code" -eq 137 ]; then
    echo "daemon did not exit on SIGTERM and was killed {KILL_AFTER}s past the deadline" >&2
    exit 1
fi
if [ "$code" -ne {STILL_RUNNING} ]; then
    echo "daemon exited with $code instead of staying up until the timeout" >&2
    exit 1
fi
"""


def check_log(text: str) -> List[str]:
    """What is wrong with the app log, if anything; empty means the smoke passed.

    Split out from :func:`run_release` so the judgement can be unit-tested without
    Docker: the assertions are the part that must not silently regress.
    """
    problems: List[str] = []
    if WINDOW_OPENED not in text:
        problems.append("the daemon never reported an open window")
    if UI_CONNECTED not in text:
        problems.append("the UI never connected over the WebSocket")
    for marker in FAILURE_MARKERS:
        if marker in text:
            problems.append(f"log contains failure marker {marker!r}")
    return problems


def package_version(deb: Path) -> str:
    """The version `deb.py` stamped into the package."""
    result = subprocess.run(
        ["dpkg-deb", "-f", str(deb), "Version"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"cannot read the version of {deb}: {result.stderr.strip()}")
    version = result.stdout.strip()
    if not version:
        raise SystemExit(f"the package at {deb} has an empty Version field")
    return version


class Outcome(NamedTuple):
    """One release's result: its captured output and whatever is wrong with it."""

    release: str
    output: str
    problems: List[str]


def _timeout_output(value: Union[bytes, str, None]) -> str:
    """What a timed-out `subprocess.run` captured, as text.

    ⚠ On POSIX the exception carries the **raw bytes** even when the call passed
    ``text=True``: decoding happens in `communicate()`, which never returns once
    the deadline fires. Joining those bytes onto a string raises `TypeError` —
    the crash would hide exactly the output this is meant to rescue.
    """
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


def pull_image(release: str) -> List[str]:
    """Make sure ``ubuntu:<release>`` is in the local image store.

    Returns what is wrong, empty when the image is ready. This is a step of its
    own rather than only `docker run --pull=missing`: `docker pull` has no
    deadline, and when it stalls the container never starts, so the run's
    captured output stays empty. :data:`PULL_TIMEOUT` turns that into a failure
    that names the image.
    """
    image = f"ubuntu:{release}"
    try:
        result = subprocess.run(
            ["docker", "pull", "--quiet", image],
            capture_output=True, text=True, timeout=PULL_TIMEOUT, check=False,
        )
    except FileNotFoundError:
        return ["docker is not available; the release job needs a Docker runner"]
    except subprocess.TimeoutExpired:
        return [f"pulling {image} did not finish within {PULL_TIMEOUT}s"]
    except OSError as exc:
        return [f"could not start docker: {exc}"]
    if result.returncode != 0:
        # 压成一行: 问题列表按 "- ..." 逐行打印, 多行的 docker 报错会把版式拆散。
        detail = " ".join((result.stderr or result.stdout or "").split())
        return [f"could not pull {image}: {detail}" if detail
                else f"could not pull {image}"]
    return []


def execute_release(release: str, deb: Path, version: str, timeout: int,
                    apt_mirror: Optional[str] = None) -> Outcome:
    """Run one release in Docker and return its output and problems.

    Does not print or raise for a failed release: :func:`run_all` calls this on a
    worker thread and prints each block in the main thread, so two parallel
    containers cannot interleave their logs.

    `--privileged` is needed for WebKitGTK's bubblewrap sandbox inside the
    container (it sets up user namespaces). The container is ephemeral and only
    runs our own package, so the wider capability set buys a working window and
    nothing else.

    A timeout keeps whatever the container printed before it: those last lines
    are the only evidence of the step that stalled.
    """
    problems = pull_image(release)
    if problems:
        return Outcome(release, "", problems)
    command = [
        "docker", "run", "--rm", "--privileged", "--pull=missing",
        "--volume", f"{deb.resolve()}:/tmp/litearm-studio.deb:ro",
        f"ubuntu:{release}", "bash", "-lc",
        container_script(version, timeout, apt_mirror),
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True,
            timeout=timeout + SETUP_TIMEOUT, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        # ⚠ POSIX 的 `run` 把超时前读到的输出挂在异常上; 丢掉它, 日志里就只剩
        # "did not finish within Ns" —— 2026-11-19 的 v0.25.4 发布正是这样,
        # 没人看得出卡在 apt 还是启动应用。
        partial = _timeout_output(exc.stdout) + _timeout_output(exc.stderr)
        return Outcome(release, partial, [
            f"the container did not finish within {timeout + SETUP_TIMEOUT}s"])
    except OSError as exc:
        return Outcome(release, "", [f"could not start docker: {exc}"])

    output = (result.stdout or "") + (result.stderr or "")
    problems = check_log(output)
    if result.returncode != 0:
        problems.append(f"docker run exited with {result.returncode}")
    return Outcome(release, output, problems)


def run_release(release: str, deb: Path, version: str, timeout: int,
                apt_mirror: Optional[str] = None) -> None:
    """Run one release, print its log, and raise ``SystemExit`` on failure.

    A convenience for a single release (and for the unit tests); :func:`main`
    uses :func:`run_all` so the two target releases run in parallel.
    """
    print(f"[smoke] ubuntu:{release} (package {version}) ...", flush=True)
    outcome = execute_release(release, deb, version, timeout, apt_mirror)
    print(outcome.output, end="")
    if outcome.problems:
        details = "\n".join(f"  - {problem}" for problem in outcome.problems)
        raise SystemExit(f"[smoke] ubuntu:{release} failed:\n{details}")
    print(f"[smoke] ubuntu:{release}: window opened and the UI connected", flush=True)


def run_all(releases: Sequence[str], deb: Path, version: str, timeout: int,
            apt_mirror: Optional[str] = None) -> int:
    """Run every target release in parallel; return 0 only if all of them pass.

    Both releases are independent containers, so running them serially only
    doubles the wall-clock time. Output is buffered per release and printed as one
    block, which keeps parallel logs readable and makes a failure easy to find.
    A failing release does not hide the other's result.
    """
    releases = list(releases)
    if not releases:
        return 0
    print(f"[smoke] {', '.join(f'ubuntu:{release}' for release in releases)} "
          f"in parallel (package {version})", flush=True)
    failed = False
    with ThreadPoolExecutor(max_workers=len(releases)) as pool:
        futures = {
            pool.submit(execute_release, release, deb, version, timeout, apt_mirror): release
            for release in releases
        }
        for future in as_completed(futures):
            release = futures[future]
            try:
                outcome = future.result()
            except Exception as exc:  # noqa: BLE001 - one release must not hide the other
                outcome = Outcome(release, "", [f"unexpected failure: {exc}"])
            print(f"\n===== ubuntu:{release} =====")
            print(outcome.output, end="")
            if outcome.problems:
                failed = True
                details = "\n".join(f"  - {problem}" for problem in outcome.problems)
                print(f"[smoke] ubuntu:{release} failed:\n{details}")
            else:
                print(f"[smoke] ubuntu:{release}: window opened and the UI connected")
    return 1 if failed else 0


def apt_mirror_arg(value: str) -> str:
    """A safe ``--apt-mirror`` value: http(s), no shell metacharacters, trailing slash.

    The value is substituted into a `sed` expression inside the container, so it
    must not be able to break out of it; anything outside this shape is rejected
    before the container starts.
    """
    if not re.fullmatch(r"https?://[A-Za-z0-9.\-/:]+/?", value):
        raise argparse.ArgumentTypeError(
            "expected an http(s) URL such as http://mirrors.aliyun.com/ubuntu/")
    return value if value.endswith("/") else value + "/"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="litearm-studio-smoke",
        description="Start a built .deb on the Ubuntu releases it ships to")
    parser.add_argument("deb", type=Path, help="the .deb to install and start")
    parser.add_argument(
        "--release", dest="releases", action="append", metavar="VERSION",
        help="target Ubuntu release, repeatable (default: %s)"
             % ", ".join(RELEASES))
    parser.add_argument(
        "--timeout", type=int, default=DEFAULT_TIMEOUT, metavar="SECONDS",
        help="how long the app must stay alive (default: %(default)s)")
    parser.add_argument(
        "--apt-mirror", type=apt_mirror_arg, default=None, metavar="URL",
        help="replace the container's Ubuntu archive (useful behind a slow "
             "mirror); default: the image's own sources")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.deb.is_file():
        raise SystemExit(f"no package at {args.deb}")
    version = package_version(args.deb)
    return run_all(args.releases or RELEASES, args.deb, version,
                   args.timeout, args.apt_mirror)


if __name__ == "__main__":
    raise SystemExit(main())
