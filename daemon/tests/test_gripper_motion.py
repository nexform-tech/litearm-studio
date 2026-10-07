"""夹爪平动闭合的单测 —— 闭合侧死区、两档领先上限、压紧力矩与堵转判据。

对应 issue #72: 旧的单档领先 (``CONTACT_LEAD_RAD = 0.004``) 加上一个 tick 的
步进也只有约 0.0085 rad, 盖不过本机闭合侧约 0.010 rad 的机械死区, 于是 闭合
卡在半路、夹爪在空程里抖到移动超时。

这里用两个纯 Python 的假机构验证修复, 不碰 CAN, 也不碰真机:

* :class:`StickyJaws` —— 带闭合侧机械死区的粘滑模型: 指令要先把这段空程吃
  掉, 夹爪才动, 正好是现场那台机器的行为;
* :class:`SimulatedJaws` —— 仓库自己的 :class:`Plant`, 带接触弹簧和真实 MIT
  力矩, 用来确认真正的障碍仍然被判成堵转、而不是被推过去。

``conftest.py`` 的说明在这里同样成立: 凡是要动毫米的用例, 实测标定是前提。
这些用例不走 session, 所以直接取 ``conftest.MEASURED_CALIBRATION`` 的那组角度
自建 :class:`Limits`。
"""
from __future__ import annotations

from typing import Optional

from litearm_studio_daemon.gripper import constants
from litearm_studio_daemon.gripper.backend.plant import Plant, PlantConfig
from litearm_studio_daemon.gripper.core.motion import (
    MotionFSM,
    MotionParams,
    MotionState,
)
from litearm_studio_daemon.gripper.telemetry import Telemetry
from litearm_studio_daemon.gripper.units import Limits

#: ``conftest.MEASURED_CALIBRATION`` 的那份 85 mm normal 实测标定。
LIMITS = Limits(1.775959, -0.064279, 46.73, 85.0)

#: 本机闭合侧的机械死区, 取自 issue #72 的现场报告。
CLOSING_DEAD_BAND_RAD = 0.010

#: ``motion.py`` 判到堵转时给出的报告文本。
STALL_NOTE = "堵转：位置未随时间变化"

#: 一个 tick 最远能走多远 (默认速度下), 领先上限之外的固有位置误差。
CRUISE_TICK_MM = constants.SPEED_DEFAULT_MM_S * constants.CTRL_DT


class StickyJaws:
    """闭合侧粘滑假机构: 指令领先实测超过死区, 夹爪才走完这段空程。

    死区是位置量, 不是力矩阈值, 所以把它换算成毫米再和指令的位置误差比较 ——
    这正是 issue #72 的算术: 旧的领先加上一个 tick 到不了死区, 夹爪就永远动
    不了。``stop_mm`` 是钉死的硬限位 (顶到闭合端或工件)。
    """

    def __init__(
        self,
        start_mm: float,
        *,
        dead_band_rad: float = CLOSING_DEAD_BAND_RAD,
        stop_mm: float = 0.0,
    ) -> None:
        self.limits = LIMITS
        self.mm = float(start_mm)
        self.dead_band_mm = dead_band_rad * LIMITS.rad_to_mm
        self.floor_mm = stop_mm
        self._q_cmd = LIMITS.to_rad(self.mm)
        self._kp = 0.0
        self._kd = 0.0
        self._dq_cmd = 0.0
        self.velocity_rad_s = 0.0
        self.torque_nm = 0.0
        #: 指令与实测之间最大的位置误差, 也就是压紧力矩的来源。
        self.max_squeeze_rad = 0.0

    def stream_frame(self, q_rad, kp, kd, dq=0.0, tau=0.0, *, ungated=False) -> bool:
        del ungated
        self._q_cmd = q_rad
        self._kp = kp
        self._kd = kd
        self._dq_cmd = dq
        return True

    def step(self, dt: float) -> None:
        before_rad = self.limits.to_rad(self.mm)
        cmd_mm = self.limits.to_mm(self._q_cmd)
        if cmd_mm > self.mm:
            # 张开: 反向没有死区, 直接跟随。
            self.mm = cmd_mm
        elif self.mm - cmd_mm > self.dead_band_mm:
            # 闭合: 指令先把死区吃掉, 夹爪才跟到指令处。
            self.mm = cmd_mm
        self.mm = max(self.mm, self.floor_mm)

        q_rad = self.limits.to_rad(self.mm)
        self.velocity_rad_s = (q_rad - before_rad) / dt
        squeeze_rad = self._q_cmd - q_rad
        self.max_squeeze_rad = max(self.max_squeeze_rad, abs(squeeze_rad))
        self.torque_nm = self._kp * squeeze_rad + self._kd * self._dq_cmd

    def read(self) -> Telemetry:
        return Telemetry(
            position_mm=self.mm,
            position_rad=self.limits.to_rad(self.mm),
            velocity_rad_s=self.velocity_rad_s,
            torque_nm=self.torque_nm,
        )


