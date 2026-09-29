"""会话单测 —— 命令白名单、运动互斥、参数校验, 以及 `--fake` 模式的全流程。

全部用例都在 `litearm.testing.FakeTransport` 上跑, **不碰真硬件**、不需要串口。
"""
from __future__ import annotations

import threading
import time
from typing import Optional

import litearm
import pytest
from litearm import Arm

from litearm_studio_daemon import activation
from litearm_studio_daemon.errors import (
    MotionBusyError,
    NotConnectedCommandError,
    UnknownCommandError,
)
from litearm_studio_daemon.session import (
    COMMANDS,
    ENERGY_DOWN_COMMANDS,
    MOTION_COMMANDS,
    Session,
    build_fake_transport_factory,
)

Q7 = [0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
POSE = [0.30, 0.0, 0.40, 3.1416, 0.0, 0.0]


def _wait(pred, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def fake_session():
    """已连上的假会话 —— 用完必须 `close()` (它带一条轮询线程 + 一个执行器)。"""
    s = Session(fake=True, poll_period=0.02, state_push_interval=0.05)
    assert s.connect() is True
    assert _wait(lambda: s.connected), f"假会话没连上: {s.arm_info()}"
    try:
        yield s
    finally:
        s.close()


# ------------------------------------------------------------------ 连接/断开

def test_fake_connect_reports_firmware_and_joint_count(fake_session: Session) -> None:
    info = fake_session.arm_info()
    assert info["status"] == "connected"
    assert info["firmware"].startswith("Litearm")
    assert info["n"] == 7
    assert info["error"] is None


def test_connect_is_idempotent(fake_session: Session) -> None:
    assert fake_session.connect() is True       # 已连接 ⇒ no-op
    assert fake_session.connected is True


def test_connect_without_device_lands_in_error_not_crash() -> None:
    """没有设备时把原因报出来, 而不是抛栈 —— 前端要看到「为什么没连上」。"""
    s = Session(port_finder=lambda: None)
    try:
        assert s.connect() is True              # 立刻回: 握手在命令执行器上跑
        assert _wait(lambda: s.arm_info()["status"] == "error", timeout=5.0)
        assert "未发现 STM32 CDC" in (s.arm_info()["error"] or "")
    finally:
        s.close()


def test_disconnect_is_idempotent(fake_session: Session) -> None:
    assert fake_session.disconnect() is True
    assert fake_session.disconnect() is False   # 已经断了 ⇒ no-op


# ------------------------------------------------------------ 退出前降能量 (#14)

def _record_disable(s: Session, *, raises: bool = False) -> list[str]:
    """把已连接会话的 `arm.disable` 换成记录器 (可选择让它抛)。"""
    arm = s._arm
    seen: list[str] = []
    real = arm.disable

    def fake_disable() -> None:
        seen.append("disable")
        if raises:
            raise litearm.TransportError("链路已断")
        real()

    arm.disable = fake_disable  # type: ignore[method-assign]
    return seen


def test_close_de_energizes_the_arm() -> None:
    """进程收尾必须真的降能量 —— 不能把"电机是否还使能"甩给不存在的调用方。"""
    s = Session(fake=True)
    try:
        assert s.connect() is True
        assert _wait(lambda: s.connected), "假会话没连上"
        seen = _record_disable(s)
        s.close()
        assert seen == ["disable"], "close() 没有失能"
    finally:
        s.close()


def test_disconnect_does_not_de_energize() -> None:
    """断开 ≠ 退出: 原则 4 要的是"关窗口不打断会话", 所以 `disconnect()` 不降能量。"""
    s = Session(fake=True)
    try:
        assert s.connect() is True
        assert _wait(lambda: s.connected), "假会话没连上"
        seen = _record_disable(s)
        assert s.disconnect() is True
        assert seen == [], "disconnect() 不该失能"
    finally:
        s.close()


def test_close_survives_a_failing_de_energize() -> None:
    """链路已断时 `disable()` 会抛 —— 收尾不许因此中断或抛栈。"""
    s = Session(fake=True)
    try:
        assert s.connect() is True
        assert _wait(lambda: s.connected), "假会话没连上"
        seen = _record_disable(s, raises=True)
        s.close()                                # 不抛
        assert seen == ["disable"]
    finally:
        s.close()


def test_disable_on_exit_false_keeps_the_arm_enabled() -> None:
    """`--keep-enabled` 的语义: 明确要求保留使能时才跳过降能量。"""
    s = Session(fake=True, disable_on_exit=False)
    try:
        assert s.connect() is True
        assert _wait(lambda: s.connected), "假会话没连上"
        seen = _record_disable(s)
        s.close()
        assert seen == [], "disable_on_exit=False 时不该失能"
    finally:
        s.close()


def test_disconnect_during_the_handshake_cancels_the_connect(monkeypatch,
                                                             ) -> None:
    """握手在途时按断开, 不许被握手完成覆盖成 connected。

    ⚠ 上一版 `disconnect()` 只看「这一刻有没有 arm」, 而握手期间 arm 还是 None ⇒
    它报了 disconnected 就返回, 随后 `_open` 把会话连上 —— 用户看到已断开, 串口却
    被占着。这条用例把「代次作废」钉住。
    """
    real_connect = Arm.connect

    def slow_connect(self, *args, **kwargs):
        time.sleep(0.4)
        return real_connect(self, *args, **kwargs)

    monkeypatch.setattr(Arm, "connect", slow_connect)
    s = Session(fake=True)
    try:
        assert s.connect() is True
        assert s.arm_info()["status"] == "connecting"
        assert s.disconnect() is True          # 取消了一次在途握手, 不是 no-op
        assert s.arm_info()["status"] == "disconnected"
        time.sleep(0.6)                        # 等握手真的跑完
        info = s.arm_info()
        assert info["status"] == "disconnected", f"握手把断开覆盖了: {info}"
        assert s.connected is False
    finally:
        s.close()


def test_a_handshake_failure_after_disconnect_is_not_reported_as_error(
        monkeypatch) -> None:
    """断开之后的握手失败不许把状态改写成 error —— 用户按的是断开, 不是连接失败。"""

    def failing_connect(self, *args, **kwargs):
        time.sleep(0.3)
        raise litearm.TransportError("握手失败")

    monkeypatch.setattr(Arm, "connect", failing_connect)
    s = Session(fake=True)
    try:
        assert s.connect() is True
        assert s.disconnect() is True
        time.sleep(0.5)
        info = s.arm_info()
        assert info["status"] == "disconnected", f"被改成了 {info['status']}"
        assert info["error"] is None
    finally:
        s.close()


# ------------------------------------------------------------------ 命令白名单

def test_unknown_command_is_rejected(fake_session: Session) -> None:
    with pytest.raises(UnknownCommandError):
        fake_session.execute("launch_missiles", {})


def test_whitelist_has_no_teleop_or_trajectory_leftovers() -> None:
    """范围收敛的哨兵: 白名单里不许再出现遥操/轨迹类的入口。"""
    for banned in ("enter_teleop", "exit_teleop", "play_trajectory",
                   "record_trajectory", "list_trajectories"):
        assert banned not in COMMANDS


def test_commands_require_a_connected_session() -> None:
    s = Session(port_finder=lambda: None)
    try:
        with pytest.raises(NotConnectedCommandError):
            s.execute("enable", {})
    finally:
        s.close()


# ------------------------------------------------------------------ 运动互斥

def test_second_motion_command_is_rejected_while_one_is_in_flight(
        fake_session: Session) -> None:
    fake_session._motion_count = 1              # 模拟"已有运动在途"
    try:
        with pytest.raises(MotionBusyError):
            fake_session.execute("movej", {"q": Q7})
        assert fake_session.motion_in_flight() is True
    finally:
        fake_session._motion_count = 0


def test_energy_down_commands_are_never_blocked_by_the_motion_mutex(
        fake_session: Session) -> None:
    """急停/失能必须永远可达 —— 这正是原则 4 要的。"""
    fake_session._motion_count = 1
    try:
        fake_session.execute("estop", {})       # 不抛
    finally:
        fake_session._motion_count = 0


def test_energy_down_commands_run_while_a_motion_is_still_in_flight(
        fake_session: Session) -> None:
    """急停不许**排队**等运动结束 (计划 3.2「永远可达」)。

    ⚠ 只在准入处豁免运动互斥是不够的: 所有 SDK 调用原本共用同一条单线程执行器,
    于是 `estop` 虽然过了互斥判定, 仍要等阻塞到 `move_timeout` 的 `movej` 结束。
    上一版实测按住 2s 的 movej 时 `estop` 要等 1.8s 才返回。这条用例把「并行」钉住。
    """
    arm = fake_session._arm
    real_movej = arm.movej
    started = threading.Event()

    def slow_movej(*args, **kwargs):
        started.set()
        time.sleep(0.6)
        return real_movej(*args, **kwargs)

    arm.movej = slow_movej  # type: ignore[method-assign]
    mover = threading.Thread(
        target=lambda: fake_session.execute("movej", {"q": Q7, "speed": 0.3}))
    mover.start()
    try:
        assert started.wait(2.0), "movej 没跑起来 —— 用例前提不成立"
        t0 = time.monotonic()
        assert fake_session.execute("estop", {}) is None
        estop_dt = time.monotonic() - t0
        # 运动仍在飞 —— 急停是在它**中间**执行的, 不是等它结束。
        assert fake_session.motion_in_flight() is True
        assert estop_dt < 0.3, f"estop 排在了运动后面 ({estop_dt:.3f}s)"
    finally:
        mover.join()


def test_energy_down_set_is_exactly_estop_and_disable() -> None:
    """哨兵: 这条并行通道只收安全动作, 不许顺手把别的命令塞进来。

    ⚠ `zero_g_stop` 虽然也降能量, 但它会改写会话自己的零重力记录, 与状态轮询共享
    状态, 故**不**走并行通道 —— 加进来会让状态串出现竞态。
    """
    assert ENERGY_DOWN_COMMANDS == frozenset({"estop", "disable"})


def test_motion_commands_set_is_exactly_the_three_motion_entries() -> None:
    assert MOTION_COMMANDS == frozenset({"home", "movej", "movel"})


def test_motion_flag_returns_to_false_after_a_real_fake_move(
        fake_session: Session) -> None:
    fake_session.execute("enable", {})
    fake_session.execute("movej", {"q": Q7, "speed": 0.3})
    assert fake_session.motion_in_flight() is False


# ------------------------------------------------------------------ 参数校验

@pytest.mark.parametrize("params", [
    {},                                     # 缺 q
    {"q": []},                              # 空
    {"q": [0.1, "x"]},                      # 非数值
    {"q": 1.0},                             # 不是数组
])
def test_movej_rejects_bad_joint_vectors(fake_session: Session, params: dict) -> None:
    with pytest.raises(ValueError):
        fake_session.execute("movej", params)


@pytest.mark.parametrize("pose", [
    [0.1, 0.2, 0.3],                        # 只有 3 个
    POSE + [0.0],                           # 7 个
    [0.1, 0.2, 0.3, 0.0, 0.0, "x"],         # 非数值
])
def test_movel_requires_a_six_tuple_pose(fake_session: Session, pose: list) -> None:
    with pytest.raises(ValueError):
        fake_session.execute("movel", {"pose": pose})


@pytest.mark.parametrize("percent", [-1, 101, 1.5, True, "50"])
def test_set_speed_requires_integer_percent(fake_session: Session,
                                            percent: object) -> None:
    with pytest.raises(ValueError):
        fake_session.execute("set_speed", {"percent": percent})


@pytest.mark.parametrize("speed", [-0.1, 1.5])
def test_move_speed_must_be_a_trajectory_ratio(fake_session: Session,
                                               speed: float) -> None:
    with pytest.raises(ValueError):
        fake_session.execute("movej", {"q": Q7, "speed": speed})


# ------------------------------------------------------------------ 假模式全流程

def test_fake_end_to_end_flow(fake_session: Session) -> None:
    """连接 → 使能 → 关节运动 → 状态 → 调速 → 回零 → 急停 → 断开。"""
    fake_session.execute("enable", {})

    fake_session.execute("movej", {"q": Q7, "speed": 0.3})
    # ⚠ `state()` 读的是 **50Hz 轮询线程的缓存帧**, 而 `execute("movej")` 返回的是 SDK
    # 自己的收尾帧 —— 两者之间有一个最多一拍 (20ms) 的窗口。直接断言 `state()["q"]`
    # 会读到时**运动前**的那一帧: 实测 40 次单跑里红 13 次 (整套用例并行时更容易红),
    # 而这条用例又挂在必需的 `test` 检查里。故等推送追上, 而不是削弱断言。
    assert _wait(lambda: (fake_session.state() or {}).get("q", [None])[0]
                 == pytest.approx(0.1, abs=1e-3)), f"状态没跟上运动: {fake_session.state()}"
    state = fake_session.state()
    assert state is not None
    assert state["q"][0] == pytest.approx(0.1, abs=1e-3)
    assert state["state"] in {"ready", "moving", "disabled", "zero_gravity", "fault"}

    tcp = fake_session.execute("get_tcp", {})
    assert tcp is not None and len(tcp) == 6

    fake_session.execute("set_speed", {"percent": 50})

    fake_session.execute("home", {})
    assert fake_session.execute("estop", {}) is None
    fake_session.execute("clear_faults", {})
    assert fake_session.execute("disable", {}) is None

    assert fake_session.disconnect() is True


def test_zero_gravity_start_stop_marks_the_state(fake_session: Session) -> None:
    fake_session.execute("enable", {})
    fake_session.execute("zero_g_start", {})
    assert _wait(lambda: (fake_session.state() or {}).get("state") == "zero_gravity")
    fake_session.execute("zero_g_stop", {})
    assert _wait(lambda: (fake_session.state() or {}).get("state") != "zero_gravity")


# ------------------------------------------------------------------ 状态推送

def test_state_push_rate_feeds_the_3d_preview() -> None:
    """哨兵: 推送默认间隔必须快到能撑起 3D 预览。

    ⚠ 这条**不是**形式主义。旧客户端给 3D 预览单独留了一条直读 SDK 缓存的 60Hz 快通道;
    换成 daemon 推送之后, 把默认值定成 10Hz 就是**肉眼可见的卡顿**, 而"状态与 3D 实时
    刷新"是这一版的明确目标。改动这个常量会红, 逼人先想清楚 3D 那条订阅靠什么喂。
    """
    from litearm_studio_daemon.session import STATE_PUSH_INTERVAL_S

    assert STATE_PUSH_INTERVAL_S <= 1 / 30, (
        f"默认推送间隔 {STATE_PUSH_INTERVAL_S}s 太慢, 3D 预览会卡"
        f" (旧客户端给 3D 的是一条 60Hz 快通道)")


def test_state_is_pushed_to_listeners(fake_session: Session) -> None:
    seen: list[dict] = []
    fake_session.add_listener(lambda ev: seen.append(ev))
    assert _wait(lambda: any(e.get("t") == "state" for e in seen)), \
        "50Hz 轮询应至少推出一帧状态"


def test_a_broken_listener_does_not_kill_the_poll_thread(fake_session: Session) -> None:
    def boom(_ev: dict) -> None:
        raise RuntimeError("监听器炸了")

    fake_session.add_listener(boom)
    good: list[dict] = []
    fake_session.add_listener(lambda ev: good.append(ev))
    assert _wait(lambda: any(e.get("t") == "state" for e in good)), \
        "前一个监听器抛异常后, 后面的监听器仍应收到帧"


def test_state_dict_has_the_contracted_keys(fake_session: Session) -> None:
    assert _wait(lambda: fake_session.state() is not None)
    doc: Optional[dict] = fake_session.state()
    assert doc is not None
    for key in ("q", "dq", "tau", "errs", "temps", "fault", "state",
                "mode", "modeName", "flags", "enabled", "cartBusy", "faulted"):
        assert key in doc, f"状态帧缺字段 {key}"


# --------------------------------------------- 链路存活与断线自愈 (issue #48)
#
# 这一组的形状全部来自 issue #48 的实测: 设备重新枚举后, 会话继续报 `connected`、
# 广播重放最后一帧好数据, 而每条命令都撞 `TransportError: 写失败: [Errno 5]`。
# 判据分三层, 三条都要有, 缺一条就有一段是"看不见"的:
#   ① 状态帧不再到达 (`_poll_once` + `LINK_STALE_AFTER_S`);
#   ② 命令撞上传输层失败 (`execute` 里的 `except litearm.TransportError`);
#   ③ 断线后自愈, 或者明确告诉操作者没救回来 (`_recover_link`)。


def _connected_session(**kwargs) -> Session:
    """连上的假会话 —— 存活/自愈用例的共用前置 (默认关掉自愈, 除非显式要)。"""
    kwargs.setdefault("fake", True)
    kwargs.setdefault("poll_period", 0.02)
    kwargs.setdefault("state_push_interval", 0.05)
    kwargs.setdefault("reconnect", False)
    s = Session(**kwargs)
    assert s.connect() is True
    assert _wait(lambda: s.connected), f"假会话没连上: {s.arm_info()}"
    return s


def _freeze_state_stream(s: Session, monkeypatch, *, age: float = 60.0) -> None:
    """让"最近一帧状态帧"停在过去 —— 等价于固件那条 100Hz 被动流断了。

    ⚠ 判据是 `Msg.timestamp` (SDK 记的**到达时刻**), 所以只冻结内容是不够的: 这里连
    时刻一起冻住。`age` 用 60s 这样"一眼就是死"的差值, 免得与 `link_stale_after` 的
    边界纠缠 (边界本身由 `test_a_state_stream_...` 的窗口参数管)。
    """
    from litearm.arm import Msg

    real = s._arm.get_state
    frozen = Msg(value=real().value, hz=0.0, timestamp=time.monotonic() - age)
    monkeypatch.setattr(s._arm, "get_state", lambda *a, **k: frozen)


def test_a_state_stream_that_stops_marks_the_link_lost(monkeypatch) -> None:
    """① 状态帧不再到达 ⇒ 不再报 connected, 且 `conn` 帧里 `error` 有原因、`port` 清空。

    issue #48 的实测形状: `/proc/<pid>/fd/10 -> /dev/ttyACM1 (deleted)`, 而 `conn` 帧
    继续报 `"status":"connected","port":"/dev/ttyACM1"` 近三个小时。
    """
    s = _connected_session(link_stale_after=0.1)
    try:
        conn_frames: list[dict] = []
        s.add_listener(lambda ev: conn_frames.append(ev) if ev.get("t") == "conn" else None)
        before = s.arm_info()
        assert before["status"] == "connected" and before["port"] == "fake"

        _freeze_state_stream(s, monkeypatch)
        assert _wait(lambda: s.arm_info()["status"] == "error", timeout=5.0), \
            f"链路断了却还在报 {s.arm_info()['status']}"
        info = s.arm_info()
        assert s.connected is False
        assert info["port"] is None, f"端口必须清空 (报的是已经消失的口): {info}"
        assert info["error"] and "链路已断开" in info["error"], info
        assert "状态帧" in info["error"], f"原因要能看懂: {info['error']}"
        assert any(f["status"] == "error" and f["error"] for f in conn_frames), \
            f"没推过带原因的 conn 帧: {conn_frames}"
        assert s.state() is None, "断线之后不许再留着最后一帧好数据"
        assert s._recovering is False, "reconnect=False 时不该去自愈"
    finally:
        s.close()


def test_a_command_transport_error_marks_the_link_lost(monkeypatch) -> None:
    """② 命令撞上传输层失败 ⇒ 同一条命令照旧报错, 但会话当场落 error 态。

    上一版这里只看 `_status` 这个标志位, 于是"标志位说已连接、每条命令都 [Errno 5]"
    能一直持续下去 (issue #48 第 3 层)。
    """
    s = _connected_session()
    try:
        # 设备没了: 桩的读写路径都抛 `TransportError` (与真机 `[Errno 5]` 同一形状)。
        s._arm._tr.dfu_gone = True
        with pytest.raises(litearm.TransportError):
            s.execute("enable", {})
        info = s.arm_info()
        assert info["status"] == "error", info
        assert s.connected is False
        assert info["port"] is None
        assert "enable" in (info["error"] or ""), f"要说清是哪条命令: {info['error']}"
        # 之后的命令是"未连接", 不再重复撞链路 —— 前端与守护进程口径一致。
        with pytest.raises(NotConnectedCommandError):
            s.execute("get_tcp", {})
    finally:
        s.close()


def test_a_flash_erase_stall_is_not_read_as_a_dead_link(monkeypatch) -> None:
    """固件整扇区擦写期间状态流会断 **但它没死** —— 判活必须让路。

    依据在 SDK 自己的取证里: 固件自述擦写"~1s CPU 全停", 而给擦写开的看门狗豁免把它
    放宽到 ~8s (`hw_watchdog.h:28`)。不让路的话, 设置页按一次「保存参数」就会把好好的
    会话拆掉重连 —— 那比 #48 本身还糟。
    """
    s = _connected_session(reconnect=False, link_stale_after=0.1)
    try:
        # 帧停在**此刻** (不是"停在很久以前"): 擦写是"从现在起不再有新帧"。
        _freeze_state_stream(s, monkeypatch, age=0.0)
        assert s.execute("save_params", {}) is None
        time.sleep(0.5)
        info = s.arm_info()
        assert info["status"] == "connected", f"擦写被读成了断线: {info}"
        assert info["error"] is None
    finally:
        s.close()


def test_the_flash_grace_expires_and_a_real_death_is_still_caught(monkeypatch) -> None:
    """让路窗口**有界**: 窗口过了之后, 真的没了就照样判死 (别让步成永久失明)。"""
    from litearm_studio_daemon import session as session_mod

    monkeypatch.setattr(session_mod, "FLASH_STALL_GRACE_S", 0.2)
    s = _connected_session(reconnect=False, link_stale_after=0.1)
    try:
        _freeze_state_stream(s, monkeypatch, age=0.0)
        assert s.execute("save_params", {}) is None
        assert _wait(lambda: s.arm_info()["status"] == "error", timeout=5.0), \
            f"让路窗口过后仍不判死: {s.arm_info()}"
        assert "状态帧" in (s.arm_info()["error"] or "")
    finally:
        s.close()


def test_the_link_is_not_declared_dead_while_frames_keep_arriving() -> None:
    """保真哨兵: 帧还在到达时不许报断线 —— 误判会把好好的会话拆掉。"""
    from litearm_studio_daemon.session import LINK_STALE_AFTER_S

    assert LINK_STALE_AFTER_S >= 1.0, (
        "阈值不能压到一两百毫秒: 那点窗口分不清'链路断了'与'这一拍被负载拖慢', "
        "而后者的代价是把一条好链路关掉重连")
    s = _connected_session(link_stale_after=0.2)
    try:
        time.sleep(1.0)
        assert s.arm_info()["status"] == "connected", s.arm_info()
        assert s.state() is not None
    finally:
        s.close()


def test_recovery_re_establishes_the_session_without_a_manual_reconnect(monkeypatch) -> None:
    """③ 断线后自愈: 重新解析端口、重建会话、重新推状态 —— 不必手工断开+连接。"""
    s = _connected_session(reconnect=True, reconnect_period=0.05, reconnect_window=5.0,
                           link_stale_after=0.1)
    try:
        assert s._recover_thread is None
        _freeze_state_stream(s, monkeypatch)
        # 自愈换了一条**新的** `Arm` (旧的那条已经死了), 冻结只作用在旧对象上 ⇒
        # 新链路的帧照常到达, 状态自己回到 connected。
        assert _wait(lambda: s.connected, timeout=10.0), \
            f"没能自愈: {s.arm_info()} / recovering={s._recovering}"
        info = s.arm_info()
        assert info["status"] == "connected" and info["error"] is None, info
        assert info["port"] == "fake", info
        assert info["n"] == 7, info
        assert _wait(lambda: s.state() is not None), "自愈之后状态推送要回来"
        assert s._poll_thread is not None and s._poll_thread.is_alive()
    finally:
        s.close()


def test_recovery_reports_plainly_when_the_window_runs_out(monkeypatch) -> None:
    """③ 自愈失败也必须有结论: 窗口用尽后如实上报, 不是静默重试到天荒地老。"""
    s = _connected_session(reconnect=True, reconnect_period=0.05, reconnect_window=0.3,
                           link_stale_after=0.1)
    try:
        def no_device(self, target):
            raise litearm.TransportError(f"打开串口 {target} 失败: 设备还没回来")

        monkeypatch.setattr(Session, "_dial", no_device)
        _freeze_state_stream(s, monkeypatch)
        assert _wait(lambda: "自动重连" in (s.arm_info()["error"] or ""), timeout=10.0), \
            f"没上报自愈失败: {s.arm_info()}"
        info = s.arm_info()
        assert info["status"] == "error", info
        assert info["port"] is None, info
        assert "设备还没回来" in info["error"], info
        assert s.connected is False
        assert _wait(lambda: not s._recovering), "自愈线程结束了, 标志位要跟着落"
    finally:
        s.close()


def test_recovery_releases_the_dead_link_before_redialing(monkeypatch) -> None:
    """自愈**先关掉死链路**再重试 —— 这条顺序是"同一个节点名回来"能打开的前提。

    SDK 的 `SerialTransport` 有一张**进程内**的 `port -> 持有者` 登记表 (`_claim_port`),
    同一个端口名被另一条活着的链路占着时直接拒开。设备以**同一个名字**重新枚举完全常见
    (机器上只有这一个 CDC 口时必然如此), 不先 `close()` 掉旧句柄, 自愈会永远卡在
    "端口已被本进程内另一个传输占用"上。
    """
    s = _connected_session(reconnect=True, reconnect_period=0.05, reconnect_window=5.0,
                           link_stale_after=0.1)
    old = s._arm
    # ⚠ 传输对象要先抓在手里: `Arm.close()` 会把 `arm._tr` 置成 None (SDK 的收尾语义),
    # 关掉之后再想读"它当时关了没有"就没得读了。
    old_tr = old._tr
    seen: dict = {}

    def dial(self, target):
        seen["old_transport_closed_at_dial"] = old_tr.closed
        return Arm(port=target, transport_factory=build_fake_transport_factory()).connect()

    try:
        monkeypatch.setattr(Session, "_dial", dial)
        _freeze_state_stream(s, monkeypatch)
        assert _wait(lambda: s.connected and "old_transport_closed_at_dial" in seen,
                     timeout=10.0), f"没自愈: {s.arm_info()}"
        assert seen["old_transport_closed_at_dial"] is True, \
            "旧句柄没关就拿去重开 —— 同一个节点名回来时会被进程内登记挡住"
        assert s._arm is not old, "自愈之后必须是**新**的链路对象"
    finally:
        s.close()


def test_recovery_falls_back_to_the_rediscovered_port(monkeypatch) -> None:
    """③ 设备重新枚举 (节点名变了) 时自愈要能跟着走 —— 这是 #48 的实测现场。

    现场: `/dev/ttyACM1` 消失, 板子以 `/dev/ttyACM0` 回来。自愈必须**先放掉旧句柄**
    再按"上次的口 → --port → 自动发现"的顺序试, 否则永远打不开同一个名字的新节点。
    """
    s = Session(port="/dev/ttyACM1", port_finder=lambda: "/dev/ttyACM0",
                poll_period=0.02, state_push_interval=0.05,
                reconnect=True, reconnect_period=0.05, reconnect_window=5.0,
                link_stale_after=0.1)
    #: 板子重新枚举之后, 旧节点名就再也打不开了 —— 自愈只能靠自动发现那条路。
    re_enumerated = {"done": False}

    def dial(self, target):
        if re_enumerated["done"] and target != "/dev/ttyACM0":
            raise litearm.TransportError(f"打开串口 {target} 失败: No such file or directory")
        return Arm(port=target,
                   transport_factory=build_fake_transport_factory()).connect()

    monkeypatch.setattr(Session, "_dial", dial)
    try:
        assert s.connect() is True
        assert _wait(lambda: s.connected), f"没连上: {s.arm_info()}"
        assert s.arm_info()["port"] == "/dev/ttyACM1"
        re_enumerated["done"] = True
        _freeze_state_stream(s, monkeypatch)
        assert _wait(lambda: s.arm_info()["port"] == "/dev/ttyACM0", timeout=10.0), \
            f"没跟到重新枚举后的节点: {s.arm_info()}"
        assert s.connected is True
        assert s._recover_thread is not None
    finally:
        s.close()


def test_disconnect_cancels_an_in_flight_recovery(monkeypatch) -> None:
    """自愈在途时按断开: 它必须让位, **不许**事后把状态改回 connected。"""
    s = _connected_session(reconnect=True, reconnect_period=0.05, reconnect_window=5.0)
    dials: list[str] = []

    def no_device(self, target):
        dials.append(target)
        raise litearm.TransportError("设备还没回来")

    try:
        monkeypatch.setattr(Session, "_dial", no_device)
        _freeze_state_stream(s, monkeypatch)
        assert _wait(lambda: s._recovering, timeout=5.0), "自愈没起来"
        assert s.disconnect() is True, "取消一次自愈算「停掉了东西」, 不是 no-op"
        assert s.arm_info()["status"] == "disconnected"
        time.sleep(0.4)                       # 给自愈线程留下"事后翻案"的机会
        info = s.arm_info()
        assert info["status"] == "disconnected", f"断开被自愈覆盖了: {info}"
        assert info["error"] is None, info
        assert s.connected is False
    finally:
        s.close()


def test_stopping_the_poll_thread_really_stops_it() -> None:
    """`_stop_polling()` 必须**真的**停掉线程, 不是"等满 1s 然后留着它空转"。

    ⚠ 上一版: 循环判的是 `_stop` (只有整个会话收尾才置), 而 `_stop_polling()` 只清引用
    再 `join(1.0)` ⇒ 每次 `disconnect()` 白等 1s, 每次重连多留一条 50Hz 空转线程。
    断线自愈要反复"停轮询 → 重连 → 再起轮询", 这条泄漏会一次一条地攒下去。
    """
    s = _connected_session()
    try:
        old = s._poll_thread
        assert old is not None and old.is_alive()
        t0 = time.monotonic()
        assert s.disconnect() is True
        assert not old.is_alive(), "轮询线程在 disconnect() 之后还活着"
        assert time.monotonic() - t0 < 0.9, (
            "停轮询不该靠 join 超时兜底 —— 那正是线程没停下来的症状")
    finally:
        s.close()


def test_reconnect_after_disconnect_does_not_pile_up_poll_threads() -> None:
    """连→断→连 之后只许有一条轮询线程 (上一版每轮多留一条)。"""
    s = _connected_session()
    try:
        for _ in range(3):
            assert s.disconnect() is True
            assert s.connect() is True
            assert _wait(lambda: s.connected)
        alive = [th for th in threading.enumerate() if th.name == "litearm-state-poll"]
        assert len(alive) == 1, f"攒下了 {len(alive)} 条轮询线程"
    finally:
        s.close()


def test_enabled_idle_frame_is_pushed_as_ready(fake_session: Session,
                                               monkeypatch) -> None:
    """真机 (`Litearm1.8.0-7J`) 使能且静止的那一帧推出去必须是 `ready` (issue 32)。

    假固件停在 `MOVE_J` (`mode=1`), 复现不了; 这里把真机那一帧注入 `get_state()`,
    再走**整条推送链** (轮询线程 → 监听器 → `/ws`)。前端只认 `ready`/`moving`/
    `zero_gravity` 为可运行, 读到 `disabled` 就把已使能的臂显示成未使能、开关点不动。
    """
    from litearm.arm import Msg
    from litearm.state import JointState, RobotState

    frame = RobotState(mode=0, mode_name="INIT", flags=(1 << 9) | 0b10,
                       flag_names=["WD_TRIPPED"], seq=1,
                       joints=[JointState(tau=0.4, err=1) for _ in range(7)])
    monkeypatch.setattr(
        Arm, "get_state",
        lambda self, *a, **k: Msg(value=frame, hz=100.0, timestamp=time.monotonic()),
    )

    seen: list[dict] = []
    fake_session.add_listener(lambda ev: seen.append(ev))
    assert _wait(lambda: any(
        e.get("t") == "state"
        and e["state"]["state"] == "ready"
        and e["state"]["enabled"] is True
        and e["state"]["mode"] == 0
        for e in seen
    )), f"使能且静止的 INIT 帧没读成 ready: {seen[-1] if seen else None}"


# ------------------------------------------------- 连接收尾的失败必须被看见

def test_connect_reports_the_resolved_port(fake_session: Session) -> None:
    """端口由**会话自己**记 —— SDK 的 `Arm` 没有公开 `port`, 上一版这里恒为 None。"""
    assert fake_session.arm_info()["port"] == "fake"


def test_connect_completion_failure_lands_in_error_not_silence(monkeypatch) -> None:
    """回归用例: 连接**收尾**抛异常时必须落 `error` 态, 而不是静默停在 connected。

    收尾跑在**没人读取的 Future** 上, 上一版让 `AttributeError` 逃出去 ⇒ 前端看到
    `connected`、状态帧却永远不来, 而日志里一个错都没有。
    """
    s = Session(fake=True, poll_period=0.02, state_push_interval=0.05)

    def boom() -> None:
        raise AttributeError("'Arm' object has no attribute 'port'")

    monkeypatch.setattr(s, "_start_polling", boom)
    try:
        assert s.connect() is True
        assert _wait(lambda: s.arm_info()["status"] == "error", timeout=10.0), \
            f"应收敛到 error 态, 实际 {s.arm_info()}"
        assert "AttributeError" in (s.arm_info()["error"] or "")
        assert s.connected is False
    finally:
        s.close()


# ------------------------------------------------- 关节级参数命令

def test_get_joint_params_returns_one_entry_per_joint(fake_session: Session) -> None:
    params = fake_session.execute("get_joint_params", {})
    assert isinstance(params, list)
    assert len(params) == 7
    for i, jp in enumerate(params):
        assert jp["idx"] == i
        for key in ("kp", "kd", "tau_max", "q_min", "q_max"):
            assert isinstance(jp[key], float), f"{key} 应是 float"
        assert jp["q_min"] < jp["q_max"]


def test_set_joint_limits_is_visible_on_readback(fake_session: Session) -> None:
    fake_session.execute("set_joint_limits", {"idx": 2, "q_min": -0.25, "q_max": 0.75})
    jp = fake_session.execute("get_joint_params", {})[2]
    assert jp["q_min"] == pytest.approx(-0.25)
    assert jp["q_max"] == pytest.approx(0.75)


def test_set_joint_param_is_visible_on_readback(fake_session: Session) -> None:
    fake_session.execute("set_joint_param",
                         {"idx": 1, "kp": 12.5, "kd": 0.75, "tau_max": 3.5})
    jp = fake_session.execute("get_joint_params", {})[1]
    assert jp["kp"] == pytest.approx(12.5)
    assert jp["kd"] == pytest.approx(0.75)
    assert jp["tau_max"] == pytest.approx(3.5)


@pytest.mark.parametrize("params", [
    {},                                        # 缺 idx
    {"idx": -1, "q_min": 0.0, "q_max": 1.0},   # 负数
    {"idx": 1.5, "q_min": 0.0, "q_max": 1.0},  # 非整数
    {"idx": 0, "q_min": 0.0},                  # 缺 q_max
    {"idx": 0, "q_min": "0", "q_max": 1.0},    # 字符串
])
def test_set_joint_limits_validates_its_arguments(fake_session: Session,
                                                  params: dict) -> None:
    with pytest.raises(ValueError):
        fake_session.execute("set_joint_limits", params)


@pytest.mark.parametrize("params", [
    {},                                             # 全缺
    {"idx": 0, "kd": 1.0, "tau_max": 1.0},          # 缺 kp
    {"idx": 0, "kp": 1.0, "kd": 1.0},               # 缺 tau_max
    {"idx": 0, "kp": 1.0, "kd": 1.0, "tau_max": None},
])
def test_set_joint_param_validates_its_arguments(fake_session: Session,
                                                 params: dict) -> None:
    with pytest.raises(ValueError):
        fake_session.execute("set_joint_param", params)


def test_save_params_is_rejected_while_enabled(fake_session: Session) -> None:
    """固件要求失能才允许擦写 flash —— 这条拒绝必须**如实传出去**。"""
    from litearm.errors import CommandRejectedError

    fake_session.execute("enable", {})
    with pytest.raises(CommandRejectedError) as ei:
        fake_session.execute("save_params", {})
    assert ei.value.code == 0x04


def test_save_params_succeeds_when_disabled(fake_session: Session) -> None:
    fake_session.execute("disable", {})
    assert fake_session.execute("save_params", {}) is None


# ------------------------------------------------- 载荷 / 前馈系数 / 固件自检

def test_set_payload_is_visible_on_readback(fake_session: Session) -> None:
    fake_session.execute("set_payload", {"mass": 1.25, "com": [0.1, -0.2, 0.05]})
    assert fake_session.execute("get_ff_scalar", {"item": 4, "sub": 0}) == \
        pytest.approx(1.25)
    for sub_idx, want in enumerate((0.1, -0.2, 0.05)):
        got = fake_session.execute("get_ff_scalar", {"item": 5, "sub": sub_idx})
        assert got == pytest.approx(want)


def test_set_payload_defaults_com_to_zero(fake_session: Session) -> None:
    fake_session.execute("set_payload", {"mass": 0.5})
    assert fake_session.execute("get_ff_scalar", {"item": 5, "sub": 0}) == \
        pytest.approx(0.0)


def test_gravity_and_inertia_scale_roundtrip(fake_session: Session) -> None:
    gs = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6]
    isc = [0.9] * 7
    fake_session.execute("set_gravity_scale", {"values": gs})
    fake_session.execute("set_inertia_scale", {"values": isc})
    assert fake_session.execute("get_ff_vec", {"item": 7}) == pytest.approx(gs)
    assert fake_session.execute("get_ff_vec", {"item": 8}) == pytest.approx(isc)


def test_gravity_vector_roundtrip(fake_session: Session) -> None:
    fake_session.execute("set_gravity_vector", {"g": [0.0, 0.0, -9.81]})
    got = [fake_session.execute("get_ff_scalar", {"item": 6, "sub": i})
           for i in range(3)]
    assert got == pytest.approx([0.0, 0.0, -9.81])


def test_kin_bench_returns_timings_and_link(fake_session: Session) -> None:
    bench = fake_session.execute("kin_bench", {})
    assert isinstance(bench, dict)
    assert set(bench) == {"raw", "timings", "link"}
    assert isinstance(bench["raw"], str) and bench["raw"]
    assert isinstance(bench["timings"], dict)
    assert isinstance(bench["link"], dict)


def test_reset_factory_params_requires_disarmed(fake_session: Session) -> None:
    from litearm.errors import CommandRejectedError

    fake_session.execute("enable", {})
    with pytest.raises(CommandRejectedError):
        fake_session.execute("reset_factory_params", {})
    fake_session.execute("disable", {})
    assert fake_session.execute("reset_factory_params", {}) is None


@pytest.mark.parametrize("method,params", [
    ("set_payload", {}),                                   # 缺 mass
    ("set_payload", {"mass": 1.0, "com": [0.0, 0.0]}),     # com 长度不对
    ("set_gravity_scale", {"values": [1.0] * 3}),          # 需 7 值
    ("set_inertia_scale", {}),                             # 缺 values
    ("set_gravity_vector", {"g": [0.0, 0.0]}),             # 需 3 值
    ("get_ff_vec", {}),                                    # 缺 item
    ("get_ff_scalar", {"item": "7"}),                      # item 非整数
])
def test_calibration_commands_validate_their_arguments(fake_session: Session,
                                                       method: str,
                                                       params: dict) -> None:
    with pytest.raises(ValueError):
        fake_session.execute(method, params)


# ------------------------------------------------- 授权/激活 (只读那一半)

def test_license_reads_the_record_and_names_the_state(fake_session: Session) -> None:
    """已激活: 记录照读, 并且把 `state` 翻译成**可读名** (界面直接显示, 不再自己映射)。"""
    info = fake_session.execute("license", {})
    assert info["supported"] is True
    assert info["activated"] is True and info["state"] == 1
    assert info["stateName"] == "activated"
    assert info["factoryMode"] is False
    # ⚠ UID 必须是**签发器要的那个形态**: 24 位小写 hex (厂商的 `--uid` 参数)。
    assert len(info["uid"]) == 24 and info["uid"] == info["uid"].lower()
    assert set(info["uid"]) <= set("0123456789abcdef")


def test_license_reports_an_unactivated_arm_as_a_state_not_an_error(
        fake_session: Session) -> None:
    """未激活不是错误 —— 而且**UID 照回** (否则没法给这台机器签凭据)。"""
    fake_session._arm._tr.activated = False
    info = fake_session.execute("license", {})
    assert info["supported"] is True
    assert info["activated"] is False and info["state"] == 0
    assert info["stateName"] == "not_activated"
    assert len(info["uid"]) == 24
    assert (info["custId"], info["issued"], info["flags"]) == (0, 0, 0)


def test_license_maps_a_firmware_without_the_command_to_supported_false(
        fake_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """固件明确"没有这条命令" -> `supported=False` (界面据此说"固件太旧")。"""
    def _unsupported(*_a, **_kw):
        raise litearm.UnsupportedByFirmwareError("ERR [2F,00] —— 固件没有实现这条命令",
                                                cmd=0x2F, code=0x00)

    monkeypatch.setattr(fake_session._arm, "license", _unsupported)
    assert fake_session.execute("license", {}) == {"supported": False}


def test_license_maps_a_missing_reply_to_supported_none(
        fake_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """没读到 (超时) -> `supported=None`, **不许**冒出去变成"N 运动超时"。

    ⚠ 旧固件今天走的正是这一条 (SDK 的探测帧读不到那条 `ERR{0x2F,0x00}`, 见
    `_license_dict` 的说明)。它和"固件确报不支持"是两句话, 界面也得给两种说法。
    """
    def _timeout(*_a, **_kw):
        raise litearm.MotionTimeoutError("get_license 无应答(超时 1.0s)")

    monkeypatch.setattr(fake_session._arm, "license", _timeout)
    assert fake_session.execute("license", {}) == {"supported": None}


def test_license_lets_a_real_link_failure_propagate(
        fake_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """链路真断了要**照旧抛** —— 折成 `supported=None` 会把断线说成"读不到授权"。"""
    def _dead(*_a, **_kw):
        raise litearm.TransportError("读线程已退出")

    monkeypatch.setattr(fake_session._arm, "license", _dead)
    with pytest.raises(litearm.TransportError):
        fake_session.execute("license", {})


# ------------------------------------------------- 激活 (在线领凭据 / 手动导入)

LICENSE_DOC = {"format": 1, "uid": "101112131415161718191a1b", "cust_id": 1042,
               "issued": 20260929, "flags": 0, "mac": "00112233445566778899aabbccddeeff"}


def _payload(**over):
    doc = {
        "uid": LICENSE_DOC["uid"],
        "contact": {"name": "张三", "organization": "某大学",
                    "email": "z@example.com", "phone": "13800000000"},
        "consent": {"granted": True},
    }
    doc.update(over)
    return doc


def _unlicensed(session: Session):
    """把假设备变成"未激活" —— 激活这条路上的起点。"""
    session._arm._tr.activated = False
    return session._arm._tr


def test_import_license_writes_the_credential_and_confirms_by_read_back(
        fake_session: Session) -> None:
    """手动导入那条路: 不联网, 直接把文件写进设备, 再**回读**当落位证据。"""
    tr = _unlicensed(fake_session)
    rec = fake_session.execute("import_license", {"license": LICENSE_DOC})
    assert rec["supported"] is True and rec["activated"] is True
    assert (rec["custId"], rec["issued"]) == (1042, 20260929)
    assert (tr.license_cust_id, tr.license_issued) == (1042, 20260929)


def test_import_license_refuses_a_file_for_another_machine(fake_session: Session) -> None:
    tr = _unlicensed(fake_session)
    with pytest.raises(activation.LicenseFileError) as ei:
        fake_session.execute("import_license",
                             {"license": {**LICENSE_DOC, "uid": "ff" * 12}})
    assert ei.value.reason == "uid_mismatch"
    assert tr.activated is False, "机器不匹配却把凭据写进去了"


def test_import_license_rejects_a_file_that_is_not_json(fake_session: Session) -> None:
    with pytest.raises(activation.LicenseFileError) as ei:
        fake_session.execute("import_license", {"license": "这不是凭据"})
    assert ei.value.reason == "not_json"


def test_activate_posts_the_consented_request_then_writes_the_credential(
        fake_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    tr = _unlicensed(fake_session)
    seen: dict = {}

    def fake_post(base_url, request, *, expected_uid=None, **_kw):
        seen.update(url=base_url, request=request, uid=expected_uid)
        return activation.parse_license(LICENSE_DOC)

    monkeypatch.setattr(activation, "request_license", fake_post)
    rec = fake_session.execute("activate", _payload())

    assert seen["url"] == activation.DEFAULT_ACTIVATION_URL
    assert seen["request"]["consent"]["granted"] is True
    assert seen["request"]["contact"]["organization"] == "某大学"
    # 期望 UID 取自**设备**, 不是客户端填的那个。
    assert seen["uid"] == LICENSE_DOC["uid"]
    assert rec["activated"] is True
    assert tr.license_cust_id == 1042


def test_activate_refuses_without_consent_before_any_request(
        fake_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """同意是硬门禁: 未勾选时**一个请求都不发**。"""
    called: list = []
    monkeypatch.setattr(activation, "request_license",
                        lambda *a, **k: called.append(1))
    p = _payload()
    p.pop("consent")
    with pytest.raises(activation.ActivationError) as ei:
        fake_session.execute("activate", p)
    assert ei.value.reason == "consent_required"
    assert called == []


def test_activate_refuses_a_uid_that_is_not_this_machine(
        fake_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(activation, "request_license",
                        lambda *a, **k: pytest.fail("不该发请求"))
    with pytest.raises(activation.ActivationError) as ei:
        fake_session.execute("activate", _payload(uid="ff" * 12))
    assert ei.value.reason == "uid_mismatch"


def test_activate_says_so_when_the_service_is_not_configured() -> None:
    """未配置地址时当场说清, 而不是转圈等超时。"""
    s = Session(fake=True, activation_url="", poll_period=0.05, state_push_interval=0.05)
    try:
        assert s.connect() is True
        assert _wait(lambda: s.connected), f"假会话没连上: {s.arm_info()}"
        _unlicensed(s)
        with pytest.raises(activation.ActivationError) as ei:
            s.execute("activate", _payload())
        assert ei.value.reason == "unconfigured"
    finally:
        s.close()


def test_fake_unactivated_transport_reports_an_unlicensed_bench_device() -> None:
    """`--fake-unactivated` 的落点: 假设备是**未激活**的那台。

    没有硬件时这是唯一能看到授权面板与注册表单的办法 (桩默认是"已授权的板子")。
    """
    arm = Arm(port="fake", transport_factory=build_fake_transport_factory(activated=False))
    try:
        arm.connect()
        lic = arm.license()
        # 未激活也回 UID —— 表单要靠它。
        assert lic.activated is False and lic.state == 0 and len(lic.uid_hex) == 24
        # 使能被拒的是**授权那条码**, 与真机一致 (这样"未激活"的提示也能顺带验)。
        with pytest.raises(litearm.CommandRejectedError) as ei:
            arm.enable()
        assert (ei.value.cmd, ei.value.code) == (0x10, 0x08)
    finally:
        arm.close()


def test_fake_transport_is_activated_by_default() -> None:
    """默认不变: `--fake` 起来的是一台已授权的板子 (授权面板只显示状态, 不出表单)。"""
    arm = Arm(port="fake", transport_factory=build_fake_transport_factory())
    try:
        arm.connect()
        assert arm.license().activated is True
    finally:
        arm.close()


def test_fake_unactivated_session_exposes_the_form_path() -> None:
    s = Session(fake=True, fake_activated=False, poll_period=0.05, state_push_interval=0.05)
    try:
        assert s.connect() is True
        assert _wait(lambda: s.connected), f"假会话没连上: {s.arm_info()}"
        info = s.execute("license", {})
        assert info["activated"] is False and info["state"] == 0
        assert len(info["uid"]) == 24
    finally:
        s.close()
