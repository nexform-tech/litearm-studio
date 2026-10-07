"""传输层单测 —— HTTP 健康检查、WS 契约、只监听本机的强制判据、命令行。"""
from __future__ import annotations

import asyncio
import json
import socket
import sys
import time
from pathlib import Path

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient

from litearm_studio_daemon.__main__ import build_parser, main
from litearm_studio_daemon.server import (
    HTTP_PORT_TRIES,
    _is_energy_down_frame,
    _is_loopback,
    create_app,
    origin_allowed,
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


# --------------------------------------------------- 跨源 WebSocket 的准入判据

@pytest.mark.parametrize("origin,host,expected", [
    # 同源 + loopback: 生产形态 (页面由本进程伺服) 与 dev 代理都走这条
    ("http://127.0.0.1:8765", "127.0.0.1:8765", True),
    ("http://localhost:8765", "localhost:8765", True),
    ("http://[::1]:8765", "[::1]:8765", True),
    # 同源但端口不同 = 不同的源
    ("http://127.0.0.1:8765", "127.0.0.1:8766", False),
    # 别的站点直连本机端口
    ("http://evil.example", "127.0.0.1:8765", False),
    # DNS rebinding: Origin 与 Host 都是攻击者的域名 —— 同源判据会通过, 只有 Host
    # 白名单能拦下。这一条就是这套判据存在的核心理由。
    ("http://evil.example", "evil.example", False),
    # 非 http(s) 的源 (沙箱 iframe / 本地文件)
    ("null", "127.0.0.1:8765", False),
    ("file:///tmp/x.html", "127.0.0.1:8765", False),
    # 开发期前端 (vite) 显式放行
    ("http://localhost:5173", "127.0.0.1:8765", True),
])
def test_origin_allowed(origin: str, host: str, expected: bool) -> None:
    assert origin_allowed(origin, host) is expected


def test_origin_allowed_honours_extra_origins() -> None:
    """`--allow-origin` 是唯一的逃生口, 且只对它自己列出的那个源生效。"""
    assert origin_allowed("http://localhost:8000", "127.0.0.1:8765",
                          ["http://localhost:8000"]) is True
    assert origin_allowed("http://localhost:8001", "127.0.0.1:8765",
                          ["http://localhost:8000"]) is False


def test_ws_rejects_a_cross_origin_handshake() -> None:
    """任何网页都能连本机端口 —— 所以握手这一层就得拒。

    ⚠ `TestClient.websocket_connect` 把 URL 硬编码成 `ws://testserver`, `base_url`
    改不了 Host ⇒ 这里显式给 `host` 头, 才是"攻击者的页面连本机端口"的真实形状。
    """
    session, app = _client()
    try:
        with TestClient(app) as client:
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(
                        "/ws", headers={"origin": "http://evil.example",
                                        "host": "127.0.0.1:8765"}):
                    pytest.fail("跨源握手不该建立")
    finally:
        session.close()


def test_ws_rejects_a_dns_rebinding_handshake() -> None:
    """Origin 与 Host 都是攻击者的域名 —— 只有 Host 白名单能拦住它。"""
    session, app = _client()
    try:
        with TestClient(app) as client:
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(
                        "/ws", headers={"origin": "http://evil.example",
                                        "host": "evil.example"}):
                    pytest.fail("DNS rebinding 的握手不该建立")
    finally:
        session.close()


def test_ws_accepts_a_same_origin_handshake() -> None:
    """本进程自己伺服的页面 (生产形态) 必须照常连上。"""
    session, app = _client()
    try:
        with TestClient(app) as client:
            with client.websocket_connect(
                    "/ws", headers={"origin": "http://127.0.0.1:8765",
                                    "host": "127.0.0.1:8765"}) as ws:
                assert ws.receive_json()["t"] == "hello"
    finally:
        session.close()


def test_ws_accepts_a_client_without_an_origin_header() -> None:
    """没有 Origin = 非浏览器客户端 (脚本 / 原生工具)。浏览器一定会发, 故放行它不
    扩大威胁面 —— 本地进程本来就能直接开串口。"""
    session, app = _client()
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                assert ws.receive_json()["t"] == "hello"
    finally:
        session.close()


def test_ws_accepts_an_explicitly_allowed_origin() -> None:
    """`--allow-origin` 要真的穿到 `Daemon` 上, 而不只是被解析出来。"""
    session = Session(port_finder=lambda: None)
    app = create_app(session, version=VERSION, repo_dist=Path("/nonexistent-ui"),
                     allow_origins=["http://localhost:8000"])
    try:
        with TestClient(app) as client:
            with client.websocket_connect(
                    "/ws", headers={"origin": "http://localhost:8000",
                                    "host": "127.0.0.1:8765"}) as ws:
                assert ws.receive_json()["t"] == "hello"
    finally:
        session.close()


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


def test_resolve_ui_dir_prefers_the_bundled_ui_when_frozen(tmp_path: Path,
                                                           monkeypatch) -> None:
    """PyInstaller 冻结后界面在 `_MEIPASS/dist` —— 仓库相对路径必然不存在。

    打包出来的可执行程序只有认这个路径, 才能免掉手工 `--ui-dir`。
    """
    bundled = tmp_path / "bundle" / "dist"
    bundled.mkdir(parents=True)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path / "bundle"), raising=False)
    # 仓库路径故意给一个不存在的目录: 冻结分支必须优先。
    assert resolve_ui_dir(None, repo_dist=tmp_path / "no-repo-dist") == bundled


