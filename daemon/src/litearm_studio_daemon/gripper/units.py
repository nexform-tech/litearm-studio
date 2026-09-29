"""Pure mm ↔ rad conversion, travel limits, and force scaling.

No Qt, no SDK, no I/O — everything here is a function of its arguments, so the
whole module is unit-testable and can be reasoned about by hand.

The conversion formulas are the SDK's (not invented), because getting them
subtly wrong is how a gripper drives into a hard stop:

    mm  = (pos_closed_rad - position_rad) * rad_to_mm      gripper.py:1281
    rad = pos_closed_rad - position_mm / rad_to_mm         gripper.py:925

Both of those hardcode the sign of the mapping, and the SDK has no other form: as
written it can only describe a gripper whose encoder angle *shrinks* as the jaws
open, which is how the units it was written for are assembled.  That is an
assembly detail rather than a property of the calibration, so here it is read
from the recorded angles — :attr:`Limits.direction` — and the two formulas above
are the case of it where the closed stop is the larger angle.

The other thing the SDK's formulas are fed is ``rad_to_mm``, and that one is not
taken from a file at all.  It is derived from the calibration's angles and the
operator's measured travel — :func:`derive_scale` — because the copy stored in a
calibration file describes the unit the file was written for, which is not always
the unit being driven.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from . import constants


@dataclass(frozen=True)
class Limits:
    """The travel calibration in effect, plus the commanded range.

    ``closed_rad`` is the motor angle at 0 mm and ``open_rad`` the angle at full
    stroke.  Which of the two is numerically larger depends on how the linkage
    was assembled — the units the SDK was written for have the closed stop at the
    larger angle, a reverse-mounted one has it at the smaller — and both are
    valid.  :attr:`direction` is that fact, and every conversion below reads it;
    :attr:`reversed_mount` names the case.

    ``rad_to_mm`` is DERIVED rather than read from the file — see
    :func:`derive_scale` — because the file's copy of it is the SDK's nominal
    stroke over this travel, which describes the unit the file was written for
    rather than the one on the bench.  ``max_stroke_mm`` is the operator's
    measured travel: the top of the commanded range, and therefore of the slider,
    which lands one millimetre inside the recorded open extreme.
    """

    closed_rad: float
    open_rad: float
    rad_to_mm: float
    max_stroke_mm: float = constants.DEFAULT_TRAVEL_MM

    # ── derived ─────────────────────────────────────────────────────────────
    @property
    def travel_rad(self) -> float:
        return abs(self.closed_rad - self.open_rad)

    @property
    def stroke_mm(self) -> float:
        """The span the recorded extremes imply, in mm.

        With a derived scale this is ``max_stroke_mm`` plus
        :data:`~litearm_studio_daemon.gripper.constants.SPAN_INSET_MM`, by construction: the
        recorded extremes are pressed into the stops, and the commanded range
        stops short of them.  It is reported rather than used, which is why the
        distinction is worth keeping — the two numbers disagreeing means the
        calibration was written for a different gripper.
        """
        return self.travel_rad * self.rad_to_mm

    @property
    def rad_low(self) -> float:
        return min(self.closed_rad, self.open_rad)

    @property
    def rad_high(self) -> float:
        return max(self.closed_rad, self.open_rad)

    @property
    def direction(self) -> float:
        """+1 when the angle grows toward open, -1 when it shrinks toward open.

        A property of the assembly, not a measure of the calibration's quality:
        the classic mounting has the closed stop at the larger angle (−1), a
        reverse-mounted one has it at the smaller (+1).  Every conversion that is
        not symmetric in the two angles reads this instead of assuming either.

        Equal angles are degenerate — :func:`derive_scale` gives them a zero
        scale and :func:`~litearm_studio_daemon.gripper.calibration.validate_limits` reports
        that as a problem — and are answered here as the classic case.
        """
        return 1.0 if self.open_rad > self.closed_rad else -1.0

    @property
    def reversed_mount(self) -> bool:
        """True when the closed stop is the numerically smaller angle.

        Reported, never refused.  This used to be the console's whole verdict on
        a file: ``closed <= open`` was read as the signature of the SDK's
        uncalibrated defaults ``(0.0, 1.14)`` and blocked motion outright.  It is
        the same signature in a file that is entirely correct, though, and a
        gripper whose fingers are mounted the other way round cannot be told
        apart from it by the angles alone — so a reverse-mounted unit was
        uncalibratable, which is the deadlock this property replaces.

        What actually guards the axis is not this: it is
        :func:`frame_mismatch`, which compares the calibration against the angle
        the encoder is reporting right now, and which cannot be fooled by a
        mounting direction because it never looks at the ordering at all.
        """
        return self.closed_rad <= self.open_rad

    # ── conversions ─────────────────────────────────────────────────────────
    def to_rad(self, mm: float) -> float:
        """mm (0 = closed) → motor angle in rad."""
        if self.rad_to_mm == 0:
            return self.closed_rad
        return self.closed_rad + self.direction * mm / self.rad_to_mm

    def to_mm(self, rad: float) -> float:
        """Motor angle in rad → mm (0 = closed)."""
        return self.direction * (rad - self.closed_rad) * self.rad_to_mm

    # ── clamping ────────────────────────────────────────────────────────────
    def clamp_mm(self, mm: float) -> float:
        if math.isnan(mm):
            return 0.0
        return min(max(mm, 0.0), self.max_stroke_mm)

    def clamp_rad(self, rad: float) -> float:
        """Clamp to the commanded-angle range of this calibration.

        Deliberately computed from our own ``closed_rad``/``open_rad`` rather
        than delegating to ``goto_rad``, which trusts whatever config the SDK
        holds — and the SDK's own clamp collapses to a constant instead of
        refusing when the two angles are ordered the other way round.
        """
        if math.isnan(rad):
            return self.closed_rad
        return min(max(rad, self.rad_low), self.rad_high)

    def clamp_speed(self, speed_mm_s: float) -> float:
        if math.isnan(speed_mm_s):
            return constants.SPEED_DEFAULT_MM_S
        return min(max(speed_mm_s, constants.SPEED_MIN_MM_S), constants.SPEED_MAX_MM_S)

    # ── construction ────────────────────────────────────────────────────────
    @classmethod
    def from_config(cls, config: Any) -> "Limits":
        """Build from an SDK ``GripperConfig`` (duck-typed to stay pure)."""
        return cls(
            closed_rad=float(config.pos_closed_rad),
            open_rad=float(config.pos_open_rad),
            rad_to_mm=float(config.rad_to_mm),
            max_stroke_mm=float(getattr(config, "max_stroke_mm", constants.DEFAULT_TRAVEL_MM)),
        )

    def with_max_stroke(self, max_stroke_mm: float) -> "Limits":
        return Limits(self.closed_rad, self.open_rad, self.rad_to_mm, max_stroke_mm)


def derive_scale(
    travel_rad: float,
    travel_mm: float = constants.DEFAULT_TRAVEL_MM,
    inset_mm: float = constants.SPAN_INSET_MM,
) -> float:
    """Millimetres per rad, derived from a calibration's angles and a measured travel.

    The scale is never read from the file.  The SDK writes ``rad_to_mm`` as
    ``nominal stroke / travel`` using whatever nominal it holds at the time, so
    every file on this machine says 120 mm worth of scale no matter which gripper
    the angles were recorded on — load one and a gripper whose jaws travel 85 mm
    reads 120 mm across them, with the slider covering the middle 70% of a travel
    no operator has ever seen the ends of.  The angles in the file are
    measurements; the scale is a derived quantity, so it is derived here from the
    one number that is a measurement of *this* unit: the travel across the jaws,
    taken with calipers.

    The recorded extremes span ``travel_mm + inset_mm`` and not ``travel_mm``,
    because the probe finds the open limit by pressing into it under force and
    the linkage gives about a millimetre doing so.  Reading the recorded span as
    one millimetre wider than the travel is what puts 0 mm exactly on the
    recorded closed extreme (where the jaws meet) and ``travel_mm`` one
    millimetre inside the recorded open one — see
    :data:`~litearm_studio_daemon.gripper.constants.SPAN_INSET_MM`.

    Returns 0.0 for a travel or a measurement that cannot produce a scale, which
    :func:`~litearm_studio_daemon.gripper.calibration.validate_limits` reports as a problem
    rather than something that divides by zero.
    """
    if not math.isfinite(travel_rad) or travel_rad <= 0:
        return 0.0
    if not math.isfinite(travel_mm) or travel_mm <= 0:
        return 0.0
    inset = inset_mm if math.isfinite(inset_mm) and inset_mm > 0 else 0.0
    return (travel_mm + inset) / travel_rad


def frame_mismatch(limits: Limits, measured_rad: float) -> str:
    """Why the gripper cannot be where ``limits`` says it is, or ``""``.

    The one calibration check that reads the hardware instead of the file, and
    it is here because a file can be *entirely* self-consistent and still
    describe another gripper: travel, ratio and direction all validate, nothing
    about the numbers looks wrong, and every millimetre the operator reads is
    off by a constant, because the encoder zero it was taken against is not the
    one the motor is reporting.  The case that prompted this was 1.885 rad out —
    more than the whole travel — with every check on the file passing.

    It has to be asked before the axis is commanded, because the clamp runs
    first: a position outside the calibration is, after clamping, indistinguish-
    able from one resting at the end of it.  That is how a wrong file drove a
    real gripper into its closed stop the moment it was enabled.

    Returns ``""`` for a reading that is not a number: a backend with no answer
    is not evidence about the calibration.

    The angle is rounded in the message on purpose — the gate re-emits only when
    its state or reason changes, and a reason carrying four decimals of a live
    reading would re-emit on every tick.
    """
    if math.isnan(measured_rad):
        return ""
    low, high = limits.rad_low, limits.rad_high
    slack = constants.CALIB_MISMATCH_RAD
    if low - slack <= measured_rad <= high + slack:
        return ""

    return (
        f"实测角度 {measured_rad:.2f} rad 不在标定行程 [{low:.4f}, {high:.4f}] rad "
        f"之内（允许超出 {slack} rad）—— 这份标定的零点不属于这台夹爪。"
        "mm 读数会整体偏移一个常数，而偏移会被行程夹取吸收：指令会直接顶到限位。"
        "请重新标定，或换用与本机编码器零点一致的标定文件"
    )


# ── force scaling ───────────────────────────────────────────────────────────
# The SDK estimates force as torque × NM_TO_N and does NOT guarantee a positive
# sign (the direction convention flips with the winding).  Display magnitude,
# keep the signed torque available.
def force_from_torque(torque_nm: float) -> float:
    return torque_nm * constants.NM_TO_N


def torque_from_force(force_n: float) -> float:
    return force_n * constants.N_TO_NM


def clamp_force(force_n: float) -> float:
    if math.isnan(force_n):
        return 0.0
    return min(max(force_n, 0.0), constants.FORCE_MAX_N)


def clamp_force_torque(force_n: float) -> float:
    """Force setpoint → torque feed-forward, capped at the mechanical rating."""
    return torque_from_force(clamp_force(force_n))


def mm_to_rad_per_s(speed_mm_s: float, rad_to_mm: float, *, direction: float) -> float:
    """Speed in mm/s → rad/s, for the MIT velocity feed-forward term.

    The sign is not cosmetic, and ``direction`` is not optional.  The mapping is
    ``q = closed_rad + direction · mm / rad_to_mm``, so ``dq/dmm`` is
    ``direction / rad_to_mm`` — signed, and on the classic mounting that sign is
    negative, because the angle *decreases* as the jaws open.  Feeding a
    velocity of the wrong sign as ``dq_target`` makes the ``kd·(dq_target − dq)``
    term drive the motor the wrong way — hard enough to pin the jaws against the
    closed stop while the position term is still small, which is exactly the
    failure this comment exists to prevent.  That is why there is no default: a
    caller that does not know which way its gripper opens cannot be given a
    plausible-looking guess here.
    """
    if rad_to_mm == 0 or not math.isfinite(speed_mm_s):
        # Non-finite is treated like every other guard in this module: a NaN that
        # reaches a frame is a runaway motor, and this output goes straight into
        # the MIT velocity term without passing any clamp on the way.
        return 0.0
    return direction * speed_mm_s / rad_to_mm


def rad_per_s_to_mm(velocity_rad_s: float, rad_to_mm: float, *, direction: float) -> float:
    """Motor velocity in rad/s → jaw velocity in mm/s (signed the same way)."""
    if rad_to_mm == 0 or not math.isfinite(velocity_rad_s):
        return 0.0
    return direction * velocity_rad_s * rad_to_mm
