"""夹爪在传输层的单测 —— 握手帧、命令分流、急停旁路、健康检查、缺席形态。"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from litearm_studio_daemon.gripper.config import ChannelStore
from litearm_studio_daemon.gripper.session import GripperSession
from litearm_studio_daemon.server import _is_energy_down_frame, create_app
from litearm_studio_daemon.session import Session


VERSION = "9.9.9-test"


@pytest.fixture(autouse=True)
def private_home(measured_home: Path) -> None:
    """私有 ``$HOME`` + 一份实测标定(``conftest.measured_home``)。

    没有它, 这个文件里的闸门断言读的是跑测试那台机器的 ``~/.litegrip``: 有实测文件
    时 READY, 没有时(CI)落到标称模板上的 TEMPLATE —— 同一份代码两种结果。
    """
    del measured_home


def _make(tmp_path: Path, *, with_gripper: bool = True):
    session = Session(port_finder=lambda: None)
    gripper: Optional[GripperSession] = None
    if with_gripper:
        gripper = GripperSession(fake=True,
                                 store=ChannelStore(tmp_path / "gripper.json"))
    app = create_app(session, gripper=gripper, version=VERSION,
                     repo_dist=Path("/nonexistent-ui"))
    return session, gripper, app


def _recv_until(ws, tag: str, timeout: float = 5.0) -> dict:
    """读到第一条 `tag` 帧 (中间的 state/alert 帧丢掉)。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        frame = ws.receive_json()
        if frame["t"] == tag:
            return frame
    raise AssertionError(f"没等到 {tag} 帧")


def _connect_gripper(ws, **params: Any) -> dict:
    """Ask for a connect and wait until the link is actually up.

    The command's `res` only acknowledges the request (§4.2); "connected" arrives
    on `gripper_conn`, which is what the page gates its controls on.
    """
    ws.send_json({"t": "cmd", "id": 1, "m": "gripper.connect", "p": params})
    res = _recv_until(ws, "res")
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        frame = ws.receive_json()
        if frame["t"] == "gripper_conn" and frame["status"] == "connected":
            return res
    raise AssertionError("夹爪没有连上")


# ------------------------------------------------------------------ 旁路判据

@pytest.mark.parametrize("method,bypass", [
    ("estop", True),
    ("disable", True),
    ("gripper.stop", True),
    ("gripper.disable", False),      # 文档明确要求它是普通排队命令 (§4.2)
    ("gripper.close", False),
    ("movej", False),
])
def test_only_the_energy_down_frames_take_the_bypass(method: str,
                                                     bypass: bool) -> None:
    raw = json.dumps({"t": "cmd", "id": 1, "m": method, "p": {}})
    assert _is_energy_down_frame(raw) is bypass


def test_a_broken_frame_is_not_a_bypass() -> None:
    assert _is_energy_down_frame("{oops") is False
    assert _is_energy_down_frame(json.dumps({"t": "connect"})) is False


# ------------------------------------------------------------------ 握手与健康

def test_handshake_carries_the_gripper_connection_frame(tmp_path: Path) -> None:
    session, gripper, app = _make(tmp_path)
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                assert ws.receive_json()["t"] == "hello"
                assert ws.receive_json()["t"] == "conn"
                # `log_meta` (接入时宣告日志流位置) 排在 `conn` 之后、`gripper_conn` 之前;
                # 这里等的是后者, 用 `_recv_until` 跳过中间那条。
                frame = _recv_until(ws, "gripper_conn")
                assert frame["status"] == "disconnected"
                assert frame["channel"] == "can0"
                assert frame["canId"] == 8
                assert frame["travelMm"] == 85.0
                assert frame["source"] is None
                assert frame["path"] is None
    finally:
        session.close()
        assert gripper is not None
        gripper.close()


def test_health_reports_the_gripper(tmp_path: Path) -> None:
    session, gripper, app = _make(tmp_path)
    try:
        with TestClient(app) as client:
            body = client.get("/api/health").json()
            assert body["gripper"]["channel"] == "can0"
            assert body["gripper"]["status"] == "disconnected"
    finally:
        session.close()
        assert gripper is not None
        gripper.close()


def test_health_says_so_when_there_is_no_gripper(tmp_path: Path) -> None:
    session, _, app = _make(tmp_path, with_gripper=False)
    try:
        with TestClient(app) as client:
            assert client.get("/api/health").json()["gripper"] is None
            with client.websocket_connect("/ws") as ws:
                hello = ws.receive_json()
                assert hello["t"] == "hello"
                assert ws.receive_json()["t"] == "conn"
                assert ws.receive_json()["t"] == "log_meta"
                # ⚠ 没有夹爪时**不发** `gripper_conn`: 缺席不是一个连接态。
                ws.send_json({"t": "cmd", "id": 2, "m": "gripper.enable", "p": {}})
                res = _recv_until(ws, "res")
                assert res["t"] == "res" and res["ok"] is False
                assert res["err"]["kind"] == "GripperNotConnectedError"
    finally:
        session.close()


# ------------------------------------------------------------------ 命令与帧