def test_resolve_ui_dir_falls_back_when_the_bundle_has_no_ui(tmp_path: Path,
                                                            monkeypatch) -> None:
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path / "empty-bundle"), raising=False)
    repo = tmp_path / "repo-dist"
    repo.mkdir()
    assert resolve_ui_dir(None, repo_dist=repo) == repo


def test_explicit_ui_dir_beats_the_bundle(tmp_path: Path, monkeypatch) -> None:
    bundled = tmp_path / "bundle" / "dist"
    bundled.mkdir(parents=True)
    explicit = tmp_path / "explicit"
    explicit.mkdir()
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path / "bundle"), raising=False)
    assert resolve_ui_dir(str(explicit)) == explicit


# ------------------------------------------------------------------ SPA 兜底

def _spa_client(tmp_path: Path):
    """带静态目录的会话 —— 前端路由 (`/control` …) 在磁盘上没有对应文件。"""
    ui = tmp_path / "dist"
    (ui / "assets").mkdir(parents=True)
    (ui / "index.html").write_text("<!doctype html><title>liteart-ui</title>",
                                   encoding="utf-8")
    (ui / "assets" / "app.js").write_text("// app\n", encoding="utf-8")
    session = Session(port_finder=lambda: None)
    app = create_app(session, version=VERSION, ui_dir=str(ui))
    return session, app


@pytest.mark.parametrize("route", ["/control", "/log", "/settings"])
def test_frontend_routes_fall_back_to_index_html(tmp_path: Path, route: str) -> None:
    """刷新 / 手输 URL 不能白屏 (issue #30)。

    ⚠ `StaticFiles(html=True)` 只补**目录**请求, 所以 `/` 本来是好的, 而这三条路由
    直接 404 —— 站内点击是客户端跳转, 只有硬加载才暴露, 所以一直没被发现。
    """
    session, app = _spa_client(tmp_path)
    try:
        with TestClient(app) as client:
            r = client.get(route)
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/html")
            assert "liteart-ui" in r.text
    finally:
        session.close()


def test_root_and_real_assets_are_untouched(tmp_path: Path) -> None:
    """兜底不许吃掉静态资源本身。"""
    session, app = _spa_client(tmp_path)
    try:
        with TestClient(app) as client:
            assert "liteart-ui" in client.get("/").text
            js = client.get("/assets/app.js")
            assert js.status_code == 200
            assert "javascript" in js.headers["content-type"]
    finally:
        session.close()


