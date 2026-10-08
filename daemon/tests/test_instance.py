"""复用判据的用例 —— `instance.probe` / `is_same_instance` / `find_running`。

⚠ 这里钉的是**判据与那一次真实的 HTTP 往返**; "启动路径有没有因此少起一个进程"由
`test_server.py` 的 `main()` 用例钉住 (那里替换掉探测, 断言没走到 `serve`)。
"""
from __future__ import annotations

import http.server
import threading
import time
from pathlib import Path

import pytest
import uvicorn

from litearm_studio_daemon import __version__, create_app
from litearm_studio_daemon.instance import find_running, focus, is_same_instance, probe
from litearm_studio_daemon.server import HTTP_PORT_TRIES, pick_free_http_port
from litearm_studio_daemon.session import Session


class _FakeService(http.server.BaseHTTPRequestHandler):
    """一个"恰好也在 8765 上"的服务 —— 用来钉探测不会把别人的应答当成我们的。"""

    payload = b'{"hello":"world"}'

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 的接口名
        body = type(self).payload
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # noqa: D102 - 测试里不需要访问日志
        return


@pytest.fixture
def fake_service():
    srv = http.server.HTTPServer(("127.0.0.1", 0), _FakeService)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()


# ------------------------------------------------------------------ 判据

def test_is_same_instance_needs_ok_the_same_version_and_a_real_session() -> None:
    health = {"ok": True, "daemon": "1.2.3", "fake": False}
    assert is_same_instance(health, version="1.2.3") is True
    # 版本不同 ⇒ 另一个构建。装了新版而旧进程还活着: 复用会把旧界面端给操作员。
    assert is_same_instance(health, version="1.2.4") is False
    # 在一条 `--fake` 的调试进程旁边启动真机版 ⇒ 不复用。
    assert is_same_instance({**health, "fake": True}, version="1.2.3") is False
    assert is_same_instance(health, version="1.2.3", fake=True) is False
    # `ok` 不是 True ⇒ 别的服务回了个形状相近的 JSON。
    assert is_same_instance({**health, "ok": False}, version="1.2.3") is False
    # 没有 `daemon` 字段 ⇒ 更谈不上同一个构建。
    assert is_same_instance({"ok": True}, version="1.2.3") is False
    # 老构建的守护进程没有 `fake` 字段: 按真机算 (见 instance 模块文档的说明)。
    assert is_same_instance({"ok": True, "daemon": "1.2.3"}, version="1.2.3") is True


def test_find_running_walks_past_other_services_and_other_builds() -> None:
    """`start` 被别的服务占着时, 上一个实例就挪到了后面 —— 探测必须走得到那里。"""
    seen: list[int] = []

    def probe_fn(host: str, port: int, timeout: float):
        seen.append(port)
        if port == 8765:
            return {"ok": True, "daemon": "1.2.3", "fake": True}   # 假会话, 不是我们要的
        if port == 8766:
            return {"hello": "world"}                              # 别人的服务
        if port == 8767:
            return {"ok": True, "daemon": "1.2.3", "fake": False}
        return None

    url = find_running("127.0.0.1", 8765, 10, version="1.2.3", probe_fn=probe_fn)
    assert url == "http://127.0.0.1:8767/"
    assert seen == [8765, 8766, 8767]


def test_find_running_ignores_a_daemon_of_another_version() -> None:
    def probe_fn(host: str, port: int, timeout: float):
        return {"ok": True, "daemon": "9.9.9", "fake": False} if port == 8765 else None

    assert find_running("127.0.0.1", 8765, 5, version="1.2.3", probe_fn=probe_fn) is None


def test_find_running_scans_the_same_range_as_the_port_picker() -> None:
    """⚠ 范围与 `pick_free_http_port` 同源 (`HTTP_PORT_TRIES`): 差一个就会漏掉那个实例,
    于是又回到"两个守护进程"这个原始缺陷。"""
    last = 8765 + HTTP_PORT_TRIES - 1

    def probe_fn(host: str, port: int, timeout: float):
        return {"ok": True, "daemon": "1.2.3", "fake": False} if port == last else None

    assert find_running("127.0.0.1", 8765, HTTP_PORT_TRIES, version="1.2.3",
                        probe_fn=probe_fn) == f"http://127.0.0.1:{last}/"


# ------------------------------------------------------------------ 探测本身

