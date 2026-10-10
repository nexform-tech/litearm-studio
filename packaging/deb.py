"""Turn the packaged daemon into a Debian package for Ubuntu users.

Usage (**run from the repository root**, after `packaging/build.py` has produced the
executable — see `bundled_daemon()` for which of its two shapes this expects):

```bash
python packaging/deb.py
# artifact: packaging/dist/litearm-studio_<version>_amd64.deb
```

Why this exists. The bare executable runs, but it leaves every part of "install" to the
user:

* the download lands mode `0644`, so the user has to `chmod +x` it;
* the arm's serial device belongs to the `dialout` group, so the user has to
  `sudo usermod -aG dialout` and **log in again**;
* nothing appears in the application list, so the user has to remember where the file is.

A `.deb` answers all three once: `postinst` installs a udev rule with `TAG+="uaccess"`
(the desktop user gets an ACL on the device, so no group and no re-login), the desktop
entry and the icon land in the menu, and dpkg guarantees the file permissions.

**No new tooling.** This is the standard library plus `dpkg-deb`, which every Debian and
Ubuntu runner ships. `nfpm` could do the same job, but it means downloading a Go binary
to assemble one file and a handful of text files; `dpkg-deb --build --root-owner-group`
is enough, and every packaging script in this repository is a small readable Python
script (`build.py`, `checksums.py`).
"""
from __future__ import annotations

import argparse
import hashlib
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple, Union

# Windows consoles default to cp1252 and would raise on any non-ASCII print. Same guard
# as build.py/checksums.py, for the same reason: a packaging script must not die on its
# last line after the work is already done.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001 - non-standard stream or old interpreter
        pass

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "assets" / "icon-png"
WORK = ROOT / "packaging" / "build" / "deb"
OUT_DIST = ROOT / "packaging" / "dist"

#: What `packaging/build.py` leaves behind — a **file** in `onefile` mode, a **directory**
#: in `onedir` mode, and the same path either way. `bundled_daemon()` tells them apart;
#: the package is built from the directory shape (see there for why).
DEFAULT_BINARY = OUT_DIST / "litearm-studio-daemon"

PACKAGE = "litearm-studio"
BINARY_NAME = "litearm-studio-daemon"
#: Command the desktop entry and the documentation name. It is a wrapper, not the
#: executable itself: a PyInstaller bundle has no business on PATH under a name that
#: suggests a normal program.
LAUNCHER = "litearm-studio"
INSTALL_DIR = f"/usr/lib/{PACKAGE}"

#: The console's own default gripper calibration, shipped inside the daemon
#: package.  Single source of truth: the launcher exports this file's installed
#: path as LITEGRIP_FACTORY_CALIB, and the daemon reads the same bytes from its
#: package when that variable is unset — so there is exactly one copy to keep
#: right, not one per artifact.
FACTORY_CALIBRATION = (
    ROOT / "daemon" / "src" / "litearm_studio_daemon" / "gripper"
    / "factory_calibration.json"
)

#: The arm presents itself as a USB CDC device. `uaccess` is the point of shipping the
#: rule: systemd-logind gives the locally logged-in user an ACL on the device node, so
#: the operator never joins `dialout` and never logs out. `ID_MM_DEVICE_IGNORE` keeps
#: ModemManager from probing a CDC-ACM port that is not a modem.
VID_PID = ("1d50", "606f")

#: The bundled CPython is built against the ubuntu-22.04 runner, and its `libpython`
#: requires this glibc (verified with `objdump -T` on the unpacked bundle). Declaring it
#: makes apt refuse the install on an older distribution instead of leaving the user with
#: a binary that dies on `GLIBC_2.35 not found`.
GLIBC_FLOOR = "2.35"

HOMEPAGE = "https://github.com/nexform-tech/litearm-studio"
MAINTAINER = "Laurence Young <yangdong@nexform.tech>"
SYNOPSIS = "Operator console for LiteArm 7-DoF collaborative robotic arms"

#: The GTK build leaves `libwebkit2gtk` on the system (94 MB) and asks for it here.
#: `gir1.2-webkit2-4.1` is the idiomatic request: it brings the typelib and, through
#: `gir1.2-gtk-3.0`, the rest of the stack that `libwebkit2gtk` links against.
WEBKIT_DEPENDS = "gir1.2-webkit2-4.1"

