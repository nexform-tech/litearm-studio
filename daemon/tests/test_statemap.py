"""`statemap` 的纯函数单测 —— 派生状态串与状态帧归一化。"""
from __future__ import annotations

import pytest
from litearm.state import JointState, RobotState

from litearm_studio_daemon import statemap


def _joint(q: float = 0.0, dq: float = 0.0, tau: float = 0.0,
           t_mos: float = 30.0, t_coil: float = 25.0, err: int = 0) -> JointState:
    return JointState(q=q, dq=dq, tau=tau, t_mos=t_mos, t_coil=t_coil, err=err)


def _state(*, mode: int = 1, mode_name: str = "MOVE_J", flags: int = 0,
           joints=None, joint_fault: int = 0, seq: int = 7) -> RobotState:
    return RobotState(mode=mode, mode_name=mode_name, flags=flags, flag_names=[],
                      seq=seq, joints=joints if joints is not None else [_joint()],
                      joint_fault=joint_fault)


# --------------------------------------------------------------------- 常量对齐

def test_mode_constants_match_sdk() -> None:
    """`MODE_INIT` / `MODE_ZERO_G` 必须与 SDK 的 `MODE_NAMES` 同源。

    本模块刻意不 import 私有模块 `litearm._protocol`, 代价就是这个反查:
    固件那侧改了 mode 编号, 这条会红, 而不是静默判错。
    """
    from litearm import _protocol as P

    assert P.MODE_NAMES[statemap.MODE_INIT] == "INIT"
    assert P.MODE_NAMES[statemap.MODE_ZERO_G] == "ZERO_G"


# ----------------------------------------------------------------- 派生状态串

def test_fault_wins_over_everything() -> None:
    assert statemap.state_of(faulted=True, enabled=True, mode=1,
                             zero_g_active=True, motion_in_flight=True,
                             cart_busy=True) == "fault"


@pytest.mark.parametrize("mode", [0, 1])
def test_disabled_when_not_enabled(mode: int) -> None:
    assert statemap.state_of(faulted=False, enabled=False, mode=mode,
                             zero_g_active=False, motion_in_flight=False,
                             cart_busy=False) == "disabled"


def test_disabled_when_mode_is_init_even_if_enabled() -> None:
    """`mode==INIT` 也算未就绪 —— 「使能且静止」的真值未在真机核实, 故 INIT 不认。"""
    assert statemap.state_of(faulted=False, enabled=True, mode=statemap.MODE_INIT,
                             zero_g_active=False, motion_in_flight=False,
                             cart_busy=False) == "disabled"


def test_zero_gravity_from_firmware_mode() -> None:
    assert statemap.state_of(faulted=False, enabled=True, mode=statemap.MODE_ZERO_G,
                             zero_g_active=False, motion_in_flight=False,
                             cart_busy=False) == "zero_gravity"


def test_zero_gravity_from_session_flag() -> None:
    """固件 mode 还没翻转时, 会话自己的记录要兜得住。"""
    assert statemap.state_of(faulted=False, enabled=True, mode=1,
                             zero_g_active=True, motion_in_flight=False,
                             cart_busy=False) == "zero_gravity"


def test_moving_from_local_motion_in_flight() -> None:
    """**不依赖固件 mode 语义** —— 这正是计划里那条「用会话自己的记录判 moving」。"""
    assert statemap.state_of(faulted=False, enabled=True, mode=1,
                             zero_g_active=False, motion_in_flight=True,
                             cart_busy=False) == "moving"


def test_moving_from_cart_busy_bit() -> None:
    assert statemap.state_of(faulted=False, enabled=True, mode=1,
                             zero_g_active=False, motion_in_flight=False,
                             cart_busy=True) == "moving"


def test_ready_when_enabled_and_quiet() -> None:
    assert statemap.state_of(faulted=False, enabled=True, mode=1,
                             zero_g_active=False, motion_in_flight=False,
                             cart_busy=False) == "ready"


def test_priority_order_is_fault_then_disabled_then_zero_g_then_moving() -> None:
    """顺序即优先级: 未使能要压过 zero_g / moving。"""
    assert statemap.state_of(faulted=False, enabled=False, mode=statemap.MODE_ZERO_G,
                             zero_g_active=True, motion_in_flight=True,
                             cart_busy=True) == "disabled"


