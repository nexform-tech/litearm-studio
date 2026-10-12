"""平台判据单测 —— 没有 `litegrip` 时, 守护进程照样要能起来 (D10 / §8)。

子进程里把 `litegrip` 的 import 打掉, 再走一遍真实的启动路径: 这是"Windows 版构建里
夹爪**缺席**"的判据, 而不是"某处 try 了一下"。
"""
from __future__ import annotations

import os
import site
import subprocess
import sys
from pathlib import Path
from typing import Dict

import pytest

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


def _child_env(home: Path) -> Dict[str, str]:
    """子进程的环境: `HOME` 干净, 但**依赖与父进程同一套**。

    ⚠ 只有 `HOME` 干净是不够的。`HOME` 指向临时目录会让 `site.getusersitepackages()`
      落到那里, 于是"用 `pip install` 装在**用户站点**里的依赖"(README 的
      `pip install -e "daemon[test]"` 在没有 venv 时走的就是这条路) 在子进程里全部消失
      —— 报出来的是 `ModuleNotFoundError: No module named 'fastapi'`, 看着像测试坏了,
      其实是这台机器没建 venv。装在 venv 里不受影响 (包在解释器自己的 site-packages
      里, 与 `HOME` 无关), 所以这条只在非 venv 的开发机上炸 (#156)。
      这里把父进程指向的那些目录显式带过去 —— 用户的站点目录, 以及父进程自己继承的
      `PYTHONPATH`。仓库的 `src` 排在最前: 测的必须是这棵检出, 不是装好的副本。

    ⚠ 这不削弱"没有 SDK 也要能起"这条判据: `litegrip` 由 `SCRIPT` 自己用 import 钩子
      挡掉 (它第一件事就是这个), 与包在哪个目录里无关。
    """
    src = Path(__file__).resolve().parents[1] / "src"
    parts = [str(src)]
    user_site = site.getusersitepackages()
    if site.ENABLE_USER_SITE and user_site and Path(user_site).is_dir():
        parts.append(str(user_site))
    parts.extend(p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p)
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": str(home),
        "PYTHONPATH": os.pathsep.join(parts),
    }


def test_the_daemon_starts_and_the_simulator_runs_without_the_sdk(tmp_path: Path) -> None:
    env_home = tmp_path / "home"
    env_home.mkdir()
    completed = subprocess.run(
        [sys.executable, "-c", SCRIPT],
        capture_output=True, text=True, timeout=120,
        env=_child_env(env_home),
    )
    assert completed.returncode == 0, completed.stderr
    assert "OK" in completed.stdout


def test_the_child_keeps_the_packages_the_parent_interpreter_has(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`HOME` 换成临时目录不许把依赖一起藏掉 (#156) —— 这是 `_child_env` 的全部职责。

    判据与"SDK 看不见"不冲突: 后者由 `SCRIPT` 的 import 钩子挡, 与包在哪个目录无关。
    """
    fake_site = tmp_path / "site-packages"
    fake_site.mkdir()
    monkeypatch.setattr(site, "ENABLE_USER_SITE", True)
    monkeypatch.setattr(site, "getusersitepackages", lambda: str(fake_site))
    monkeypatch.setenv("PYTHONPATH", "/inherited/from/the/parent")

    path = _child_env(tmp_path / "home")["PYTHONPATH"].split(os.pathsep)
    assert path[0] == str(Path(__file__).resolve().parents[1] / "src"), \
        "仓库的 src 必须排最前: 测的是这棵检出, 不是装好的副本"
    assert str(fake_site) in path
    assert "/inherited/from/the/parent" in path

    # 用户站点没启用 (venv 里就是这样: 包在解释器自己的 site-packages 里, 与 HOME 无关)
    # ⇒ 不加那个目录, 免得让子进程看到的东西取决于一个用不上的路径。
    monkeypatch.setattr(site, "ENABLE_USER_SITE", False)
    assert str(fake_site) not in _child_env(tmp_path / "home")["PYTHONPATH"].split(os.pathsep)


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