@pytest.mark.parametrize("path", ["/api/typo", "/ws", "/assets/missing.js"])
def test_non_route_paths_keep_their_404(tmp_path: Path, path: str) -> None:
    """`/api/*`、`/ws`、带扩展名的资源路径都不兜底。

    接口打错字返回 200 的 HTML 会让调用方以为成功; 陈旧缓存去要一个已被清掉的
    `assets/index-<旧 hash>.js` 时, 404 才说得清是资源没了, 而不是 MIME 错。
    """
    session, app = _spa_client(tmp_path)
    try:
        with TestClient(app) as client:
            assert client.get(path).status_code == 404
            assert client.get("/api/health").status_code == 200   # 真接口不受影响
    finally:
        session.close()


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


@pytest.mark.parametrize("fake", [True, False])
def test_health_reports_whether_the_session_is_fake(fake: bool) -> None:
    """`fake` 是复用判据的一半 (`instance.is_same_instance`)。

    ⚠ 缺了它, 真机版的启动会复用一个 `--fake` 的调试进程 —— 操作员对着假设备操作, 而那
    比多起一个进程更难发现。
    """
    session = Session(fake=fake, reconnect=False,
                      poll_period=0.05, state_push_interval=0.05)
    app = create_app(session, version=VERSION, repo_dist=Path("/nonexistent-ui"))
    try:
        with TestClient(app) as client:
            assert client.get("/api/health").json()["fake"] is fake
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


def test_ws_reports_a_dead_link_on_the_conn_frame(monkeypatch) -> None:
    """#48 的交付面: 链路断在 WS 上必须**看得见** —— `error` 有原因、`port` 清空。

    这条钉的是操作员实际看到的那一帧 (计划 3.1 的 `conn`), 不是 `arm_info()` 的内部形状:
    前端顶栏只认这一帧。
    """
    from litearm.arm import Msg

    from litearm_studio_daemon.session import Session as _Session

    session = _Session(fake=True, reconnect=False, link_stale_after=0.1)
    app = create_app(session, version=VERSION, repo_dist=Path("/nonexistent-ui"))
    try:
        assert session.connect() is True
        deadline = time.monotonic() + 5.0
        while not session.connected and time.monotonic() < deadline:
            time.sleep(0.01)
        assert session.connected, f"假会话没连上: {session.arm_info()}"

        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                assert ws.receive_json()["t"] == "hello"
                assert ws.receive_json()["status"] == "connected"
                real = session._arm.get_state
                frozen = Msg(value=real().value, hz=0.0,
                             timestamp=time.monotonic() - 60.0)
                monkeypatch.setattr(session._arm, "get_state", lambda *a, **k: frozen)
                while True:
                    frame = ws.receive_json()
                    if frame["t"] == "conn" and frame["status"] != "connected":
                        break
                assert frame["status"] == "error", frame
                assert frame["port"] is None, f"端口必须清空: {frame}"
                assert frame["error"] and "链路已断开" in frame["error"], frame
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
        #: 真实 WebSocket 有 `headers`; 准入判据要读它, 所以桩也得有 (空 = 无 Origin)。
        self.headers: dict = {}

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


def test_ws_license_command_round_trips_the_record() -> None:
    """`license` 的**线上形状**是契约 (docs/ACTIVATION.md): 前端解析的就是这一帧。

    ⚠ 特意走 WS 而不是直接调 `Session.execute`: 这里要钉的是 `res.v` 里到底有什么
    (键名、类型、三态字段) —— 那是前端唯一看得见的东西。
    """
    from litearm_studio_daemon.session import Session as _Session

    session = _Session(fake=True, reconnect=False,
                       poll_period=0.05, state_push_interval=0.05)
    app = create_app(session, version=VERSION, repo_dist=Path("/nonexistent-ui"))
    try:
        assert session.connect() is True
        deadline = time.monotonic() + 5.0
        while not session.connected and time.monotonic() < deadline:
            time.sleep(0.01)
        assert session.connected, f"假会话没连上: {session.arm_info()}"

        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()                 # hello
                ws.receive_json()                 # conn
                ws.send_json({"t": "cmd", "id": 11, "m": "license", "p": {}})
                while True:                       # 状态帧会插进来, 认 id
                    frame = ws.receive_json()
                    if frame["t"] == "res" and frame["id"] == 11:
                        break
                assert frame["ok"] is True, frame
                v = frame["v"]
                assert v["supported"] is True
                assert v["activated"] is True and v["state"] == 1
                assert v["stateName"] == "activated"
                # 签发器要的形态: 24 位小写 hex。
                assert len(v["uid"]) == 24 and v["uid"] == v["uid"].lower()
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
    assert args.no_reconnect is False       # 默认断线后自愈 (#48)