#: Same variable `build.py` reads, so one setting drives both the artifact and what the
#: package says it needs. They must agree: a Qt build that declared the WebKit dependency
#: would pull 126 MB onto a machine that does not need it.
WINDOW_BACKEND_ENV = "LITEARM_STUDIO_WINDOW_BACKEND"

#: Browsers are a `Suggests`, never a `Depends` or a `Recommends`. The program works with
#: any browser (it opens a tab when it cannot find a Chromium build) and a `Recommends`
#: would pull a second browser onto an operator workstation that already has one.
BROWSER_SUGGESTS = "firefox | chromium | chromium-browser | google-chrome-stable"


def deb_version(version: str) -> str:
    """`v0.12.0` (a git tag) -> `0.12.0` (an upstream Debian version).

    Debian is stricter than a git tag: the upstream version must start with a digit and
    may contain only alphanumerics and `. + ~ -`, and a `-` would be read as the start of
    the Debian revision. Rejecting bad input here beats producing a package that `dpkg`
    refuses with a cryptic error.
    """
    value = version.strip()
    if value.startswith("v"):
        value = value[1:]
    if not value or not value[0].isdigit():
        raise SystemExit(f"[deb] version must start with a digit (Debian rule): {version!r}")
    allowed = set("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+~")
    bad = sorted({c for c in value if c not in allowed})
    if bad:
        raise SystemExit(f"[deb] version has characters Debian forbids {bad}: {version!r}")
    return value


def control_text(*, version: str, arch: str, installed_size_kb: int,
                 window_backend: str = "gtk") -> str:
    """The `DEBIAN/control` file. Field order follows `dpkg-deb`'s own output.

    `window_backend` decides whether the package borrows the system's WebKitGTK.

    The GTK build ships PyGObject and GTK inside the executable but deliberately leaves
    `libwebkit2gtk` on the system: that shared library is 94 MB, and pulling it in would
    put the package back at Qt's size. `gir1.2-webkit2-4.1` is the idiomatic way to ask
    for it — it brings the typelib and, through `gir1.2-gtk-3.0`, the rest of the stack.

    The Qt build bundles everything and needs no system library beyond `libc6`.
    """
    description = "\n".join(
        [
            f" {SYNOPSIS}.",
            " .",
            " The package installs a self-contained executable: the Python runtime, the",
            " arm SDK, the gripper SDK, the USB DFU engine and the web UI are all inside",
            " it, so the machine needs no Python and no repository checkout.",
            " .",
            " It also installs a udev rule that grants the logged-in desktop user access",
            " to the arm's USB CDC device, so the arm can be used without adding the user",
            " to the dialout group. The gripper additionally needs a SocketCAN interface;",
            " see the documentation installed at",
            f" /usr/share/doc/{PACKAGE}/ for how the program brings it up.",
        ]
    )
    return (
        f"Package: {PACKAGE}\n"
        f"Version: {version}\n"
        "Section: science\n"
        "Priority: optional\n"
        f"Architecture: {arch}\n"
        f"Maintainer: {MAINTAINER}\n"
        f"Depends: {', '.join(depends_for(window_backend))}\n"
        f"Suggests: {BROWSER_SUGGESTS}\n"
        f"Installed-Size: {installed_size_kb}\n"
        f"Homepage: {HOMEPAGE}\n"
        f"Description: {description}\n"
    )


def depends_for(window_backend: str) -> list[str]:
    """The `Depends` list for one window backend.

    ⚠ A browser is never a dependency, in either backend: the program brings its own
    renderer, so a machine with no browser installed must still work. `Suggests` is where
    a browser belongs, and only for people who want to open the interface in one.
    """
    depends = [f"libc6 (>= {GLIBC_FLOOR})"]
    if window_backend == "gtk":
        depends.append(WEBKIT_DEPENDS)
    return depends


