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


def _installed(monkeypatch, *names: str) -> None:
    """Pretend exactly `names` are importable, whatever is really on this machine."""
    monkeypatch.setattr(build, "sdk_available", lambda name: name in names)


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


def test_window_build_args_prefers_qt_when_both_bindings_are_present(monkeypatch):
    """装了两个绑定时不要混着收 —— 那会把两个 ~200MB 的 Qt 一起塞进产物。"""
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
    assert "daemon[ui]" in str(excinfo.value)


def test_window_build_args_refuses_a_webview_without_any_binding(monkeypatch):
    """装了 pywebview、却没装任何 Qt 绑定 ⇒ 冻结后的窗口在选后端时才会失败, 太晚。"""
    _installed(monkeypatch, "webview", "qtpy")
    with pytest.raises(SystemExit) as excinfo:
        build.window_build_args()
    assert "daemon[ui]" in str(excinfo.value)


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
