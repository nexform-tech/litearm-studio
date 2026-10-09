"""Tests for `packaging/build.py`, the builder of the one-file executable.

The module is loaded by path instead of imported for the same reason as `test_deb.py`:
its directory is called `packaging`, which would shadow the PyPI package of that name.

Only the argument builders are covered here. `main()` shells out to PyInstaller, which
belongs to the release job, not to a unit test.
"""
from __future__ import annotations

import importlib.util
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUILD_PY = ROOT / "packaging" / "build.py"


def _load_build_module():
    spec = importlib.util.spec_from_file_location("litearm_studio_build", BUILD_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = _load_build_module()


def _installed(monkeypatch, *names: str, gtk: bool = False, backend=None) -> None:
    """Pretend exactly `names` are importable, whatever is really on this machine.

    `gtk_available()` is stubbed too: otherwise the backend these tests get depends on
    whether the machine running the suite happens to have PyGObject, and the suite would
    take a different path on a developer box than in CI.
    """
    monkeypatch.setattr(build, "sdk_available", lambda name: name in names)
    monkeypatch.setattr(build, "gtk_available", lambda: gtk)
    if backend is None:
        monkeypatch.delenv(build.WINDOW_BACKEND_ENV, raising=False)
    else:
        monkeypatch.setenv(build.WINDOW_BACKEND_ENV, backend)


def test_window_build_args_collects_the_qt_backend(monkeypatch):
    """The window must survive freezing, or the product's "closing it quits" is gone.

    `qtpy` picks its binding at runtime and pywebview imports the Qt modules from inside
    a `try`, so neither is visible to static analysis. Both have to be named explicitly —
    a frozen build that silently lacks them opens no window at all.
    """
    _installed(monkeypatch, "webview", "qtpy", "PyQt6")
    args = build.window_build_args()

    assert "--collect-all" in args and "webview" in args
    assert "qtpy" in args
    # pywebview 的 Qt 后端经 qtpy 间接 import 这几个, 静态分析跟不到。
    for module in ("PyQt6.QtWebEngineWidgets", "PyQt6.QtWebEngineCore", "PyQt6.QtWidgets"):
        assert module in args


def test_window_build_args_uses_the_system_gtk_when_it_is_there(monkeypatch):
    """有 GTK 就走 GTK —— 这条决定包是 ~63 MB 还是 ~243 MB。

    借系统的 WebKitGTK 意味着产物里**不能**再塞一个 Qt；GTK 那条链由 PyInstaller 的
    `hook-gi.repository.*` 收，WebKit2 没有钩子，它的库与 typelib 由 `.deb` 的
    `Depends` 提供。
    """
    _installed(monkeypatch, "webview", "qtpy", "PyQt6", gtk=True)
    args = build.window_build_args()

    assert "gi" in args
    assert "gi.repository.WebKit2" in args
    assert not any("PyQt6" in arg for arg in args), "两个后端都收会把包撑回 Qt 的体积"


def test_windows_and_macos_use_the_kernel_the_os_already_has(monkeypatch):
    """那两个平台没有 GTK/Qt 的取舍 —— WebView2 / WKWebView 是系统自带的。

    ⚠ 这条同时钉住一个回归：把后端判据写成"只有 gtk 和 qt 两种"会让 Windows 构建
    **直接失败**（那里两个都没有），而它本来什么都不用装。
    """
    monkeypatch.setattr(build.sys, "platform", "win32")
    _installed(monkeypatch, "webview", "pythonnet", "clr_loader")

    args = build.window_build_args()

    assert "webview" in args
    assert "pythonnet" in args  # 它是动态加载的, 静态分析看不见
    assert not any("PyQt6" in arg for arg in args)


def test_the_backend_can_be_forced_by_environment(monkeypatch):
    """`LITEARM_STUDIO_WINDOW_BACKEND` 能盖过自动判据 —— 发布流水线要用它把产物钉死。"""
    _installed(monkeypatch, "webview", "qtpy", "PyQt6", gtk=True, backend="qt")
    assert any("PyQt6" in arg for arg in build.window_build_args())

    _installed(monkeypatch, "webview", "qtpy", "PyQt6", gtk=True, backend="gtk")
    assert any("gi.repository.WebKit2" in arg for arg in build.window_build_args())


def test_a_bogus_backend_name_is_refused(monkeypatch):
    """写错的开关要**报错**, 不能静默按默认值走 —— 那会发出一份不是你要的产物。"""
    _installed(monkeypatch, "webview", gtk=True, backend="gtk4")
    with pytest.raises(SystemExit) as excinfo:
        build.window_build_args()
    assert build.WINDOW_BACKEND_ENV in str(excinfo.value)


def test_forcing_gtk_without_gtk_installed_fails_the_build(monkeypatch):
    """强制 GTK 但这台机器上没装 ⇒ 判失败, 而不是打出一个开不了窗口的产物。"""
    _installed(monkeypatch, "webview", backend="gtk", gtk=False)
    with pytest.raises(SystemExit) as excinfo:
        build.window_build_args()
    assert "python3-gi" in str(excinfo.value)


def test_window_build_args_prefers_qt_when_both_bindings_are_present(monkeypatch):
    """装了两个 Qt 绑定时不要混着收 —— 那会把两个 ~200MB 的 Qt 一起塞进产物。"""
    _installed(monkeypatch, "webview", "qtpy", "PyQt6", "PySide6")
    args = build.window_build_args()

    assert any("PyQt6" in arg for arg in args)
    assert not any("PySide6" in arg for arg in args)


def test_window_build_args_refuses_to_package_a_windowless_build(monkeypatch):
    """缺 pywebview 时**判失败**, 而不是打出一个开不了窗口的产物。

    一个能启动、能连机械臂、一开窗就退出码 3 的 `.deb` 比一次构建失败难查得多
    (与 litegrip / pyusb 那两条同一条口径)。
    """
    _installed(monkeypatch, "litearm", "serial")
    with pytest.raises(SystemExit) as excinfo:
        build.window_build_args()
    assert "daemon[ui" in str(excinfo.value)


def test_window_build_args_refuses_a_webview_without_any_binding(monkeypatch):
    """装了 pywebview、却没装任何 Qt 绑定 ⇒ 冻结后的窗口在选后端时才会失败, 太晚。"""
    _installed(monkeypatch, "webview", "qtpy")
    with pytest.raises(SystemExit) as excinfo:
        build.window_build_args()
    assert "daemon[ui" in str(excinfo.value)


def test_window_build_args_refuses_a_qt_binding_without_qtpy(monkeypatch):
    """`QtPy` 是独立包, pywebview 的基础依赖里**没有**它。

    所以"装了 PyQt6"不等于 Qt 后端能起来 —— pywebview 的 `platforms/qt.py` 第一行就是
    `from qtpy import ...`。实测踩过一次: 产物构建成功, 一启动就报"没有可用的 webview
    后端"。这条把它钉在构建期。
    """
    _installed(monkeypatch, "webview", "PyQt6")
    with pytest.raises(SystemExit) as excinfo:
        build.window_build_args()
    assert "qtpy" in str(excinfo.value)