def test_gripper_commands_round_trip_over_the_socket(tmp_path: Path) -> None:
    session, gripper, app = _make(tmp_path)
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()   # hello
                ws.receive_json()   # conn
                assert ws.receive_json()["t"] == "log_meta"
                assert ws.receive_json()["t"] == "gripper_conn"

                res = _connect_gripper(ws)
                assert res == {"t": "res", "id": 1, "ok": True, "v": {"started": True}}

                ws.send_json({"t": "cmd", "id": 2, "m": "gripper.enable", "p": {}})
                assert _recv_until(ws, "res")["v"] == {"enabled": True}

                state = _recv_until(ws, "gripper_state")
                assert set(state["state"]) >= {
                    "positionMm", "forceN", "torqueNm", "enabled", "state",
                    "errorCode", "temps", "fresh", "gate", "gateReason"}
                assert state["state"]["gate"] == "READY"

                ws.send_json({"t": "cmd", "id": 3, "m": "gripper.set_motion",
                              "p": {"speedMmS": 42.0}})
                res = _recv_until(ws, "res")
                assert res["v"]["speedMmS"] == 42.0

                ws.send_json({"t": "cmd", "id": 4, "m": "gripper.list_channels",
                              "p": {}})
                res = _recv_until(ws, "res")
                assert isinstance(res["v"], list)
    finally:
        session.close()
        assert gripper is not None
        gripper.close()


def test_gripper_commands_share_the_id_space_and_report_errors(tmp_path: Path) -> None:
    session, gripper, app = _make(tmp_path)
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()
                ws.receive_json()
                ws.receive_json()

                ws.send_json({"t": "cmd", "id": 7, "m": "gripper.enable", "p": {}})
                res = _recv_until(ws, "res")
                assert res["id"] == 7 and res["ok"] is False
                assert res["err"]["kind"] == "GripperNotConnectedError"

                ws.send_json({"t": "cmd", "id": 8, "m": "gripper.teleport", "p": {}})
                res = _recv_until(ws, "res")
                assert res["err"]["kind"] == "UnknownCommandError"

                _connect_gripper(ws)
                ws.send_json({"t": "cmd", "id": 9, "m": "gripper.move_to",
                              "p": {"targetMm": 999}})
                res = _recv_until(ws, "res")
                assert res["id"] == 9 and res["ok"] is False
                assert res["err"]["kind"] == "ValueError"
    finally:
        session.close()
        assert gripper is not None
        gripper.close()


def test_gripper_stop_answers_while_a_slow_command_is_in_flight(tmp_path: Path) -> None:
    """§4.2: `gripper.stop` 在 WS 读循环上直接处理 —— 它不能排在慢命令后面。"""
    session, gripper, app = _make(tmp_path)
    assert gripper is not None
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()
                ws.receive_json()
                ws.receive_json()
                _connect_gripper(ws)

                real_execute = gripper.execute

                def slow(method: str, params: dict) -> Any:
                    if method == "gripper.close":
                        time.sleep(0.6)
                    return real_execute(method, params)

                gripper.execute = slow          # type: ignore[method-assign]
                ws.send_json({"t": "cmd", "id": 20, "m": "gripper.close", "p": {}})
                time.sleep(0.05)
                started = time.monotonic()
                ws.send_json({"t": "cmd", "id": 21, "m": "gripper.stop", "p": {}})
                res = _recv_until(ws, "res", timeout=2.0)
                assert res["id"] == 21, "急停的回帧被慢命令挡住了"
                assert time.monotonic() - started < 0.5
    finally:
        session.close()
        gripper.close()


def test_gripper_alert_frames_reach_the_client(tmp_path: Path) -> None:
    """异步的拒绝/故障没有 `res` 可回 —— 它们走 `gripper_alert`。"""
    session, gripper, app = _make(tmp_path)
    assert gripper is not None
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()
                ws.receive_json()
                ws.receive_json()
                _connect_gripper(ws)
                time.sleep(0.1)
                # 未使能就闭合: 循环会拒绝并推一条 alert。
                ws.send_json({"t": "cmd", "id": 3, "m": "gripper.close", "p": {}})
                frame = _recv_until(ws, "gripper_alert")
                assert frame["level"] in ("warn", "error")
                assert frame["text"]
    finally:
        session.close()
        gripper.close()


def test_gripper_list_dir_round_trips_before_any_connection(tmp_path: Path) -> None:
    """浏览选择器在**连接之前**就要能列目录 —— 端到端往返验一遍 (免连接)。"""
    session, gripper, app = _make(tmp_path)
    assert gripper is not None
    try:
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.receive_json()
                ws.receive_json()
                ws.receive_json()               # 尚未连接

                home = str(Path(os.environ["HOME"]))
                ws.send_json({"t": "cmd", "id": 1, "m": "gripper.list_dir",
                              "p": {"path": home}})
                res = _recv_until(ws, "res")
                assert res["ok"] is True
                assert res["v"]["path"] == home
                assert isinstance(res["v"]["entries"], list)

                # 指向一个文件 → 不是可读目录。
                bad = tmp_path / "not-a-dir.json"
                bad.write_text("{}", encoding="utf-8")
                ws.send_json({"t": "cmd", "id": 2, "m": "gripper.list_dir",
                              "p": {"path": str(bad)}})
                res = _recv_until(ws, "res")
                assert res["ok"] is False
                assert res["err"]["kind"] == "GripperBrowseError"
    finally:
        session.close()
        gripper.close()