def launcher_script() -> str:
    """`/usr/bin/litearm-studio`: a two-line wrapper, not a copy of the executable."""
    return (
        "#!/bin/sh\n"
        f"# Installed by the {PACKAGE} Debian package. The program itself is a\n"
        "# self-contained PyInstaller bundle under /usr/lib; this wrapper only gives it\n"
        "# a name on PATH that matches the desktop entry.\n"
        "#\n"
        "# Point the gripper at the packaged default calibration. The file lives under\n"
        "# /usr/lib beside the bundle rather than inside its `_internal/` tree, so the\n"
        "# path is the same on every launch whichever shape the release was built in —\n"
        "# that is what lets the calibration page name a stable file.\n"
        f"LITEGRIP_FACTORY_CALIB={INSTALL_DIR}/factory_calibration.json\n"
        "export LITEGRIP_FACTORY_CALIB\n"
        f'exec {INSTALL_DIR}/{BINARY_NAME} "$@"\n'
    )


def desktop_entry() -> str:
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Version=1.0\n"
        "Name=LiteArm Studio\n"
        f"Comment={SYNOPSIS}\n"
        f"Exec={LAUNCHER}\n"
        f"Icon={LAUNCHER}\n"
        # ⚠ 桌面靠这一行把**窗口**归到这个启动图标下 (Dock/任务栏显示的就是它)。窗口的
        # WM_CLASS 由 `window._set_desktop_identity()` 设成同一个值, 两处必须相等 ——
        # 不等的话窗口会借用别的程序的图标, 看起来"能用但就是不对"。
        # `packaging/tests/test_deb.py` 钉住这个等式。
        f"StartupWMClass={LAUNCHER}\n"
        "Terminal=false\n"
        "Categories=Utility;Science;\n"
        "Keywords=robot;arm;litearm;can;\n"
    )


def udev_rule() -> str:
    vendor, product = VID_PID
    return (
        f"# {PACKAGE}: the arm's USB CDC port, usable by the logged-in desktop user\n"
        "# without joining the dialout group. Installed by the Debian package; when\n"
        "# running the standalone executable, reproduce it by hand (docs/INSTALL.md).\n"
        'SUBSYSTEM=="tty", ATTRS{idVendor}=="%s", ATTRS{idProduct}=="%s", '
        'ENV{ID_MM_DEVICE_IGNORE}="1", TAG+="uaccess"\n' % (vendor, product)
    )


def copyright_text() -> str:
    return (
        "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\n"
        "Upstream-Name: LiteArm Studio\n"
        f"Source: {HOMEPAGE}\n"
        "\n"
        "Files: *\n"
        "Copyright: 2026 NexForm / YuDao\n"
        "License: Apache-2.0\n"
        " On Debian systems, the complete text of the Apache License 2.0 can be found in\n"
        " /usr/share/common-licenses/Apache-2.0.\n"
    )


def postinst_script() -> str:
    """`DEBIAN/postinst`.

    Every command is best-effort (`|| true`): a package that fails to configure because a
    container has no udev is worse than one whose rule is picked up at the next boot.
    """
    return (
        "#!/bin/sh\n"
        "# Maintainer script. $1 is \"configure\" on install and on upgrade.\n"
        "set -e\n"
        "\n"
        'if [ "$1" = "configure" ]; then\n'
        "    # The arm is a USB CDC device; the rule grants the desktop user access.\n"
        "    if command -v udevadm >/dev/null 2>&1; then\n"
        "        udevadm control --reload-rules || true\n"
        "        udevadm trigger --subsystem-match=tty || true\n"
        "    fi\n"
        "    # debhelper normally refreshes these through dpkg triggers. This package\n"
        "    # builds its control files itself, so ask for the refresh directly.\n"
        "    if command -v gtk-update-icon-cache >/dev/null 2>&1; then\n"
        "        gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true\n"
        "    fi\n"
        "    if command -v update-desktop-database >/dev/null 2>&1; then\n"
        "        update-desktop-database -q || true\n"
        "    fi\n"
        "fi\n"
        "\n"
        "exit 0\n"
    )