class SimulatedJaws:
    """仓库自己的 :class:`Plant` 适配成 backend 的帧接口。

    与 ``SimBackend`` 走同一条生产路径 (MIT 帧 + 接触弹簧), 只是没有 CAN 和
    墙钟: 时间由用例显式步进, 所以整条闭合是确定性的。
    """

    def __init__(self, start_mm: float, object_mm: Optional[float] = None) -> None:
        self.plant = Plant(PlantConfig())
        self.plant.q = LIMITS.to_rad(start_mm)
        self.plant.dq = 0.0
        if object_mm is not None:
            self.plant.object_mm = object_mm
        #: 整条闭合里电机力矩的峰值, 用来确认压紧没有冲到额定之上。
        self.peak_torque_nm = 0.0

    def stream_frame(self, q_rad, kp, kd, dq=0.0, tau=0.0, *, ungated=False) -> bool:
        del ungated
        self.plant.stream(q_rad, kp, kd, dq, tau)
        return True

    def step(self, dt: float) -> None:
        self.plant.step(dt)
        self.peak_torque_nm = max(self.peak_torque_nm, abs(self.plant.tau))

    def read(self) -> Telemetry:
        return self.plant.snapshot(0.0)

    @property
    def mm(self) -> float:
        return self.plant.limits.to_mm(self.plant.q)


def run_close(backend, *, speed_mm_s: float = constants.SPEED_DEFAULT_MM_S,
              ticks: int = 8000) -> MotionFSM:
    """按 worker 的顺序跑一条 plain 闭合: 步进假机构 → 读数 → 一个 tick。"""
    fsm = MotionFSM(LIMITS, MotionParams(speed_mm_s=speed_mm_s))
    fsm.move_to_mm(0.0, "close")
    for _ in range(ticks):
        backend.step(constants.CTRL_DT)
        fsm.tick(backend, backend.read(), constants.CTRL_DT, allow_motion=True)
        if fsm.state is not MotionState.SERVO:
            break
    return fsm


# ------------------------------------------------------------------ 死区
def test_plain_close_crosses_the_closing_dead_band_and_reaches_the_limit() -> None:
    """旧单档领先破不了 0.010 rad 的死区; 两档的行进档可以, 闭合到位。

    修复前: 夹爪停在起点 (指令领先封顶在 ~0.0085 rad), 移动超时。
    """
    backend = StickyJaws(start_mm=80.0)
    fsm = run_close(backend)

    assert fsm.state is MotionState.HOLD
    assert backend.mm <= constants.TOL_MM, backend.mm
    # 到位而不是堵转/超时: 这条闭合没有障碍, note 必须为空。
    assert fsm.note == ""


# ------------------------------------------------------------------ 两档
def test_the_lead_is_large_while_travelling_and_narrows_inside_the_press_zone() -> None:
    """领先上限分两档, 按距目标的远近切换 —— SDK ``MotionConfig`` 的算法。"""
    from litearm_studio_daemon.gripper.core.profile import LeadCaps, SpeedProfile

    caps = LeadCaps(
        travel_mm=constants.CONTACT_LEAD_TRAVEL_MM,
        press_mm=constants.CONTACT_LEAD_PRESS_MM,
        press_zone_mm=constants.CONTACT_PRESS_ZONE_MM,
    )

    def saturated_lead_mm(measured_mm: float) -> float:
        """夹爪钉死时, 指令最终能领先它多少毫米。"""
        profile = SpeedProfile(LIMITS, 0.0, constants.SPEED_DEFAULT_MM_S)
        lead = 0.0
        for _ in range(2000):
            out = profile.step(measured_mm, constants.CTRL_DT, caps)
            lead = max(lead, abs(out.q_cmd_mm - measured_mm))
        return lead

    travelling = saturated_lead_mm(40.0)
    pressing = saturated_lead_mm(1.0)

    dead_band_mm = CLOSING_DEAD_BAND_RAD * LIMITS.rad_to_mm
    # 行进档要盖过闭合侧死区, 否则永远破不了静摩擦。
    assert travelling >= constants.CONTACT_LEAD_TRAVEL_MM
    assert travelling >= dead_band_mm
    # 压紧档收窄到 stop 档: 位置误差不超过 stop 档加一个 tick。
    assert pressing <= constants.CONTACT_LEAD_PRESS_MM + CRUISE_TICK_MM
    assert pressing < travelling
    # 钉住 2000 个 tick (10 s) 领先也不涨 —— 它是上限, 不是积分器。
    pressing_force_n = constants.KP_MOVE * pressing / LIMITS.rad_to_mm * constants.NM_TO_N
    assert pressing_force_n < constants.FORCE_SOFT_WARN_N, pressing_force_n