def test_cli_keep_enabled_flag() -> None:
    """`--keep-enabled` 是"退出不降能量"的显式逃生口 (#14)。"""
    assert build_parser().parse_args(["--keep-enabled"]).keep_enabled is True


def test_cli_no_reconnect_flag() -> None:
    """`--no-reconnect` 是"断了就停在那儿、别自己去重连"的显式逃生口 (#48)。"""
    assert build_parser().parse_args(["--no-reconnect"]).no_reconnect is True


def test_cli_fake_flag_and_port_override() -> None:
    args = build_parser().parse_args(["--fake", "--port", "/dev/ttyACM9", "--no-open"])
    assert args.fake is True
    assert args.port == "/dev/ttyACM9"
    assert args.no_open is True


def test_cli_fake_unactivated_requires_fake(capsys) -> None:
    """组合无意义就明确报错: 用户以为"未激活的假设备"起来了, 实际会去连真硬件。"""
    assert main(["--fake-unactivated"]) == 2
    assert "--fake" in capsys.readouterr().err


def test_cli_fake_unactivated_parses_with_fake() -> None:
    args = build_parser().parse_args(["--fake", "--fake-unactivated"])
    assert args.fake is True and args.fake_activated is False
    # 默认仍是"已激活的假设备" —— 不给开关就不改变老行为。
    assert build_parser().parse_args(["--fake"]).fake_activated is True


# ------------------------------------------------- 复用已经在跑的实例 (issue #75)

def _serve_must_not_run(monkeypatch, cli):
    """把 `serve` 换成哨兵: 走到它就说明**又起了一个守护进程**, 正是 #75 的缺陷。"""
    class _Started(Exception):
        pass

    async def _serve(*args, **kwargs):
        raise _Started()

    monkeypatch.setattr(cli, "serve", _serve)
    return _Started


def test_main_reuses_the_running_instance_instead_of_starting_a_second(
        monkeypatch, capsys) -> None:
    """关掉窗口再启动一次, 不该另起一个连不上机械臂的会话 (串口被上一个进程独占)。

    ⚠ 探测本身由 `test_instance.py` 钉住; 这里替换掉它, 断言的是**启动路径的走向**:
    没走到 `serve`, 就没有第二个守护进程。
    """
    from litearm_studio_daemon import __main__ as cli

    _serve_must_not_run(monkeypatch, cli)
    monkeypatch.setattr(cli, "find_running", lambda *a, **k: "http://127.0.0.1:8765/")
    monkeypatch.setattr(cli, "_open_browser", lambda url: None)

    assert cli.main(["--no-open"]) == 0
    assert "复用它" in capsys.readouterr().out


def test_main_opens_a_window_onto_the_running_instance(monkeypatch) -> None:
    """复用时必须**把窗口指向它** —— 否则进程退得干干净净, 操作员什么都没看到。"""
    from litearm_studio_daemon import __main__ as cli

    _serve_must_not_run(monkeypatch, cli)
    monkeypatch.setattr(cli, "find_running", lambda *a, **k: "http://127.0.0.1:8765/")
    opened: list[str] = []
    monkeypatch.setattr(cli, "_open_browser", opened.append)

    assert cli.main([]) == 0
    assert opened == ["http://127.0.0.1:8765/"]


