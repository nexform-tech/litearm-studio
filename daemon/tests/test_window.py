"""应用窗口与"关窗即退出"的生命周期单测。

这个文件钉住的是**整个改造的两个验收点**:

1. 关掉窗口 ⇒ 服务停 + 会话收尾 (失能 + 释放串口)。§"关窗即退出" 一节用真 uvicorn 起在
   真端口上跑完整条路径, 只把 GUI 换成假件 —— CI 没有显示器, 也不装 GUI 依赖。
2. 窗口认祖归宗 ⇒ WM_CLASS / desktopFileName / 桌面条目的 `StartupWMClass` 三处同一个值。
   §"窗口身份" 一节钉住前两处, `packaging/tests/test_deb.py` 钉住第三处。

⚠ GUI 依赖是**软依赖**: 装不了 PyGObject/Qt 的机器照样要能 import 这个包并跑无界面模式。
§"软依赖" 一节用一个干净的子进程验证这一点 (import 会污染本进程, 不能在这里量)。
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import types
import urllib.error
import urllib.request

import pytest

from litearm_studio_daemon import window
from litearm_studio_daemon.server import create_app, serve
from litearm_studio_daemon.session import Session


# ------------------------------------------------------------------ 假件

class _FakeWindow:
    """pywebview 的 `Window`: 只记下被调了哪些方法。"""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def restore(self) -> None:
        self.calls.append("restore")

    def show(self) -> None:
        self.calls.append("show")


class _FakeWebview:
    """足够真的 pywebview —— `run_window` 只用这两个入口。"""

    def __init__(self) -> None:
        self.created: dict = {}
        self.started: dict = {}
        self.window = _FakeWindow()

    def create_window(self, title, **kwargs):
        self.created = {"title": title, **kwargs}
        return self.window

    def start(self, **kwargs):
        self.started = kwargs


class _Handle:
    """调用方拿到的窗口把手 —— 这里只关心它被调用了几次。"""

    def __init__(self) -> None:
        self.raised = 0

    def raise_window(self) -> None:
        self.raised += 1


# ------------------------------------------------------------------ 软依赖

def test_importing_the_daemon_does_not_pull_in_pywebview() -> None:
    """装不了 GUI 栈的机器必须还能 import 这个包 (CI 与台架就是这种机器)。

    在干净子进程里量: 本进程早就 import 过别的模块, 在进程内看 `sys.modules` 说不清。
    """
    code = (
        "import sys\n"
        "import litearm_studio_daemon.server\n"
        "import litearm_studio_daemon.__main__\n"
        "raise SystemExit(1 if 'webview' in sys.modules else 0)\n"
    )
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_a_missing_backend_says_what_to_install(monkeypatch) -> None:
    """没有后端要说清楚装什么 —— 不是静默退回无界面。

    `sys.modules[...] = None` 是让 `import webview` 抛 ImportError 的标准做法。
    """
    monkeypatch.setitem(sys.modules, "webview", None)
    with pytest.raises(window.WindowUnavailable) as excinfo:
        window.run_window("http://127.0.0.1:1/", on_ready=lambda handle: None)
    message = str(excinfo.value)
    assert "litearm-studio-daemon[ui]" in message
    assert "--no-open" in message


# ------------------------------------------------------------------ 打开窗口

def test_run_window_points_at_the_daemon_and_hands_back_a_handle(monkeypatch,
                                                                 tmp_path) -> None:
    """窗口要指向**我们自己的**地址, 图标要用我们的 PNG, 并且交回一个把手。"""
    fake = _FakeWebview()
    icon = tmp_path / "logo.png"
    icon.write_bytes(b"\x89PNG\r\n\x1a\n")
    monkeypatch.setitem(sys.modules, "webview", fake)
    monkeypatch.setenv("LITEARM_STUDIO_ICON", str(icon))

    handles: list = []
    window.run_window("http://127.0.0.1:8765/", on_ready=handles.append)

    assert fake.created["title"] == window.APP_NAME
    assert fake.created["url"] == "http://127.0.0.1:8765/"
    assert tuple(fake.created["min_size"]) == window.WINDOW_MIN_SIZE
    # ⚠ `icon` 是 start() 的参数而不是 create_window() 的。
    assert fake.started["icon"] == str(icon)
    assert len(handles) == 1
    handles[0].raise_window()
    assert fake.window.calls == ["restore", "show"]


def test_icon_file_prefers_an_explicit_override(monkeypatch, tmp_path) -> None:
    icon = tmp_path / "logo.png"
    icon.write_bytes(b"x")
    monkeypatch.setenv("LITEARM_STUDIO_ICON", str(icon))
    assert window.icon_file() == str(icon)


def test_icon_file_falls_back_to_the_repo_asset(monkeypatch) -> None:
    """源码直跑时图标就在检出里 —— 别为了找它写下绝对路径。"""
    monkeypatch.delenv("LITEARM_STUDIO_ICON", raising=False)
    found = window.icon_file()
    assert found is not None
    assert found.endswith("assets/icon-png/icon-256.png")


# ------------------------------------------------------------------ 窗口身份

def _install(monkeypatch, name: str, module: types.ModuleType) -> None:
    monkeypatch.setitem(sys.modules, name, module)


def test_window_identity_is_set_on_both_backends(monkeypatch) -> None:
    """GTK 与 Qt 各有一套"我叫什么", 两套都要设成同一个值。

    不设的后果不是报错: 桌面找不到 `litearm-studio.desktop`, 窗口就借用了通用图标 ——
    "能用但就是不对"的那种缺陷, 所以两个后端都钉住。
    """
    seen: dict = {}

    glib = types.SimpleNamespace(
        set_prgname=lambda name: seen.__setitem__("prgname", name),
        set_application_name=lambda name: seen.__setitem__("application_name", name),
    )
    repository = types.ModuleType("gi.repository")
    repository.GLib = glib
    gi = types.ModuleType("gi")
    gi.repository = repository
    _install(monkeypatch, "gi", gi)
    _install(monkeypatch, "gi.repository", repository)

    core = types.SimpleNamespace(
        QCoreApplication=types.SimpleNamespace(
            setApplicationName=lambda name: seen.__setitem__("application_name_qt", name)))
    gui = types.SimpleNamespace(
        QGuiApplication=types.SimpleNamespace(
            setDesktopFileName=lambda name: seen.__setitem__("desktop_file_name", name)))
    qt_core = types.ModuleType("qtpy.QtCore")
    qt_core.QCoreApplication = core.QCoreApplication
    qt_gui = types.ModuleType("qtpy.QtGui")
    qt_gui.QGuiApplication = gui.QGuiApplication
    qtpy = types.ModuleType("qtpy")
    _install(monkeypatch, "qtpy", qtpy)
    _install(monkeypatch, "qtpy.QtCore", qt_core)
    _install(monkeypatch, "qtpy.QtGui", qt_gui)

    window._set_desktop_identity()

    assert seen["prgname"] == window.WINDOW_CLASS
    assert seen["application_name"] == window.APP_NAME
    assert seen["application_name_qt"] == window.WINDOW_CLASS
    assert seen["desktop_file_name"] == window.WINDOW_CLASS


def test_window_identity_never_raises_without_a_backend(monkeypatch) -> None:
    """一个后端都没有是正常情况 (无界面运行的机器), 不该炸。"""
    for name in ("gi", "gi.repository", "qtpy", "qtpy.QtCore", "qtpy.QtGui",
                 "PyQt6", "PyQt6.QtCore", "PyQt6.QtGui"):
        monkeypatch.setitem(sys.modules, name, None)
    window._set_desktop_identity()


# ------------------------------------------------------------------ 关窗即退出

def _unconnected_session(monkeypatch) -> tuple[Session, list]:
    """未连接的会话 + 一个记录 `close()` 是否被调用的探针。

    探针**同时真的调用** `close()`: 收尾失败不该被测试掩盖掉。
    """
    session = Session(port_finder=lambda: None)
    closed: list = []
    real_close = session.close
    monkeypatch.setattr(session, "close",
                        lambda: (closed.append(True), real_close()))
    return session, closed


def test_closing_the_window_stops_the_server_and_tears_the_session_down(
        monkeypatch) -> None:
    """本文件的核心断言。

    真 uvicorn 起在真端口上; 假件只负责"窗口开着的时候服务在答话, 然后关掉"。
    """
    session, closed = _unconnected_session(monkeypatch)
    seen: dict = {}
    handle = _Handle()

    def fake_window(url: str, *, on_ready) -> None:
        # ---- 窗口"开着" ----
        with urllib.request.urlopen(url + "api/health", timeout=5) as resp:
            seen["health"] = json.loads(resp.read())
        seen["url"] = url
        on_ready(handle)
        request = urllib.request.Request(url + "api/focus", method="POST", data=b"")
        with urllib.request.urlopen(request, timeout=5) as resp:
            seen["focus"] = json.loads(resp.read())
        # ---- 操作员关掉了窗口: 函数返回 ----

    asyncio.run(serve(session, http_port=0, ui_dir="/nonexistent-ui",
                      window_runner=fake_window))

    assert seen["health"]["ok"] is True
    assert seen["url"].startswith("http://127.0.0.1:")
    # 第二次启动的落点: 窗口确实被抬起来了 (`/api/focus` 走通了整条链)。
    assert seen["focus"] == {"ok": True, "focused": True}
    assert handle.raised == 1
    # 收尾: 失能 + 释放串口。
    assert closed == [True]

    # 服务真的停了 —— 端口不再有人监听。
    port = seen["url"].split(":")[2].rstrip("/")
    with pytest.raises(OSError):
        urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1)


def test_a_window_that_cannot_open_still_releases_the_hardware(monkeypatch) -> None:
    """后端起不来时, 收尾**照样**要发生。

    否则就是最坏的一种失败: 操作员看到一句错误, 而串口还被这个进程握着 —— 与改造前
    "关掉窗口进程还在跑"是同一个后果。
    """
    session, closed = _unconnected_session(monkeypatch)

    def boom(url: str, *, on_ready) -> None:
        raise window.WindowUnavailable("没有可用的 webview 后端")

    with pytest.raises(window.WindowUnavailable):
        asyncio.run(serve(session, http_port=0, ui_dir="/nonexistent-ui",
                          window_runner=boom))
    assert closed == [True]


def test_focus_reports_false_when_there_is_no_window() -> None:
    """无界面运行时 `/api/focus` 如实说没有窗口可抬, 而不是假装成功。"""
    from fastapi.testclient import TestClient

    session = Session(port_finder=lambda: None)
    app = create_app(session, version="9.9.9-test", repo_dist=None,
                     focus=None)
    response = TestClient(app).post("/api/focus")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "focused": False}


def test_focus_raises_the_window_when_there_is_one() -> None:
    from fastapi.testclient import TestClient

    session = Session(port_finder=lambda: None)
    handle = _Handle()
    app = create_app(session, version="9.9.9-test", repo_dist=None,
                     focus=lambda: (handle.raise_window(), True)[1])
    response = TestClient(app).post("/api/focus")
    assert response.json() == {"ok": True, "focused": True}
    assert handle.raised == 1
