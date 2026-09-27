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
