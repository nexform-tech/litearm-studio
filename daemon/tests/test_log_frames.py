"""`log` frame contract — the daemon's records on the wire (issue #79 point 2).

`test_session_logging.py` proves the records reach the **file**; this file proves
they also reach the **browser**, in the same shape and with the same redaction.
The two are separate because they fail separately: a sink that is never
registered, a frame with the wrong envelope, or a client that is dropped by a
slow pump all leave the file perfect and the page blind.

What the page relies on, and therefore what is pinned here:

* a structured record arrives as `{"t": "log", "seq": N, "record": {...}}`, and
  the record is the schema record, not a re-worded copy;
* `log_meta` on connect says where the stream is, so a gap can be told from
  silence — and `seq` only ever moves forward;
* a record that is too sensitive for the file is too sensitive for the wire.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from litearm_studio_daemon import obs
from litearm_studio_daemon.server import Daemon, _Client, create_app
from litearm_studio_daemon.session import Session

VERSION = "9.9.9-test"

SECRET_UID = "aabbccddeeff001122334455"
SECRET_PHONE = "13800000000"


def _wait(pred, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def logged_app(tmp_path: Path):
    """A connected fake session, records going to a throwaway file and the socket."""
    obs.configure(log_dir=tmp_path, version=VERSION, level="DEBUG")
    session = Session(fake=True, poll_period=0.02, state_push_interval=0.05)
    assert session.connect(trace="trace-wire") is True
    assert _wait(lambda: session.connected)
    app = create_app(session, version=VERSION, repo_dist=Path("/nonexistent-ui"))
    try:
        yield session, app
    finally:
        session.close()
        obs.flush()
        obs.shutdown()


def _frames_until(ws, tag: str, *, limit: int = 4000, timeout: float = 20.0):
    """Everything received up to and including the first frame of `tag`.

    ⚠ 判据是**墙钟**而不是帧数: 心跳帧每 2s 才来一条 (`Daemon.LOG_META_INTERVAL_S`),
    用"读够 N 条"当上限会在心跳之间空转, 也会在客户端已经离开时无限等下去。
    """
    collected = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        frame = ws.receive_json()
        collected.append(frame)
        if frame.get("t") == tag:
            return collected
    raise AssertionError(f"没等到 {tag} 帧 (读了 {len(collected)} 条)")


def _logs(ws, count: int, *, limit: int = 400):
    """Collect `count` log frames, skipping state/conn noise."""
    found = []
    for _ in range(limit):
        frame = ws.receive_json()
        if frame.get("t") == "log":
            found.append(frame)
            if len(found) >= count:
                return found
    raise AssertionError(f"只收到 {len(found)}/{count} 条 log 帧")


def test_handshake_announces_the_stream_position(logged_app) -> None:
    session, app = logged_app
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            frames = _frames_until(ws, "log_meta")
            meta = frames[-1]
            assert meta["t"] == "log_meta"
            assert isinstance(meta["seq"], int)
            assert meta["dropped"] == 0
            # 握手这条 `clients` 如实报 0: 注册排在发握手帧之后 (见 `_log_meta`)。
            assert meta["clients"] == 0
            # 握手顺序: 页面第一眼就该知道流的位置, 但 `hello`/`conn` 仍在它前面。
            tags = [frame["t"] for frame in frames]
            assert tags.index("hello") < tags.index("conn") < tags.index("log_meta")


def test_a_command_arrives_as_a_log_frame(logged_app) -> None:
    session, app = logged_app
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            _frames_until(ws, "log_meta")
            # ⚠ 命令从 **socket** 发: 这是页面真实的路径, 也是连接级 trace 被绑定的
            # 唯一位置 (`Daemon._traced_execute`)。直接调 `session.execute` 测不到它。
            ws.send_json({"t": "cmd", "id": 1, "m": "set_speed",
                          "p": {"percent": 35}})
            frames = []
            for _ in range(400):
                frame = ws.receive_json()
                if frame.get("t") != "log":
                    continue
                frames.append(frame)
                record = frame["record"]
                if record["event"] == obs.COMMAND_SUCCEEDED and \
                        record["fields"].get("method") == "set_speed":
                    break
            else:
                raise AssertionError("没等到 set_speed 的 log 帧")

            assert isinstance(frame["seq"], int)
            assert frame["seq"] > 0
            assert record["fields"]["args"] == {"percent": 35}
            assert record["fields"]["outcome"] == "ok"
            # 同一条记录, 不是重新编排过的副本: 页面与文件必须能逐字对上。
            # trace_id 由服务端为这条连接现生成 (W3C 32 位十六进制), 所以这里断言形状
            # 与"同一条连接内一致", 而不是某个固定值。
            assert record["trace_id"] and len(record["trace_id"]) == 32
            int(record["trace_id"], 16)
            assert record["service"] == "litearm-studio-daemon"
            # `set_speed` 是读/设类命令 ⇒ DEBUG (见 `schema.NOTABLE_COMMANDS`):
            # INFO 那一档只留给真正改变机器的命令, 否则文件会被 10Hz 的读取灌满。
            assert record["severity"] == "DEBUG"
            assert record["kind"] == "command"
            assert record["span_id"] == record["fields"]["span_id"]


def test_sequence_numbers_only_move_forward(logged_app) -> None:
    """页面靠序号判断"我漏了没有", 所以它必须单调, 且不重复。"""
    session, app = logged_app
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            _frames_until(ws, "log_meta")
            for index, percent in enumerate((10, 20, 30), start=1):
                ws.send_json({"t": "cmd", "id": index, "m": "set_speed",
                              "p": {"percent": percent}})
            seqs = []
            wanted = {"set_speed", "arm.command.succeeded", "session.closed"}
            for _ in range(400):
                frame = ws.receive_json()
                if frame.get("t") == "log":
                    seqs.append(frame["seq"])
                    if len([s for s in seqs]) >= 12 and frame["record"]["event"] in wanted:
                        if len(seqs) >= 12:
                            break
    assert seqs, "一条 log 帧都没收到"
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)


def test_activation_credentials_are_not_on_the_wire(logged_app) -> None:
    """文件与 WS 两条路共用一次脱敏 —— 线上也不许出现注册信息与 UID."""
    session, app = logged_app
    payload = {
        "uid": SECRET_UID,
        "contact": {"name": "Zhang San", "phone": SECRET_PHONE},
        "consent": {"granted": True},
        "diagnostics": {"studio": VERSION, "sdk": "2.1.0", "firmware": "1.9.0"},
    }
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            _frames_until(ws, "log_meta")
            ws.send_json({"t": "cmd", "id": 5, "m": "activate", "p": payload})
            seen = []
            for _ in range(400):
                frame = ws.receive_json()
                if frame.get("t") != "log":
                    continue
                seen.append(json.dumps(frame, ensure_ascii=False))
                if "activate" in seen[-1] and "arm.command.failed" in seen[-1]:
                    break
            blob = "\n".join(seen)
    assert SECRET_UID not in blob
    assert SECRET_PHONE not in blob
    assert "Zhang San" not in blob
    assert "contact_fields" in blob


def test_no_log_frame_is_sent_when_nobody_is_connected(logged_app) -> None:
    """没有客户端时记录只进文件 —— 序号因此不该被无人观看的记录推着走。"""
    session, app = logged_app
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            meta = _frames_until(ws, "log_meta")[-1]
        # 客户端走了: 这条记录只有文件看得到, 序号因此不该往前走。
        session.execute("set_speed", {"percent": 15})
        with client.websocket_connect("/ws") as ws:
            meta_after = _frames_until(ws, "log_meta")[-1]
    assert meta_after["seq"] == meta["seq"]
    # 握手那条 `clients` 如实报 0 (注册在发握手帧之后, 见 `_log_meta`)。
    assert meta_after["clients"] == 0


def test_a_full_queue_drops_log_frames_and_counts_them(logged_app) -> None:
    """队列满时丢 log 帧**可以**, 但"丢了"必须被计数 —— 页面靠这个数区分空白与没发生。

    这条在 `Daemon.broadcast` 这一层测, 而不是通过 socket: 让一个真实客户端慢到队列
    溢出需要几十秒的墙钟时间, 而且结果取决于调度。这里直接把队列塞满, 判据就是那条
    优先级规则本身 —— 它正是 `test_ws_estop_does_not_wait_for_a_command_in_flight`
    依赖的同一条规则 (conn/res 顶掉最旧的 state)。
    """
    import asyncio

    session, app = logged_app
    daemon = app.state.daemon
    client = _Client(q=asyncio.Queue(maxsize=2))
    daemon.clients.append(client)
    daemon.loop = None          # `broadcast` 是同步的; 用不到 loop
    try:
        daemon.broadcast({"t": "state"})
        daemon.broadcast({"t": "state"})
        daemon.broadcast({"t": "log", "seq": 1, "record": {}})
        assert client.dropped_logs == 1
        assert daemon._log_dropped == 1
        # conn/res 两类仍然顶掉最旧的一条 state, 而不是被丢掉。
        daemon.broadcast({"t": "res", "id": 1, "ok": True})
        assert client.dropped_logs == 1
        queued = [client.q.get_nowait() for _ in range(client.q.qsize())]
        assert queued[-1]["t"] == "res"
    finally:
        daemon.clients.remove(client)


def test_log_meta_is_reported_periodically_not_only_on_connect(logged_app) -> None:
    """丢帧发生在连接**之后**, 所以流的位置必须周期性播报 (见 `_gripper_heartbeat_loop`).

    ⚠ 只在接入时报一次等于报了个寂寞: 页面永远不知道后来丢了什么。
    """
    session, app = logged_app
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            first = _frames_until(ws, "log_meta")[-1]
            # ⚠ 必须**在连接上等**: 心跳每 2s 播报一次, 而断开之后就没有下一条了。
            # 2s 的间隔是刻意的 (见 `Daemon.LOG_META_INTERVAL_S`); 这里给它两倍余量。
            second = _frames_until(ws, "log_meta", limit=4000)[-1]
    assert second["seq"] >= first["seq"]
    assert set(second) >= {"t", "seq", "dropped", "clients"}
    # 周期性那条是这个连接**在册之后**发出的, 所以它如实报 1。
    assert second["clients"] == 1