# ------------------------------------------------------------------ 压紧力矩
def test_the_pressing_squeeze_clears_the_dead_band_and_stays_bounded() -> None:
    """夹爪停在压紧段里 (0.8 mm 硬限位): 力矩够破死区, 但有界、不涨。

    修复前: 压紧段里速度早已降到巡航之下, 旧的「只在巡航积分」判据把领先
    关掉, 夹爪一步都动不了, 只能等移动超时。
    """
    backend = StickyJaws(start_mm=20.0, stop_mm=0.8)
    fsm = run_close(backend)

    assert fsm.state is MotionState.HOLD
    squeeze = backend.max_squeeze_rad
    # 够破 0.010 rad 的死区。
    assert squeeze >= CLOSING_DEAD_BAND_RAD, squeeze
    # 有界: stop 档加一个 tick 就是上限, 不会随停住的时间累积。
    bound_rad = (constants.CONTACT_LEAD_PRESS_MM + CRUISE_TICK_MM) / LIMITS.rad_to_mm
    assert squeeze <= bound_rad, squeeze
    # 压紧力矩 = kp × 位置误差, 远在 40 N 额定之下。
    pressing_force_n = constants.KP_MOVE * squeeze * constants.NM_TO_N
    assert pressing_force_n < constants.FORCE_SOFT_WARN_N, pressing_force_n


# ------------------------------------------------------------------ 堵转
def test_an_obstruction_inside_the_press_zone_is_reported_not_driven_through() -> None:
    """真 Plant 在限位内侧 1 mm 放一件障碍: 仍然报堵转, 不推过去。

    修复前: 末段速度低于巡航, 领先被关掉, ``lost_mm`` 不再累积, 位置判据
    永远不触发 —— 只能等移动超时, 而超时报告的是「没到位」而不是「有东西
    挡着」。这里要的是堵转那条报告。
    """
    backend = SimulatedJaws(start_mm=40.0, object_mm=1.0)
    fsm = run_close(backend)

    assert fsm.state is MotionState.HOLD
    assert fsm.note == STALL_NOTE, fsm.note
    # 停在工件上, 没有推穿到限位: 接触弹簧允许零点几毫米的压入, 但不会走过
    # 工件的中途。
    assert backend.mm > 0.5, backend.mm
    assert backend.peak_torque_nm <= constants.FORCE_MAX_N * constants.N_TO_NM


def test_an_obstruction_mid_travel_is_still_a_stall() -> None:
    """行程中段的障碍照旧判堵转 —— 两档领先没有把它推穿。"""
    backend = SimulatedJaws(start_mm=80.0, object_mm=40.0)
    fsm = run_close(backend)

    assert fsm.state is MotionState.HOLD
    assert fsm.note == STALL_NOTE, fsm.note
    assert backend.mm >= 40.0 - 0.5, backend.mm
    assert backend.peak_torque_nm <= constants.FORCE_MAX_N * constants.N_TO_NM


def test_a_free_close_still_arrives_and_reports_no_contact() -> None:
    """空载闭合: 修复后仍然干净到位, 领先加大没有引来假接触。"""
    backend = SimulatedJaws(start_mm=80.0)
    fsm = run_close(backend)

    assert fsm.state is MotionState.HOLD
    assert fsm.note == ""
    assert backend.mm <= constants.TOL_MM, backend.mm
    assert backend.peak_torque_nm <= constants.FORCE_MAX_N * constants.N_TO_NM