def postrm_script() -> str:
    return (
        "#!/bin/sh\n"
        "# Maintainer script. $1 is \"remove\" on removal and \"purge\" on purge.\n"
        "set -e\n"
        "\n"
        'if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then\n'
        "    # Dropping the rule only takes effect after a reload.\n"
        "    if command -v udevadm >/dev/null 2>&1; then\n"
        "        udevadm control --reload-rules || true\n"
        "        udevadm trigger --subsystem-match=tty || true\n"
        "    fi\n"
        "fi\n"
        "\n"
        "exit 0\n"
    )


#: (path inside the package, bytes or source file, mode)
Entry = Tuple[Path, Union[bytes, Path], int]


def payload(binary: Path) -> List[Entry]:
    """Everything the package installs, in a fixed order."""
    entries: List[Entry] = [
        *bundled_daemon(binary),
        # The packaged default gripper calibration the launcher points the daemon
        # at (LITEGRIP_FACTORY_CALIB).  It is the console's own committed default
        # — the same file the daemon ships inside its package — installed where
        # the path stays put across launches.
        (Path(f"usr/lib/{PACKAGE}/factory_calibration.json"),
         FACTORY_CALIBRATION, 0o644),
        (Path(f"usr/bin/{LAUNCHER}"), launcher_script().encode(), 0o755),
        (Path(f"usr/share/applications/{PACKAGE}.desktop"), desktop_entry().encode(), 0o644),
        (Path(f"usr/lib/udev/rules.d/60-{PACKAGE}.rules"), udev_rule().encode(), 0o644),
        (Path(f"usr/share/doc/{PACKAGE}/copyright"), copyright_text().encode(), 0o644),
    ]
    for png in sorted(ICON_DIR.glob("icon-*.png")):
        size = png.stem.partition("-")[2]
        entries.append(
            (Path(f"usr/share/icons/hicolor/{size}x{size}/apps/{LAUNCHER}.png"), png, 0o644)
        )
    return entries


def bundled_daemon(binary: Path) -> List[Entry]:
    """The daemon itself, wherever it lands under `/usr/lib`.

    `binary` is whatever `packaging/build.py` left behind, in either of the two shapes it
    can produce (see its `bundle_mode()`). They are told apart by looking at the path,
    because PyInstaller writes them under the same name:

    * `--onefile` — a single executable, which unpacks the whole bundle into a temporary
      directory on **every** launch. A file.
    * `--onedir` — an executable plus the `_internal/` tree beside it, with nothing
      unpacked at launch. A directory.

    The package is built from the directory shape because dpkg installs a tree anyway, so
    the shape costs the user nothing and buys back that unpacking. Measured on the
    reference machine: 272–359 ms off every start.

    Both shapes land at the same `/usr/lib/<pkg>/<name>`, so the launcher, the installed
    path and the documentation are identical whichever shape a release was built from.
    """
    install_root = Path(f"usr/lib/{PACKAGE}")
    if not binary.is_dir():
        return [(install_root / BINARY_NAME, binary, 0o755)]
    entries: List[Entry] = []
    for source in sorted(binary.rglob("*")):
        if not source.is_file():
            continue
        # Keep each file's own mode: PyInstaller already decided what is executable (the
        # entry point) and what is merely mapped (the shared libraries, the data files).
        entries.append(
            (install_root / source.relative_to(binary), source,
             source.stat().st_mode & 0o777)
        )
    return entries


def write_tree(root: Path, entries: Iterable[Entry]) -> int:
    """Write the payload under `root`, plus the control files. Returns Installed-Size in KiB.

    `Installed-Size` is what `du` would report for an installed package, so the sizes are
    read back from the written files rather than from the sources: hard links, sparse
    files and block rounding are all irrelevant here, and this keeps the number honest.
    """
    total = 0
    for relative, source, mode in entries:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(source, bytes):
            target.write_bytes(source)
        else:
            shutil.copyfile(source, target)
        target.chmod(mode)
        total += target.stat().st_size

    control_dir = root / "DEBIAN"
    control_dir.mkdir(parents=True, exist_ok=True)
    for name, text in (("postinst", postinst_script()), ("postrm", postrm_script())):
        path = control_dir / name
        path.write_text(text, encoding="utf-8")
        path.chmod(0o755)

    # md5sums is what `dpkg --verify` reads. debhelper generates it; this package has no
    # debhelper, so generate it here. Paths are relative to the filesystem root.
    lines = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or control_dir in path.parents:
            continue
        digest = hashlib.md5(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.relative_to(root).as_posix()}\n")
    (control_dir / "md5sums").write_text("".join(lines), encoding="utf-8")

    return math.ceil(total / 1024)