@pytest.mark.parametrize("argv", [
    ["--port", "/dev/ttyACM9"],
    ["--fake"],
    ["--can-channel", "can1"],
    ["--ui-dir", "/tmp/other-ui"],
    ["--no-gripper"],
])
def test_main_does_not_reuse_when_this_launch_names_a_specific_session(
        monkeypatch, argv) -> None:
    """显式指定了会话形状 ⇒ 连探测都不做, 照常启动。

    ⚠ 复用等于把这些选择**静默丢掉** —— 与 #74 定下的"显式指定的选择不做退让"是同一条
    纪律 (见 `__main__._SESSION_SHAPING`)。
    """
    from litearm_studio_daemon import __main__ as cli

    _Started = _serve_must_not_run(monkeypatch, cli)
    probed: list[dict] = []
    monkeypatch.setattr(cli, "find_running",
                        lambda *a, **k: probed.append(k) or "http://127.0.0.1:8765/")
    monkeypatch.setattr(cli, "build_gripper_session", lambda args: None)

    with pytest.raises(_Started):
        cli.main([*argv, "--no-open"])
    assert probed == [], "显式指定会话形状时不该去探测"


def test_main_probes_for_this_build_on_the_ports_the_picker_would_use(monkeypatch) -> None:
    """探测的入参也要对: 本构建的版本号, 以及与 `pick_free_http_port` 同一个范围。"""
    from litearm_studio_daemon import __main__ as cli, __version__

    seen: dict = {}

    def _find(host, start, tries, *, version, fake=False):
        seen.update(host=host, start=start, tries=tries, version=version, fake=fake)
        return None

    async def _serve(*args, **kwargs):
        return None

    monkeypatch.setattr(cli, "find_running", _find)
    monkeypatch.setattr(cli, "serve", _serve)
    monkeypatch.setattr(cli, "build_gripper_session", lambda args: None)

    assert cli.main(["--no-open"]) == 0
    assert seen == {"host": "127.0.0.1", "start": 8765, "tries": HTTP_PORT_TRIES,
                    "version": __version__, "fake": False}


# ------------------------------------------------------------ 固件升级的帧

def test_ws_receives_firmware_progress_and_result_frames() -> None:
    """升级的进度与终局**必须**能过 WS —— 它们是这条功能唯一的结果通道。

    命令只回一个 job 号就返回（烧录可能几十秒，超过 `COMMAND_TIMEOUT_S`，而且进
    bootloader 之后没有会话可问），所以"界面能不能看到结果"完全取决于两类广播帧
    有没有真的走到客户端。这一条钉的就是那个交付面。
    """
    import base64

    from litearm_studio_daemon.dfu import fake as fake_engine
    from litearm_studio_daemon.session import Session as _Session

    def rec(off: int, typ: int, data: bytes) -> str:
        body = bytes([len(data), (off >> 8) & 0xFF, off & 0xFF, typ]) + data
        return ":" + (body + bytes([(-sum(body)) & 0xFF])).hex().upper()

    text = (rec(0, 0x04, b"\x08\x00") + "\n"
            + rec(0, 0x00, b"Litearm1.9.0-7J\x00\x00\x00\x00") + "\n:00000001FF\n")

    session = _Session(fake=True, dfu_engine=fake_engine.FakeEngine(steps=2))
    app = create_app(session, version=VERSION, repo_dist=Path("/nonexistent-ui"))
    try:
        assert session.connect() is True
        deadline = time.monotonic() + 5.0
        while not session.connected and time.monotonic() < deadline:
            time.sleep(0.01)
        assert session.connected

        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                assert ws.receive_json()["t"] == "hello"
                assert ws.receive_json()["t"] == "conn"

                inspected = session.execute(
                    "firmware_inspect",
                    {"name": "fw.hex",
                     "data": base64.b64encode(text.encode()).decode()})
                job = session.execute(
                    "firmware_upgrade",
                    {"token": inspected["token"], "confirm": True})["job"]

                phases, result = [], None
                end = time.monotonic() + 20.0
                while result is None and time.monotonic() < end:
                    frame = ws.receive_json()
                    if frame["t"] == "firmware_progress":
                        assert frame["job"] == job
                        phases.append(frame["phase"])
                    elif frame["t"] == "firmware_result":
                        result = frame

                assert result is not None, "没收到 firmware_result 帧"
                assert result["ok"] is True, result
                assert result["job"] == job
                # 相位从校验一路走到完成 —— 少了中间任何一段，界面上的进度条都会冻住。
                assert phases[0] == "validate"
                assert "flash" in phases and phases[-1] == "done"
    finally:
        session.close()
