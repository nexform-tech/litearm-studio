"""夹爪会话单测 —— 命令白名单、参数校验、急停、心跳, 全部跑仿真后端。

不碰 CAN, 不碰真硬件: `GripperSession(fake=True)` 背后是 `SimBackend`, 而它跑的
是与实机**同一套** 运动/标定状态机 (lifted core), 所以这里验的是生产代码路径。
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, List, Optional

import pytest

from litearm_studio_daemon.errors import (
    GripperBusyError,
    GripperCalibrationError,
    GripperEstoppedError,
    GripperNotConnectedError,
    UnknownCommandError,
)
from litearm_studio_daemon.gripper import can_link
from litearm_studio_daemon.gripper.config import ChannelConfig, ChannelStore
from litearm_studio_daemon.gripper.session import GripperSession
from litearm_studio_daemon.gripper.core import commands as cmd
from litearm_studio_daemon.gripper.core.worker import WorkerLoop


# ------------------------------------------------------------------ 工具

def wait_for(predicate, timeout: float = 5.0, interval: float = 0.01) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class Recorder:
    """`WorkerLoop` 的信号对象替身 —— 只记下每一次 emit。"""

    def __init__(self) -> None:
        self.events: List[tuple] = []
        for name in ("telemetry", "motion_state", "conn_state", "fault", "gate_state",
                     "calib_info", "calib_progress", "log", "alert", "busy"):
            setattr(self, name, _Channel(name, self.events))

    def named(self, name: str) -> List[tuple]:
        return [e for e in self.events if e[0] == name]


class _Channel:
    def __init__(self, name: str, sink: List[tuple]) -> None:
        self._name = name
        self._sink = sink

    def emit(self, *values: Any) -> None:
        self._sink.append((self._name, *values))


def make_session(tmp_path: Path, **kwargs: Any) -> GripperSession:
    store = ChannelStore(tmp_path / "gripper.json")
    return GripperSession(fake=True, store=store, **kwargs)


def connect(session: GripperSession) -> None:
    session.execute("gripper.connect", {})
    assert wait_for(session.connected), f"没连上: {session.conn_info()}"


@pytest.fixture(autouse=True)
def private_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """每条用例一个私有 ``$HOME``。

    仿真后端的 ``save_calibration`` 写到 ``~/.litegrip/litegrip_calibration.sim.json``
    （见 sim.py）—— 不隔离的话, 一次成功的标定就会写进跑测试那个人的家目录。
    """
    monkeypatch.setenv("HOME", str(tmp_path / "home"))


# ------------------------------------------------------------------ 配置存储

def test_store_round_trips_and_remembers_the_last_channel(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "gripper.json"
    store = ChannelStore(path)
    assert store.get("can0").travel_mm == 85.0

    store.update("can1", travel_mm=62.5, mount="reverse", can_id=9, allow_factory=True)
    assert store.last_channel() == "can1"

    again = ChannelStore(path)
    record = again.get("can1")
    assert record.travel_mm == 62.5
    assert record.mount == "reverse"
    assert record.can_id == 9
    assert record.allow_factory is True
    assert again.last_channel() == "can1"
    # The JSON on disk is the documented shape (§5.6).
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw["channels"]["can1"]["channel"] == "can1"
    assert raw["lastChannel"] == "can1"


def test_store_ignores_a_malformed_file_and_still_writes(tmp_path: Path) -> None:
    path = tmp_path / "gripper.json"
    path.write_text("{ not json", encoding="utf-8")
    store = ChannelStore(path)
    assert store.all() == {}
    assert store.get("can0").travel_mm == 85.0
    store.update("can0", travel_mm=70.0)
    assert ChannelStore(path).get("can0").travel_mm == 70.0


def test_store_drops_a_foreign_field_without_losing_the_record(tmp_path: Path) -> None:
    path = tmp_path / "gripper.json"
    path.write_text(json.dumps({"channels": {"can0": {
        "can_id": 8, "travel_mm": "banana", "mount": "sideways", "extra": 1,
    }}}), encoding="utf-8")
    record = ChannelStore(path).get("can0")
    assert record.travel_mm == 85.0          # fell back to the default
    assert record.mount is None              # an unknown mount is not a declaration
    assert record.can_id == 8                # the rest of the record survives


def test_store_rejects_an_unknown_field_on_update(tmp_path: Path) -> None:
    store = ChannelStore(tmp_path / "gripper.json")
    with pytest.raises(TypeError):
        store.update("can0", travell_mm=70.0)


# ------------------------------------------------------------------ CAN 枚举

def test_list_channels_reads_the_kernel_type_field(tmp_path: Path) -> None:
    """§5.4: 枚举靠 `/sys/class/net/*/type == 280`, 不是硬编码 can0..can2。"""
    net = tmp_path / "net"
    for name, kind in (("can3", "280"), ("vcan0", "280"), ("eth0", "1"),
                       ("lo", "772"), ("broken", "not-a-number")):
        (net / name).mkdir(parents=True)
        (net / name / "type").write_text(kind, encoding="utf-8")
    (net / "notype").mkdir()
    assert can_link.list_channels(str(net)) == ["can3", "vcan0"]
    assert can_link.list_channels(str(tmp_path / "missing")) == []


# ------------------------------------------------------------------ 会话生命周期

def test_session_connects_enables_and_moves_in_simulation(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    try:
        connect(session)
        assert session.conn_info()["channel"] == "can0"
        assert session.execute("gripper.enable", {}) == {"enabled": True}
        assert wait_for(lambda: session.state() and session.state()["enabled"])

        assert session.execute("gripper.move_to",
                               {"targetMm": 40.0, "speedMmS": 60.0}) == {"ok": True}
        assert wait_for(lambda: _position_near(session, 40.0))
        frame = session.state()
        assert frame["state"] == "holding", frame
        assert frame["gate"] == "READY"
    finally:
        session.close()


def _position_near(session: GripperSession, target: float, tol: float = 1.0) -> bool:
    frame = session.state()
    if frame is None or frame["positionMm"] is None:
        return False
    return frame["state"] == "holding" and abs(frame["positionMm"] - target) <= tol


def test_disconnect_closes_the_link_and_stops_the_tick(tmp_path: Path) -> None:
    """§5.1.4: 断开要停 tick、零力矩、失能、关 socket。"""
    session = make_session(tmp_path)
    try:
        connect(session)
        session.execute("gripper.enable", {})
        assert wait_for(lambda: session.state() and session.state()["enabled"])
        assert session.execute("gripper.disconnect", {}) == {"stopped": True}
        assert wait_for(lambda: session.status == "disconnected")
        ticks = session.loop.ticks
        assert wait_for(lambda: session.loop.ticks > ticks + 5), "tick 线程应继续运行"
        assert not session.loop.connected
        assert not session.loop.enabled
        assert session.execute("gripper.disconnect", {}) == {"stopped": False}
    finally:
        session.close()


def test_close_deenergizes_and_leaves_the_session_disconnected(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    connect(session)
    session.execute("gripper.enable", {})
    assert wait_for(lambda: session.state() and session.state()["enabled"])
    session.close()
    assert session.status == "disconnected"
    assert not session.loop.connected
    assert not session.loop.enabled
    session.close()          # 幂等


# ------------------------------------------------------------------ 命令门控

def test_commands_need_a_connection(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    try:
        for method in ("gripper.enable", "gripper.open", "gripper.move_to",
                       "gripper.set_motion", "gripper.release"):
            with pytest.raises(GripperNotConnectedError):
                session.execute(method, {"targetMm": 10.0})
        # 断开/连接本身在未连接时是合法的 (幂等), 急停也是。
        assert session.execute("gripper.disconnect", {}) == {"stopped": False}
        assert session.execute("gripper.stop", {}) is None
        # ⚠ 复位急停要连接: 锁存是链路还在时发生的, 没有链路也就没有可复位的锁存。
        with pytest.raises(GripperNotConnectedError):
            session.execute("gripper.reset_stop", {})
    finally:
        session.close()


def test_unknown_command_is_rejected_with_the_whitelist(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    try:
        with pytest.raises(UnknownCommandError):
            session.execute("gripper.launch_missiles", {})
        with pytest.raises(UnknownCommandError):
            session.execute("movej", {})       # 臂的命令不走这条路
    finally:
        session.close()


def test_move_to_validates_the_target_against_the_travel(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    try:
        connect(session)
        session.execute("gripper.enable", {})
        with pytest.raises(ValueError):
            session.execute("gripper.move_to", {"targetMm": 999.0})
        with pytest.raises(ValueError):
            session.execute("gripper.move_to", {})
        with pytest.raises(ValueError):
            session.execute("gripper.move_to", {"targetMm": 10.0, "speedMmS": 999.0})
        with pytest.raises(ValueError):
            session.execute("gripper.grasp", {"forceN": 100.0})
        assert session.execute("gripper.move_to", {"targetMm": 85.0}) == {"ok": True}
    finally:
        session.close()


def test_set_motion_answers_with_what_takes_effect(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    try:
        connect(session)
        assert session.execute("gripper.set_motion",
                               {"speedMmS": 33.0, "forceN": 20.0}) == {
            "speedMmS": 33.0, "forceN": 20.0}
        assert wait_for(lambda: abs(session.loop.motion.params.speed_mm_s - 33.0) < 1e-6)
    finally:
        session.close()


def test_a_grasp_with_a_hold_time_lets_go_by_itself(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    try:
        connect(session)
        session.execute("gripper.enable", {})
        assert wait_for(lambda: session.state() and session.state()["enabled"])
        assert session.execute("gripper.grasp", {"holdS": 0.2}) == {"ok": True}
        assert wait_for(
            lambda: session.loop.motion.state.value == "RELEASE", timeout=5.0), \
            session.loop.motion.state
        # 零重力不是失能: 电机仍在使能, 可以被推。
        assert session.state()["enabled"] is True
    finally:
        session.close()


# ------------------------------------------------------------------ 急停

def test_estop_latches_and_refuses_motion_until_reset(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    try:
        connect(session)
        session.execute("gripper.enable", {})
        assert wait_for(lambda: session.state() and session.state()["enabled"])

        assert session.execute("gripper.stop", {}) is None
        assert wait_for(lambda: session.estopped())
        assert wait_for(lambda: session.state() and session.state()["state"] == "stopped")
        assert wait_for(lambda: session.state() and session.state()["enabled"] is False)

        with pytest.raises(GripperEstoppedError):
            session.execute("gripper.open", {})
        with pytest.raises(GripperEstoppedError):
            session.execute("gripper.move_to", {"targetMm": 20.0})
        # 降能量方向的动作仍然可达 —— 闸门不该把人锁在外面。
        assert session.execute("gripper.disable", {}) is None
        assert session.execute("gripper.release", {}) is None

        assert session.execute("gripper.reset_stop", {}) is None
        assert wait_for(lambda: not session.estopped())
    finally:
        session.close()


def test_estop_is_engaged_within_one_tick(tmp_path: Path) -> None:
    """§4.2: 急停不排队, tick 在**一个周期内**就要读到它。"""
    from litearm_studio_daemon.gripper.backend.sim import SimBackend

    now = [0.0]
    backend = SimBackend(clock=lambda: now[0])
    signals = Recorder()
    loop = WorkerLoop(backend, signals, clock=lambda: now[0],
                      sleep=lambda _s: None, watchdog_s=None)
    loop.set_allow_factory(True)
    loop.submit(cmd.Connect())
    loop.tick_once(0.005)
    loop.submit(cmd.Enable())
    for _ in range(5):
        now[0] += 0.005
        loop.tick_once(0.005)
    assert loop.enabled, "前置条件: 电机已使能"

    loop.estop("单测急停")
    now[0] += 0.005
    loop.tick_once(0.005)

    assert loop.estopped
    assert not loop.enabled, "急停必须在一个 tick 内失能"
    assert not backend._enabled
    assert any(e[0] == "fault" for e in signals.events)


def test_probe_can_be_aborted_by_an_estop(tmp_path: Path) -> None:
    """§7: 标定探测跑到一半撞上急停, 探测必须被丢掉。"""
    from litearm_studio_daemon.gripper.backend.sim import SimBackend

    # 时钟必须往前走: 仿真的状态帧按 dt 累积, 而冻结的时钟等于"电机不回帧" ——
    # 那种状态下探测现在会被拒绝, 见
    # test_zero_is_refused_before_a_position_has_been_read。
    now = [0.0]

    def clock() -> float:
        now[0] += 0.005
        return now[0]

    backend = SimBackend(clock=clock)
    loop = WorkerLoop(backend, Recorder(), clock=clock, sleep=lambda _s: None,
                      watchdog_s=None)
    loop.submit(cmd.Connect())
    loop.tick_once(0.005)
    loop.submit(cmd.Enable())
    loop.tick_once(0.005)
    assert loop._have_position, "使能之后应当已经收到状态帧, 否则探测会被拒绝"
    loop.submit(cmd.StartGuidedCalibration(reversed_mount=False))
    for _ in range(20):
        loop.tick_once(0.005)
    assert loop.probe is not None, "探测应当已经开始"

    loop.estop("单测急停")
    loop.tick_once(0.005)
    assert loop.probe is None, "急停之后不该还留着探测状态机"
    assert not loop.enabled


def test_the_tick_is_the_keepalive(tmp_path: Path) -> None:
    """§5.2 第 3 步与 D9: tick 就是心跳, 使能期间不能出现 >0.4s 的空档。"""
    session = make_session(tmp_path)
    try:
        connect(session)
        session.execute("gripper.enable", {})
        assert wait_for(lambda: session.state() and session.state()["enabled"])
        gaps: List[int] = []
        for _ in range(5):
            before = session.loop.ticks
            time.sleep(0.1)
            gaps.append(session.loop.ticks - before)
        assert session.loop.enabled, "采样期间被看门狗停掉了"
        # 200Hz × 0.1s = 20 拍; 留足调度余量, 但空档必须远小于 0.4s 的失能窗口
        # (0.4s = 80 拍)。取 10 拍 = 50ms, 是那个窗口的 1/8。
        assert min(gaps) >= 10, f"tick 出现空档: {gaps}"
    finally:
        session.close()


# ------------------------------------------------------------------ 设备身份

def test_connect_can_pin_a_channel_and_ids_and_persists_them(tmp_path: Path) -> None:
    store = ChannelStore(tmp_path / "gripper.json")
    session = GripperSession(fake=True, store=store)
    try:
        assert session.execute("gripper.connect",
                               {"channel": "can1", "canId": 9, "mount": "reverse"}) == {
            "started": True}
        assert wait_for(session.connected)
        info = session.conn_info()
        assert info["channel"] == "can1"
        assert info["canId"] == 9
        assert info["mount"] == "reverse"
        # 重启后回到同一个通道 (§5.6)。
        assert store.last_channel() == "can1"
        assert store.get("can1").can_id == 9
        with pytest.raises(ValueError):
            session.execute("gripper.connect", {"mount": "sideways"})
        with pytest.raises(ValueError):
            session.execute("gripper.connect", {"canId": 0x800})
    finally:
        session.close()


def test_reconfiguring_a_live_link_is_refused(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    try:
        connect(session)
        with pytest.raises(ValueError):
            session.execute("gripper.connect", {"channel": "can1"})
    finally:
        session.close()


def test_the_watchdog_stops_a_client_that_went_away(tmp_path: Path) -> None:
    """§5.2 第 3 步: 上位机不再说话 3 秒 ⇒ 停止运动 (关掉的标签页不能夹着东西)。

    ⚠ 与老控制台不同的一点: 看门狗**只降能量, 不结束会话**。浏览器刷新会短暂地
    没有客户端, 那种情况下夹爪必须还能用 (臂那边"客户端断开不杀会话"是同一条纪律)。
    """
    from litearm_studio_daemon.gripper import constants
    from litearm_studio_daemon.gripper.backend.sim import SimBackend

    now = [0.0]
    backend = SimBackend(clock=lambda: now[0])
    signals = Recorder()
    loop = WorkerLoop(backend, signals, clock=lambda: now[0],
                      sleep=lambda _s: None, watchdog_s=0.05)
    loop.submit(cmd.Connect())
    loop.tick_once(0.005)
    loop.submit(cmd.Enable())
    loop.tick_once(0.005)
    assert loop.enabled

    now[0] += constants.GUI_WATCHDOG_S + 1.0
    loop.tick_once(0.005)
    assert not loop.enabled, "心跳超时必须降能量"
    assert not backend._enabled
    assert any(e[0] == "alert" and e[1] == "fatal" for e in signals.events)

    # 会话还活着: 心跳回来之后还能再使能。
    assert not loop.stopping, "看门狗不该结束会话"
    loop.submit(cmd.Heartbeat())
    loop.submit(cmd.Enable())
    loop.tick_once(0.005)
    assert loop.enabled


def test_a_connected_client_keeps_the_gripper_energized(tmp_path: Path) -> None:
    """有客户端连着时, 服务器会持续喂心跳 —— 安静的浏览器不算掉线。"""
    session = make_session(tmp_path)
    try:
        session.loop._watchdog_s = 0.2      # 短窗口, 免得这条用例真的等 3 秒
        connect(session)
        session.execute("gripper.enable", {})
        assert wait_for(lambda: session.state() and session.state()["enabled"])
        deadline = time.monotonic() + 0.8
        while time.monotonic() < deadline:
            session.heartbeat()
            time.sleep(0.05)
        assert session.loop.enabled, "喂着心跳却被看门狗放掉了电"
    finally:
        session.close()


def test_no_heartbeat_disables_but_does_not_end_the_session(tmp_path: Path) -> None:
    session = make_session(tmp_path)
    try:
        # 用一个短看门狗, 免得这条用例真的等 3 秒。
        session.loop._watchdog_s = 0.2
        connect(session)
        session.execute("gripper.enable", {})
        assert wait_for(lambda: session.state() and session.state()["enabled"])
        assert wait_for(lambda: not session.loop.enabled, timeout=3.0), \
            "没有心跳时应当降能量"
        assert not session.loop.stopping
        # 心跳回来之后还能继续用。
        session.heartbeat()
        session.execute("gripper.enable", {})
        assert wait_for(lambda: session.loop.enabled)
    finally:
        session.close()


def test_worker_thread_never_leaks_an_exception(tmp_path: Path) -> None:
    """tick 线程抛栈 = 电机带着最后一帧继续跑 —— 这条钉住"抛不出去"。"""
    session = make_session(tmp_path)
    try:
        connect(session)
        session.loop.backend.inject = lambda **kw: (_ for _ in ()).throw(
            RuntimeError("boom"))
        session.execute("gripper.move_to", {"targetMm": 10.0})
        time.sleep(0.1)
        assert session.loop.ticks > 0
        assert threading.current_thread().is_alive()
    finally:
        session.close()


def test_a_dead_tick_thread_is_replaced_by_the_next_connect(tmp_path: Path) -> None:
    """tick 线程自己死了之后, 会话必须还能连上, 而不是永远卡在 connecting。

    `run()` 的 finally 会 teardown —— 那是一次性闩锁, 同一个 loop 不能再跑; 线程死掉
    之后引用却还在, 于是 `start()` 以为"已经有线程"而不做事, `gripper.connect` 把
    Connect 塞进一个没人抽的队列。对外表现是 `started: true` + 永远 connecting,
    连急停都没有 tick 去读那个事件。
    """
    session = make_session(tmp_path)
    try:
        connect(session)
        assert wait_for(lambda: session.loop.ticks > 0)

        def boom(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("simulated SDK failure")

        session.loop.backend.poll = boom          # type: ignore[method-assign]
        assert wait_for(lambda: not session.connected(), timeout=5.0), \
            "连续 tick 失败之后应当断开"

        assert session.execute("gripper.connect", {}) == {"started": True}
        assert wait_for(session.connected, timeout=5.0), \
            f"没有换掉死掉的 tick 线程: {session.conn_info()}"
    finally:
        session.close()


def test_reconfiguring_while_the_old_loop_is_busy_is_refused(tmp_path: Path) -> None:
    """旧线程停不下来时不许再建一个 backend —— 一把夹爪只能有一个说话的人。

    真机上 `backend.connect` 会在 CAN bring-up 里阻塞几秒, 而 `_stop_thread` 的 join
    上限是 5s。以前这里直接丢掉返回值继续建新 loop, 于是两个 LiteGrip 对象同时活着
    (D2/D7 明确禁止), 旧 loop 的帧还会继续往外发。
    """
    session = make_session(tmp_path)
    try:
        connect(session)
        session.execute("gripper.disconnect", {})
        assert wait_for(lambda: not session.connected())

        def slow_connect() -> None:
            time.sleep(6.5)

        session.loop.backend.connect = slow_connect   # type: ignore[method-assign]
        session.execute("gripper.connect", {})
        time.sleep(0.3)          # 让 tick 线程真的陷进那个阻塞调用里

        with pytest.raises(GripperBusyError):
            session.execute("gripper.connect", {"channel": "can2"})
        # 拒绝之后仍然只有一个活的 loop 对象, 而且没有第二个线程。
        assert session.loop.backend is not None
    finally:
        session.close()


def test_zero_is_refused_before_a_position_has_been_read(tmp_path: Path) -> None:
    """使能了但还没有位置帧时不许开探测 —— `0.0 rad` 是占位符, 不是读数。

    SDK 在第一帧状态到达之前一直返回 `0.0 rad`, 而 `0.0` 落在行程**里面**: 换算出来
    是个看得过去的毫米数, 所以它不会因为"离谱"被拦下。探测却把它当参考起点
    (`_ref_rad = entry + step`)、以 kp=60 和 `ungated=True` 发帧, 直到下一个步进点
    才重新锚定 —— 也就是真机上"使能后立刻标定"或"链路连着但电机不回帧"的那一拍。
    """
    session = make_session(tmp_path)
    try:
        connect(session)
        # 链路"连着"但电机不回答: 真机上的 RX 断线 / CAN ID 不匹配。
        session.loop.backend.no_frames = True
        assert session.execute("gripper.enable", {}) == {"enabled": True}
        assert wait_for(lambda: session.loop.enabled)
        assert not session.loop._have_position, "这条用例需要'还没读到位置'的状态"

        before = session.loop.probe_seq
        with pytest.raises(GripperCalibrationError, match="位置"):
            session.execute("gripper.zero", {"travelMm": 85.0})
        assert session.loop.probe_seq == before, "被拒绝的标定不该开探测"
        assert session.loop.measured_rad() is None

        # worker 那道门是权威, 直接钉住它: 会话那道只是把理由提前说清楚。
        session.loop._start_probe(guided=True)
        assert session.loop.probe is None
        assert session.loop.probe_seq == before
    finally:
        session.close()


def test_channel_config_is_a_frozen_record() -> None:
    record = ChannelConfig(channel="can0")
    with pytest.raises(Exception):
        record.travel_mm = 10.0            # type: ignore[misc]
    assert record.mounted is False
    assert ChannelConfig(channel="can0", mount="normal").mounted is True
    assert ChannelConfig(channel="can0").to_wire()["canId"] == 8

# ------------------------------------------------------------------ 告警的 kind

def test_alerts_carry_a_wire_kind_for_the_browser_to_translate(tmp_path: Path) -> None:
    """tick 线程上的拒绝没有 `res` 可回 —— kind 是前端唯一能翻译的字段。"""
    frames: List[dict] = []
    session = make_session(tmp_path, on_event=frames.append)
    try:
        session._on_alert("warn", "「闭合」被拒绝：标称模板（从未实测）",
                          "GripperCalibrationError")
        session._on_alert("info", "已记录张开极限", None)
        session._on_fault(0x9, "欠压故障 (UV)", "请检查夹爪 24V 供电")
        session._on_fault(0x1, "已使能", "")

        alerts = [f for f in frames if f["t"] == "gripper_alert"]
        assert alerts[0]["kind"] == "GripperCalibrationError"
        assert alerts[0]["text"].startswith("「闭合」被拒绝")
        assert alerts[1]["kind"] is None          # 没有可推的 kind 就不编一个
        assert alerts[2]["kind"] == "GripperFaultActiveError"
        assert alerts[2]["code"] == 0x9
        assert alerts[3]["kind"] is None          # 0x1 是"已使能"，不是故障
        assert alerts[3]["level"] == "info"
    finally:
        session.close()


def test_a_refused_motion_takes_its_kind_from_the_gate(tmp_path: Path) -> None:
    """把闸门推到 BLOCKED，再让指令走到 tick 上被拒 —— 帧里应带标定类错误。"""
    from litearm_studio_daemon.gripper.core import commands as cmd
    from litearm_studio_daemon.gripper.core.worker import GateState

    session = make_session(tmp_path)
    try:
        connect(session)
        session.execute("gripper.enable", {})
        assert wait_for(lambda: session.state() and session.state()["enabled"])
        # 一份通道不匹配的标定：解析有效但被拒 → 闸门 BLOCKED。
        bad = tmp_path / "foreign.json"
        bad.write_text(json.dumps({
            "channel": "can9",
            "zero_position_rad": 1.7, "max_position_rad": -0.06, "rad_to_mm": 46.7,
        }), encoding="utf-8")
        session.loop.submit(cmd.LoadCalibration(str(bad)))
        assert wait_for(lambda: session.gate() is GateState.BLOCKED), session.gate()

        frames: List[dict] = []
        session.add_listener(frames.append)
        session.loop.submit(cmd.Open())
        assert wait_for(lambda: any(
            f["t"] == "gripper_alert" and f.get("kind") == "GripperCalibrationError"
            for f in frames)), frames
    finally:
        session.close()
