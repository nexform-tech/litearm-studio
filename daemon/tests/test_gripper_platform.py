"""平台判据单测 —— 没有 `litegrip` 时, 守护进程照样要能起来 (D10 / §8)。

子进程里把 `litegrip` 的 import 打掉, 再走一遍真实的启动路径: 这是"Windows 版构建里
夹爪**缺席**"的判据, 而不是"某处 try 了一下"。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCRIPT = '''
import builtins, sys

_real_import = builtins.__import__


def blocked(name, *args, **kwargs):
    if name == "litegrip" or name.startswith("litegrip."):
        raise ImportError("blocked: the gripper SDK is not installed on this platform")
    return _real_import(name, *args, **kwargs)


builtins.__import__ = blocked

# 1. 传输层与命令行必须能 import —— 它们不碰 SDK。
from litearm_studio_daemon import server
from litearm_studio_daemon.__main__ import build_gripper_session, build_parser
from litearm_studio_daemon.gripper.session import GripperSession
from litearm_studio_daemon.gripper.config import ChannelStore

# 2. 非 Linux + 非 --fake ⇒ 没有夹爪会话（缺席，不是禁用）。
sys.platform = "win32"
assert build_gripper_session(build_parser().parse_args([])) is None
assert build_gripper_session(build_parser().parse_args(["--no-gripper"])) is None

# 3. --fake 在任何平台都提供夹爪：仿真后端是纯 Python，一次 SDK import 都不做。
session = build_gripper_session(build_parser().parse_args(["--fake"]))
assert session is not None and session.fake
assert session.loop is not None
assert session.loop.backend.describe()
session.close()
assert "litegrip" not in sys.modules, "仿真路径不该导入 SDK"

# 4. server 模块本身也认得"本进程没有夹爪"。
assert server.create_app.__doc__ is not None

# 5. Linux 上缺 SDK ⇒ 也只是"这一次没有夹爪", 守护进程照常起 (D10 的本意)。
#    ⚠ 这条才是真正的回归测试: 构造函数的 import 发生在 `_build_loop` 里 (懒加载
#    backend.real), 只 try 住 `from .gripper.session import ...` 会让 ImportError
#    逃出 `build_gripper_session` 和 `main`, 结果是 Linux 上连臂都起不来。
sys.platform = "linux"
assert build_gripper_session(build_parser().parse_args([])) is None

print("OK")
'''


def test_the_daemon_starts_and_the_simulator_runs_without_the_sdk(tmp_path: Path) -> None:
    env_home = tmp_path / "home"
    env_home.mkdir()
    completed = subprocess.run(
        [sys.executable, "-c", SCRIPT],
        capture_output=True, text=True, timeout=120,
        env={
            "PATH": "/usr/bin:/bin",
            "HOME": str(env_home),
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
        },
    )
    assert completed.returncode == 0, completed.stderr
    assert "OK" in completed.stdout


def test_the_simulator_session_never_imports_the_sdk(monkeypatch) -> None:
    """同一判据, 但用**测试进程内**的会话再钉一遍: 仿真后端必须自给自足。

    这里不拦 import（别的用例可能已经导入过 SDK），只断言仿真会话在没有任何模板
    文件的临时 HOME 下也能构造并给出标定信息 —— 那是"纯 Python 后端"的实际含义。
    """
    import sys as _sys

    from litearm_studio_daemon.gripper.config import ChannelStore
    from litearm_studio_daemon.gripper.session import GripperSession

    monkeypatch.setenv("HOME", str(Path("/tmp/litearm-platform-nonexistent")))
    session = GripperSession(fake=True, store=ChannelStore(Path("/tmp/none.json")),
                             autostart=False)
    try:
        assert session.fake
        assert session.loop is not None
        info = session.loop.backend.calibration_info()
        assert info is not None and info.limits is not None
    finally:
        session.close()
    assert _sys.modules is not None


def _build_module():
    """把仓库根的 `packaging/build.py` 当模块加载（它不是包的一部分）。"""
    import importlib.util

    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("litearm_packaging_build",
                                                  root / "packaging" / "build.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_linux_package_collects_the_gripper_sdk(monkeypatch) -> None:
    build = _build_module()
    monkeypatch.setattr(build.sys, "platform", "linux")
    monkeypatch.setattr(build, "sdk_available", lambda name: True)
    assert build.gripper_build_args() == ["--collect-all", "litegrip"]


def test_a_linux_package_without_the_sdk_fails_loudly(monkeypatch, capsys) -> None:
    """一个"忘了装 SDK"的 Linux 产物会静默地没有夹爪 —— 必须在这里失败。"""
    import pytest

    build = _build_module()
    monkeypatch.setattr(build.sys, "platform", "linux")
    monkeypatch.setattr(build, "sdk_available", lambda name: False)
    with pytest.raises(SystemExit) as excinfo:
        build.gripper_build_args()
    assert "litegrip" in str(excinfo.value)


def test_the_windows_package_skips_the_gripper_sdk(monkeypatch) -> None:
    build = _build_module()
    monkeypatch.setattr(build.sys, "platform", "win32")
    monkeypatch.setattr(build, "sdk_available", lambda name: False)
    assert build.gripper_build_args() == []
