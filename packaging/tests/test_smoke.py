"""`packaging/smoke.py` 的纯逻辑：日志判定、容器脚本与 docker 调用参数。

真正启动容器的部分不在单测里 —— 它需要 Docker 和两个 Ubuntu 镜像，那是发布任务
（`.github/workflows/release.yml` 的 package job）的事。这里钉住的是"什么样算通过"：
少一条成功标记、多一条失败标记，或调用 docker 时少了关键开关，都必须判失败。
"""
from __future__ import annotations

import argparse
import importlib.util
import pathlib
from types import SimpleNamespace

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _load_smoke():
    """按路径加载 `packaging/smoke.py` —— 它不在 `sys.path` 上，也不该为测试改成包。"""
    spec = importlib.util.spec_from_file_location(
        "litearm_smoke", ROOT / "packaging" / "smoke.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HEALTHY_LOG = """
2026-11-13 06:05:53,279 INFO    litearm_studio_daemon.window: 应用窗口已打开: http://127.0.0.1:8765/
INFO:     127.0.0.1:50216 - "WebSocket /ws" [accepted]
INFO:     connection open
2026-11-13 06:05:53,618 INFO    litearm_studio_daemon.session: 已连接: port=fake
"""


def test_the_two_target_releases_are_pinned() -> None:
    """这两个 LTS 是发布产物必须启动的系统；漏掉一个，那一类回归就没有门。"""
    smoke = _load_smoke()

    assert set(smoke.RELEASES) == {"24.04", "26.04"}


def test_a_healthy_log_passes() -> None:
    smoke = _load_smoke()

    assert smoke.check_log(HEALTHY_LOG) == []


def test_a_window_failure_is_rejected() -> None:
    """v0.25.0 在 26.04 上的形状：窗口没打开，并带着旧 libstdc++ 的符号错误。"""
    smoke = _load_smoke()
    log = """
[litearm-studio-daemon] 无法打开应用窗口: 没有可用的 webview 后端。
Failed to load shared library 'libwebkit2gtk-4.1.so.0' referenced by the typelib:
/usr/lib/litearm-studio/_internal/libstdc++.so.6: version `CXXABI_1.3.15' not found
"""

    problems = smoke.check_log(log)

    assert any("open window" in problem for problem in problems)
    assert any("CXXABI_" in problem for problem in problems)
    assert any("Failed to load shared library" in problem for problem in problems)


def test_a_missing_websocket_is_rejected() -> None:
    """窗口开出来但界面没连上，操作员看到的仍然是一个空窗口。"""
    smoke = _load_smoke()

    problems = smoke.check_log("应用窗口已打开\n")

    assert problems == ["the UI never connected over the WebSocket"]


def test_the_container_script_installs_the_package_and_uses_the_fake_arm() -> None:
    smoke = _load_smoke()

    script = smoke.container_script("0.25.1", timeout=15)

    for expected in (
        "/tmp/litearm-studio.deb",
        "xvfb",
        "dbus-run-session",
        "litearm-studio --fake --no-gripper",
        "timeout 15 ",
        '"$installed" != "0.25.1"',
        str(smoke.STILL_RUNNING),
    ):
        assert expected in script, f"容器脚本里少了 {expected!r}"


def test_an_optional_apt_mirror_replaces_the_official_sources() -> None:
    """本地跑时官方 archive 慢，可以换源；CI 不传，继续用镜像自带源。"""
    smoke = _load_smoke()

    default = smoke.container_script("0.25.1", timeout=15)
    mirrored = smoke.container_script(
        "0.25.1", timeout=15, apt_mirror="http://mirrors.aliyun.com/ubuntu/")

    assert "sed -i" not in default
    assert "mirrors.aliyun.com/ubuntu/" in mirrored
    assert "http://archive.ubuntu.com/ubuntu/" in mirrored
    assert "http://security.ubuntu.com/ubuntu/" in mirrored


def test_an_apt_mirror_must_be_a_plain_http_url() -> None:
    """这个值会进容器里的 sed 表达式，不能让它带 shell 元字符。"""
    smoke = _load_smoke()

    assert smoke.apt_mirror_arg("http://mirrors.aliyun.com/ubuntu") \
        == "http://mirrors.aliyun.com/ubuntu/"
    for bad in ("mirrors.aliyun.com/ubuntu/", "http://x/|touch /tmp/pwned", ""):
        with pytest.raises(argparse.ArgumentTypeError):
            smoke.apt_mirror_arg(bad)


def test_run_release_uses_docker_with_the_target_image(monkeypatch, capsys) -> None:
    """宿主机这一侧：镜像、卷、特权、以及把容器的 .deb 以只读方式挂进去。"""
    smoke = _load_smoke()
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout=HEALTHY_LOG, stderr="")

    monkeypatch.setattr(smoke.subprocess, "run", fake_run)
    package = pathlib.Path("/tmp/litearm-studio_0.25.1_amd64.deb")

    smoke.run_release("26.04", package, "0.25.1", timeout=30)

    command, kwargs = calls[0]
    assert command[0:2] == ["docker", "run"]
    assert "--privileged" in command
    assert "ubuntu:26.04" in command
    assert f"{package}:/tmp/litearm-studio.deb:ro" in command
    assert kwargs["timeout"] == 30 + smoke.SETUP_TIMEOUT
    assert "window opened and the UI connected" in capsys.readouterr().out


def test_run_release_fails_when_the_log_is_not_healthy(monkeypatch, capsys) -> None:
    smoke = _load_smoke()

    monkeypatch.setattr(
        smoke.subprocess, "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout="", stderr=""))

    with pytest.raises(SystemExit) as error:
        smoke.run_release("24.04", pathlib.Path("/tmp/pkg.deb"), "0.25.1", timeout=30)

    assert "never reported an open window" in str(error.value)
    assert "never connected over the WebSocket" in str(error.value)
    capsys.readouterr()


def test_a_missing_package_is_refused(tmp_path) -> None:
    smoke = _load_smoke()

    with pytest.raises(SystemExit) as error:
        smoke.main([str(tmp_path / "missing.deb")])

    assert "no package at" in str(error.value)
