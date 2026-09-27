"""传输层单测 —— HTTP 健康检查、WS 契约、只监听本机的强制判据、命令行。"""
from __future__ import annotations

import asyncio
import json
import socket
import time
from pathlib import Path

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient

from litearm_studio_daemon.__main__ import build_parser, main
from litearm_studio_daemon.server import (
    _is_energy_down_frame,
    _is_loopback,
    create_app,
    pick_free_http_port,
    resolve_ui_dir,
)
from litearm_studio_daemon.session import Session

VERSION = "9.9.9-test"


def _client():
    """未连接的会话 + 应用 (静态目录强制指向不存在的路径 ⇒ 与构建产物有无无关)。"""
    session = Session(port_finder=lambda: None)
    app = create_app(session, version=VERSION, repo_dist=Path("/nonexistent-ui"))
    return session, app


# ------------------------------------------------------------------ 只监听本机

@pytest.mark.parametrize("host,expected", [
    ("127.0.0.1", True),
    ("localhost", True),
    ("::1", True),
    ("0.0.0.0", False),
    ("192.168.1.5", False),
    ("::", False),
])
def test_only_loopback_hosts_are_accepted(host: str, expected: bool) -> None:
    assert _is_loopback(host) is expected


def test_cli_refuses_a_non_loopback_host(capsys) -> None:
    """越线暴露一个能驱动机械臂的接口是安全事故 —— 命令行这一层就早退。"""
    assert main(["--host", "0.0.0.0"]) == 2
    assert "只允许监听本机" in capsys.readouterr().err


# ------------------------------------------------------------------ 端口挑选

def test_pick_free_http_port_returns_a_bindable_port() -> None:
    port = pick_free_http_port("127.0.0.1", start=18765, tries=10)
    assert 18765 <= port < 18775
    with socket.socket() as s:
        # ⚠ 绑法与真实服务器保持一致 (探测函数本身就带 SO_REUSEADDR): 用裸 `bind`
        # 校验的话, TIME_WAIT 里的端口会让这条用例**假红** —— 实测过。
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", port))


def test_pick_free_http_port_skips_an_occupied_port() -> None:
    with socket.socket() as taken:
        taken.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        taken.bind(("127.0.0.1", 0))
        taken.listen(1)
        busy = taken.getsockname()[1]
        assert pick_free_http_port("127.0.0.1", start=busy, tries=5) != busy


# ------------------------------------------------------------------ 静态目录

def test_resolve_ui_dir_is_none_when_missing(tmp_path: Path) -> None:
    assert resolve_ui_dir(None, repo_dist=tmp_path / "nope") is None
    assert resolve_ui_dir(str(tmp_path / "nope")) is None


def test_resolve_ui_dir_returns_an_existing_directory(tmp_path: Path) -> None:
    ui = tmp_path / "dist"
    ui.mkdir()
    assert resolve_ui_dir(str(ui)) == ui


# ------------------------------------------------------------------ HTTP

def test_health_endpoint_reports_state_without_a_connection() -> None:
    session, app = _client()
    try:
        with TestClient(app) as client:
            r = client.get("/api/health")
            assert r.status_code == 200
            body = r.json()
            assert body["ok"] is True
            assert body["daemon"] == VERSION
            assert body["sdk"]                        # SDK 版本非空
            assert body["connected"] is False
            assert body["motionBusy"] is False
            assert body["ui"] is None                 # 没有静态目录时不报错
            assert body["conn"]["status"] == "disconnected"
    finally:
        session.close()


def test_health_counts_connected_clients() -> None:
    session, app = _client()
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws"):
                assert client.get("/api/health").json()["clients"] == 1
            assert client.get("/api/health").json()["clients"] == 0
    finally:
        session.close()


# ------------------------------------------------------------------ WS 契约

def test_ws_handshake_sends_hello_then_conn() -> None:
    session, app = _client()
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                hello = ws.receive_json()
                assert hello["t"] == "hello"
                assert hello["daemon"] == VERSION
                assert hello["sdk"]

                conn = ws.receive_json()
                assert conn["t"] == "conn"
                assert conn["status"] == "disconnected"
                assert "port" in conn and "firmware" in conn and "n" in conn
    finally:
        session.close()


class _YieldingWS:
    """假 WebSocket: 写完第一帧就注入一条广播并让出事件循环。

    真实传输的 `send_text` 会让出控制权, 于是 50Hz 状态广播有机会插进握手帧之间 ——
    这条桩把那个竞态变成**确定性**的: 修复前 pump 一定能把 `state` 排在 `conn` 前。
    """

    def __init__(self, daemon) -> None:
        self.daemon = daemon
        self.sent: list[dict] = []

    async def accept(self) -> None:
        pass

    async def send_text(self, data: str) -> None:
        self.sent.append(json.loads(data))
        if len(self.sent) == 1:
            self.daemon.broadcast({"t": "state", "stamp": 0.0, "state": {"q": []}})
            await asyncio.sleep(0)   # 让 pump 有机会跑
            await asyncio.sleep(0)

    async def receive_text(self) -> str:
        raise WebSocketDisconnect()