# ------------------------------------------------------------------- 故障面

def test_fault_list_empty_when_clean() -> None:
    assert statemap.fault_list(_state(joints=[_joint(), _joint()])) == []


def test_fault_list_uses_one_based_joint_numbers() -> None:
    """旧前端字段 `fault[].joint` 是 1 基 (J1..Jn), 与 `fault_axes` 的展示口径一致。"""
    st = _state(joints=[_joint(), _joint(err=0x0B), _joint(err=0x0C)])
    assert statemap.fault_list(st) == [
        {"joint": 2, "errCode": 0x0B},
        {"joint": 3, "errCode": 0x0C},
    ]


def test_fault_list_merges_joint_fault_bitmap_with_zero_code() -> None:
    """断轴位图里的轴即使没有逐轴错码也要出现 (errCode=0)。"""
    st = _state(joints=[_joint(), _joint(), _joint()], joint_fault=0b100)
    assert statemap.fault_list(st) == [{"joint": 3, "errCode": 0}]


def test_fault_list_dedupes_axis_present_in_both_sources() -> None:
    st = _state(joints=[_joint(), _joint(err=0x0E)], joint_fault=0b010)
    assert statemap.fault_list(st) == [{"joint": 2, "errCode": 0x0E}]


# --------------------------------------------------------------- 状态帧归一化

def test_state_to_dict_shape_and_sources() -> None:
    st = _state(
        joints=[_joint(q=0.1, dq=0.2, tau=0.3, t_mos=41.5, t_coil=33.25, err=0),
                _joint(q=-0.4, dq=0.0, tau=0.0, t_mos=42.0, t_coil=34.0, err=0x0B)],
        joint_fault=0b10, seq=99, flags=0x240,
    )
    doc = statemap.state_to_dict(st, enabled=True, zero_g_active=False,
                                 motion_in_flight=False)
    assert doc["q"] == [0.1, -0.4]
    assert doc["dq"] == [0.2, 0.0]
    assert doc["tau"] == [0.3, 0.0]
    assert doc["errs"] == [0, 0x0B]
    assert doc["temps"] == [{"mosTemp": 41.5, "coilTemp": 33.25},
                            {"mosTemp": 42.0, "coilTemp": 34.0}]
    assert doc["fault"] == [{"joint": 2, "errCode": 0x0B}]
    assert doc["mode"] == 1
    assert doc["modeName"] == "MOVE_J"
    assert doc["flags"] == 0x240
    assert doc["jointFault"] == 0b10
    assert doc["faultAxes"] == [1]
    assert doc["enabled"] is True
    assert doc["seq"] == 99
    # `joint_fault` 非 0 ⇒ 有轴被固件断了, 派生状态串必须是 fault (见 `RobotState.faulted`)
    assert doc["faulted"] is True
    assert doc["state"] == "fault"


def test_state_to_dict_reports_fault_state_when_axis_dropped() -> None:
    st = _state(joints=[_joint(), _joint()], joint_fault=0b01)
    doc = statemap.state_to_dict(st, enabled=True)
    assert doc["faulted"] is True
    assert doc["state"] == "fault"


def test_state_to_dict_enabled_argument_overrides_frame_bit() -> None:
    """老固件不上报 flags bit9 ⇒ 会话给的 `enabled` 必须压过帧里那一位。"""
    st = _state(joints=[_joint()])           # flags=0 ⇒ 帧里读出来是"未使能"
    doc = statemap.state_to_dict(st, enabled=True)
    assert doc["enabled"] is True
    assert doc["state"] == "ready"


# ------------------------------------------------------------------- jsonable

def test_jsonable_unwraps_msg_envelope() -> None:
    from litearm.arm import Msg

    assert statemap.jsonable(Msg(value=(1.0, 2.0), hz=10.0, timestamp=0.0)) == [1.0, 2.0]


def test_jsonable_handles_dataclass_and_nested() -> None:
    st = _state(joints=[_joint(q=0.5)])
    out = statemap.jsonable(st)
    assert out["mode"] == 1
    assert out["joints"][0]["q"] == 0.5


def test_jsonable_falls_back_to_repr_instead_of_raising() -> None:
    class Weird:
        def __repr__(self) -> str:
            return "<weird>"

    assert statemap.jsonable(Weird()) == "<weird>"
