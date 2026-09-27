"""会话单测 —— 命令白名单、运动互斥、参数校验, 以及 `--fake` 模式的全流程。

全部用例都在 `litearm.testing.FakeTransport` 上跑, **不碰真硬件**、不需要串口。
"""
from __future__ import annotations

import time
from typing import Optional

import pytest

from litearm_studio_daemon.errors import (
    MotionBusyError,
    NotConnectedCommandError,
    UnknownCommandError,
)
from litearm_studio_daemon.session import COMMANDS, MOTION_COMMANDS, Session

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