def test_ws_writes_hello_and_conn_before_any_state_frame() -> None:
    """握手顺序是契约 (计划 3.1): 注册客户端必须排在两条握手帧**之后**。

    ⚠ 上一版先把客户端塞进 `self.clients` 再写 `hello`/`conn`, 于是状态广播能经
    `_pump` 插进两者之间 —— 客户端会在还不知道 `n`/`firmware` 时先收到一帧 `state`。
    """
    session, app = _client()
    try:
        ws = _YieldingWS(app.state.daemon)
        asyncio.run(app.state.daemon.handle_ws(ws))
        kinds = [m["t"] for m in ws.sent]
        assert kinds[:2] == ["hello", "conn"], f"握手顺序被打断: {kinds}"
    finally:
        session.close()


def test_ws_rejects_a_non_json_frame() -> None:
    session, app = _client()
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()                 # hello
                ws.receive_json()                 # conn
                ws.send_text("这不是 JSON")
                res = ws.receive_json()
                assert res["t"] == "res"
                assert res["ok"] is False
                assert res["err"]["kind"] == "BadMessage"
    finally:
        session.close()


def test_ws_rejects_an_unknown_message_type() -> None:
    session, app = _client()
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()
                ws.receive_json()
                ws.send_json({"t": "nope", "id": 3})
                res = ws.receive_json()
                assert res["id"] == 3
                assert res["err"]["kind"] == "BadMessage"
    finally:
        session.close()


def test_ws_command_without_a_session_returns_a_structured_error() -> None:
    session, app = _client()
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()
                ws.receive_json()
                ws.send_json({"t": "cmd", "id": 7, "m": "enable", "p": {}})
                res = ws.receive_json()
                assert res["t"] == "res"
                assert res["id"] == 7
                assert res["ok"] is False
                assert res["err"]["kind"] == "NotConnectedCommandError"
                assert res["err"]["method"] == "enable"
    finally:
        session.close()


def test_ws_command_requires_the_m_field() -> None:
    session, app = _client()
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()
                ws.receive_json()
                ws.send_json({"t": "cmd", "id": 8})
                res = ws.receive_json()
                assert res["id"] == 8
                assert res["err"]["kind"] == "BadMessage"
    finally:
        session.close()


def test_ws_estop_does_not_wait_for_a_command_in_flight() -> None:
    """急停帧不许等在途命令 —— 传输层曾经是另一半瓶颈。

    ⚠ 原来 `handle_ws` 处理一条上行帧时 `await self._on_upstream(...)`, 于是
    `receive_text` 也一起被挡住: 运动命令在跑时, **急停帧根本读不出来**。现在降能量
    帧旁路到独立任务, 与在途命令并行; 这条用例钉住「急停的 res 先回」。
    """
    session, app = _client()
    try:
        def fake_execute(m, p=None, *, on_event=None):
            if m == "movej":
                time.sleep(0.5)
            return None

        session.execute = fake_execute  # type: ignore[method-assign]
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()               # hello
                ws.receive_json()               # conn
                ws.send_json({"t": "cmd", "id": 1, "m": "movej",
                              "p": {"q": [0.1] * 7}})
                ws.send_json({"t": "cmd", "id": 2, "m": "estop", "p": {}})
                first = ws.receive_json()
                assert first["t"] == "res"
                assert first["id"] == 2, (
                    f"急停应先在途命令返回, 实际先回的是 id={first['id']}")
    finally:
        session.close()


@pytest.mark.parametrize("raw,expected", [
    ('{"t":"cmd","id":1,"m":"estop","p":{}}', True),
    ('{"t":"cmd","id":1,"m":"disable","p":{}}', True),
    ('{"t":"cmd","id":1,"m":"movej","p":{}}', False),   # 运动不进旁路
    ('{"t":"cmd","id":1,"m":"zero_g_stop","p":{}}', False),  # 会改会话状态, 不进旁路
    ('{"t":"connect"}', False),
    ("这不是 JSON", False),                              # 坏帧按普通帧处理
    ('["not","a","dict"]', False),
])
def test_energy_down_frame_detection(raw: str, expected: bool) -> None:
    assert _is_energy_down_frame(raw) is expected


# ------------------------------------------------------------------ 命令行

def test_cli_defaults() -> None:
    args = build_parser().parse_args([])
    assert args.fake is False
    assert args.port is None
    assert args.host == "127.0.0.1"
    assert args.http_port == 8765
    assert args.ui_dir is None
    assert args.no_open is False
    assert args.keep_enabled is False       # 默认退出前失能


def test_cli_keep_enabled_flag() -> None:
    """`--keep-enabled` 是"退出不降能量"的显式逃生口 (#14)。"""
    assert build_parser().parse_args(["--keep-enabled"]).keep_enabled is True


def test_cli_fake_flag_and_port_override() -> None:
    args = build_parser().parse_args(["--fake", "--port", "/dev/ttyACM9", "--no-open"])
    assert args.fake is True
    assert args.port == "/dev/ttyACM9"
    assert args.no_open is True