def test_probe_returns_none_when_nothing_is_listening() -> None:
    """没人监听 ⇒ 环回上立刻 ECONNREFUSED, 不是超时, 也不抛。"""
    port = pick_free_http_port("127.0.0.1", start=19700, tries=50)
    assert probe("127.0.0.1", port, timeout=0.3) is None


def test_probe_returns_none_for_a_service_that_is_not_ours(fake_service) -> None:
    """200 + JSON, 但形状不对 ⇒ 当成"这个端口上没有我们的守护进程", 不是崩掉。"""
    _FakeService.payload = b'{"hello":"world"}'
    port = fake_service.server_address[1]
    assert probe("127.0.0.1", port, timeout=0.5) == {"hello": "world"}
    assert find_running("127.0.0.1", port, 1, version=__version__,
                        probe_fn=probe) is None


def test_probe_returns_none_when_the_body_is_not_json(fake_service) -> None:
    _FakeService.payload = b"<html>not json</html>"
    assert probe("127.0.0.1", fake_service.server_address[1], timeout=0.5) is None


def test_probe_finds_a_real_daemon_over_a_real_socket() -> None:
    """真起一个 uvicorn (真的 `create_app`), 走真的 socket 探到它。

    ⚠ 这一条同时钉住 `/api/health` 的**形状**: `daemon` 与 `fake` 缺任何一个, 复用判据就
    不成立 —— 手写的假服务器替不了这个断言。
    """
    port = pick_free_http_port("127.0.0.1", start=19800, tries=50)
    session = Session(fake=True, reconnect=False,
                      poll_period=0.05, state_push_interval=0.05)
    app = create_app(session, version=__version__, repo_dist=Path("/nonexistent-ui"))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                           log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10.0
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.02)
        assert server.started, "uvicorn 没起来"

        # 真机版启动**不该**复用一个 `--fake` 的实例。
        assert find_running("127.0.0.1", port, 1, version=__version__, fake=False) is None
        # 同一种会话、同一个构建 ⇒ 复用, 而且 URL 指回那个端口。
        assert find_running("127.0.0.1", port, 1, version=__version__,
                            fake=True) == f"http://127.0.0.1:{port}/"
        # 版本不同 ⇒ 不复用。
        assert find_running("127.0.0.1", port, 1, version="0.0.0+other",
                            fake=True) is None
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        session.close()


# ------------------------------------------------------------------ 抬起窗口

class _FakeFocusService(http.server.BaseHTTPRequestHandler):
    """一个只有 `/api/focus` 的服务 —— 钉住请求的**方法与路径**, 以及应答的解析。"""

    payload = b'{"ok": true, "focused": true}'
    paths: list = []

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler 的接口名
        type(self).paths.append(self.path)
        body = type(self).payload
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # noqa: D102 - 测试里不需要访问日志
        return


@pytest.fixture
def fake_focus_service():
    _FakeFocusService.paths = []
    srv = http.server.HTTPServer(("127.0.0.1", 0), _FakeFocusService)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()


def test_focus_posts_to_the_focus_path_and_reports_success(fake_focus_service) -> None:
    """⚠ 方法必须是 POST, 路径必须是 `/api/focus`, 且 URL 尾部的斜杠不能拼成双斜杠。"""
    _FakeFocusService.payload = b'{"ok": true, "focused": true}'
    port = fake_focus_service.server_address[1]
    assert focus(f"http://127.0.0.1:{port}/", timeout=0.5) is True
    assert _FakeFocusService.paths == ["/api/focus"]


def test_focus_reports_false_when_the_other_instance_is_headless(
        fake_focus_service) -> None:
    """无界面运行的实例没有窗口可抬 —— 它如实回 false, 这里也如实返回 `False`。"""
    _FakeFocusService.payload = b'{"ok": true, "focused": false}'
    port = fake_focus_service.server_address[1]
    assert focus(f"http://127.0.0.1:{port}/", timeout=0.5) is False


def test_focus_is_false_when_the_answer_is_not_ours(fake_focus_service) -> None:
    """对端回了个形状不对的 JSON ⇒ 没抬起来, 不是崩掉 (启动路径上不能抛)。"""
    _FakeFocusService.payload = b'{"hello": "world"}'
    port = fake_focus_service.server_address[1]
    assert focus(f"http://127.0.0.1:{port}/", timeout=0.5) is False


def test_focus_is_false_when_nothing_is_listening() -> None:
    port = pick_free_http_port("127.0.0.1", start=19900, tries=50)
    assert focus(f"http://127.0.0.1:{port}/", timeout=0.3) is False