def stage(root: Path, binary: Path, *, version: str, arch: str,
          window_backend: str = "gtk") -> Tuple[Path, int]:
    """Build the package tree under `root`; return it and its Installed-Size in KiB."""
    shutil.rmtree(root, ignore_errors=True)
    installed_kb = write_tree(root, payload(binary))
    control = root / "DEBIAN" / "control"
    control.write_text(
        control_text(version=version, arch=arch, installed_size_kb=installed_kb,
                     window_backend=window_backend),
        encoding="utf-8",
    )
    control.chmod(0o644)
    return root, installed_kb


def resolve_version() -> str:
    """`LITEARM_STUDIO_VERSION` > `git describe --tags` > refusal.

    Same source of truth as build.py: the git tag. Unlike the executable's version this
    one is not optional — a Debian package without a version number is meaningless.
    """
    env = os.environ.get("LITEARM_STUDIO_VERSION", "").strip()
    if env:
        return env
    try:
        described = subprocess.check_output(
            ["git", "describe", "--tags", "--always"], cwd=ROOT, text=True,
            stderr=subprocess.DEVNULL).strip()
    except Exception:  # noqa: BLE001 - no git, no tags
        described = ""
    if not described:
        raise SystemExit(
            "[deb] cannot determine the version: pass --version, set "
            "LITEARM_STUDIO_VERSION, or run from a git checkout with tags")
    return described


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="packaging/deb.py",
        description="Build the Debian package from the packaged daemon.")
    parser.add_argument("--binary", default=str(DEFAULT_BINARY), metavar="PATH",
                        help="what `packaging/build.py` produced — a single file or a "
                             f"directory, it tells them apart (default: {DEFAULT_BINARY})")
    parser.add_argument("--version", default=None, metavar="VERSION",
                        help="version to package; a leading `v` is stripped "
                             "(default: LITEARM_STUDIO_VERSION, else git describe)")
    parser.add_argument("--arch", default="amd64", metavar="ARCH",
                        help="Debian architecture name (default: amd64)")
    parser.add_argument("--outdir", default=str(OUT_DIST), metavar="DIR",
                        help=f"where to write the .deb (default: {OUT_DIST})")
    parser.add_argument("--work", default=str(WORK), metavar="DIR",
                        help=f"scratch directory for the package tree (default: {WORK})")
    parser.add_argument("--window-backend", choices=("gtk", "qt"),
                        default=os.environ.get(WINDOW_BACKEND_ENV, "").strip() or "gtk",
                        help="which window backend the executable was built with; decides "
                             "whether the package depends on the system's WebKitGTK "
                             f"(default: {WINDOW_BACKEND_ENV}, else gtk)")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    binary = Path(args.binary)
    # Either shape is accepted (see `bundled_daemon`), so the check is "something is
    # there", not "it is a file" — a directory is the shape this package wants.
    if not binary.exists():
        raise SystemExit(
            f"[deb] nothing at {binary} — run `pnpm build` and "
            f"`python packaging/build.py` first")
    if shutil.which("dpkg-deb") is None:
        raise SystemExit("[deb] dpkg-deb not found: this step needs Debian or Ubuntu")

    version = deb_version(args.version or resolve_version())
    out_dir = Path(args.outdir)
    out_dir.mkdir(parents=True, exist_ok=True)
    root, installed_kb = stage(Path(args.work) / "root", binary, version=version,
                               arch=args.arch, window_backend=args.window_backend)

    target = out_dir / f"{PACKAGE}_{version}_{args.arch}.deb"
    print(f"[deb] staged {root} (Installed-Size {installed_kb} KiB)")
    print(f"[deb] window backend = {args.window_backend} "
          f"(Depends: {', '.join(depends_for(args.window_backend))})")
    subprocess.run(
        ["dpkg-deb", "--build", "--root-owner-group", str(root), str(target)],
        check=True, cwd=ROOT)
    print(f"[deb] artifact: {target} ({target.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
