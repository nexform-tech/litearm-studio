"""夹爪的单位换算里那个**符号**: 前馈与读数都要按安装方向翻。

issue #170: 本仓两处都漏了 SDK 的 `close_sign`(`gripper.py` 报力时乘它, `actions.py` 的
保力段也乘它), 而它是**数据**: `+1` 表示"角度增大即闭合"的常规装配, `-1` 表示反装。少了
这个符号, 反装机器上一次 `grasp` 的前馈会把夹爪**撑开**, 大小正好等于设定力 —— 读数、状态
帧、日志全都看着合理, 只有真机上那两片齿爪是往两边走的。

这里钉三件事: 前馈的符号、读数的符号, 以及"这条前馈喂进物理模型之后夹爪往哪边动" ——
模拟器用的是与真件同一套 MIT 律, 所以方向对不对在它身上就能看出来。
"""
from __future__ import annotations

from litearm_studio_daemon.gripper import constants
from litearm_studio_daemon.gripper.backend.plant import Plant, PlantConfig
from litearm_studio_daemon.gripper.units import (
    CLASSIC_DIRECTION,
    clamp_force_torque,
    force_from_torque,
)

#: 常规装配 (`pos_closed_rad > pos_open_rad`) 与反装, 与 `Limits.direction` 同一口径。
CLASSIC = -1.0
REVERSE = +1.0


def test_the_feed_forward_pushes_toward_closed_on_both_mountings() -> None:
    """设定力是**大小**; 它落到电机坐标里是哪一侧, 由安装方向决定。"""
    forward = clamp_force_torque(20.0, direction=CLASSIC)
    backward = clamp_force_torque(20.0, direction=REVERSE)

    assert forward == 20.0 * constants.N_TO_NM
    assert backward == -forward
    # 大小一样, 方向相反 —— 这正是"反装"的全部含义。
    assert abs(backward) == abs(forward)


def test_the_force_readback_uses_the_sdks_sign_convention() -> None:
    """同一个物理力矩, 两种安装下报出来的力都该是正的 (那是"夹住了")。"""
    squeezing_classic = +0.5      # 常规装配: 角度增大即闭合 ⇒ 夹紧力矩为正
    squeezing_reverse = -0.5      # 反装: 反过来

    assert force_from_torque(squeezing_classic, direction=CLASSIC) > 0
    assert force_from_torque(squeezing_reverse, direction=REVERSE) > 0
    # 同一个数在两种安装下符号相反 —— 少了方向就没有"哪个是对的"可言。
    assert force_from_torque(squeezing_classic, direction=CLASSIC) == \
        -force_from_torque(squeezing_classic, direction=REVERSE)


def test_the_clamp_still_caps_the_magnitude() -> None:
    """方向是方向, 上限还是上限 (而且是在取符号**之前**夹的)。"""
    assert abs(clamp_force_torque(1e6, direction=CLASSIC)) == \
        abs(clamp_force_torque(1e6, direction=REVERSE))
    assert abs(clamp_force_torque(1e6, direction=CLASSIC)) == \
        constants.FORCE_MAX_N * constants.N_TO_NM


def test_an_uncalibrated_unit_reads_the_placeholder_orientation() -> None:
    """没有标定时用 SDK 占位默认值的方向 —— 数不准, 但符号与 SDK 一致。"""
    assert CLASSIC_DIRECTION == CLASSIC


def test_the_feed_forward_squeezes_on_a_reverse_mount() -> None:
    """把这条前馈喂进物理模型: 反装机器上夹爪必须**朝闭合**走。

    模拟器的 `tau` 就是电机坐标下的力矩(与真件同一个约定), 所以方向错了在这里看得见 ——
    而只断言符号的用例看不出"这条力矩会让齿爪往哪边动"。
    """
    config = PlantConfig(closed_rad=0.0, open_rad=1.4, rad_to_mm=60.0)
    plant = Plant(config)
    limits = plant.limits
    assert limits.direction == REVERSE

    plant.q = config.open_rad                     # 从张开端出发
    start_mm = limits.to_mm(plant.reported_q())
    assert start_mm > 50.0

    tau = clamp_force_torque(20.0, direction=limits.direction)
    for _ in range(200):
        # 零增益、零速度参考: 这一刻只有前馈在出力。
        plant.stream(plant.reported_q(), kp=0.0, kd=0.0, dq=0.0, tau=tau)
        plant.step(0.005)

    end_mm = limits.to_mm(plant.reported_q())
    assert end_mm < start_mm, "反装: 这条前馈把夹爪推向了张开 (少了 close_sign)"


def test_the_same_feed_forward_opens_when_the_sign_is_missing() -> None:
    """反证: 少了那个符号 (改动之前的样子) 夹爪是往**张开**走的。

    这条把"为什么非得有方向"钉在物理上, 而不只是两个数不相等。
    """
    config = PlantConfig(closed_rad=0.0, open_rad=1.4, rad_to_mm=60.0)
    plant = Plant(config)
    limits = plant.limits

    plant.q = config.closed_rad                   # 从闭合端出发, 免得撞上张开限位
    start_mm = limits.to_mm(plant.reported_q())

    for _ in range(200):
        plant.stream(plant.reported_q(), kp=0.0, kd=0.0, dq=0.0, tau=+20.0 * constants.N_TO_NM)
        plant.step(0.005)

    assert limits.to_mm(plant.reported_q()) > start_mm
