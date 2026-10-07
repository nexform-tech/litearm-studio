"""Slew-limited velocity reference generator — the trajectory layer.

Pure: a function of ``(measured, target, v_ref, dt)`` with no clock, no SDK and
no Qt, so it can be fuzzed by the thousand in tests.

Two design decisions carry the weight here.

**The reference is anchored to the measured position every tick.**  The obvious
implementation — integrate an internal reference toward the target and command
that — *winds up*.  When the jaws close on an object the integrator keeps
running to the target, the position error grows, and since the MIT law is
``tau = kp · err + tau_ff`` the commanded torque grows with it.  The gripper
would crush whatever is between the fingers with no force limit.  Anchoring to
measurement makes the error bounded by construction; the speed limit, not the
integrator, decides how fast the jaws approach.

**A trapezoid, not a constant speed.**  Three extra lines buy a continuous
velocity reference at start and stop (no current step, no audible clack), a
stopping-distance term so the jaws decelerate instead of arriving at full speed
and relying on the servo to brake, and a guarantee that the *reference* never
overshoots — so any overshoot is servo lag, bounded by ``kp``.

Contact detection
-----------------
Anchoring the reference is what makes the jaws safe, but it also destroys the
obvious contact signal: the commanded position is ``measured + step`` and nothing
else, so the position error stays tiny whether the jaws are moving or jammed.

The fix is to integrate the *ideal* path separately as :attr:`virtual_mm` — the
position the reference would have reached had nothing been in the way.  It is
never commanded, only compared, so it cannot wind up.  Where the jaws keep up,
``virtual_mm`` and the measurement agree and :attr:`ProfileOutput.lost_mm` stays
near zero; where they are held up, the gap grows at the reference speed.

This is a better contact signal than a torque threshold, which cannot tell a
blocked finger from an accelerating one: the inertial torque at full
acceleration is around 0.6 Nm on this mechanism, several times the friction of
free travel, so any torque threshold low enough to catch a light grip also fires
at the start of every move.

Push at the slow end
--------------------
Anchoring costs push, and the cost is proportional to the speed.  The error the
servo is given is one tick of travel, so the torque behind it is ``kp·v·dt``:
enough to overcome the friction of a stiff mechanism at 150 mm/s and nowhere near
it at 20.  The jaws then stand still, which is the same thing the contact signal
above is looking for, and calling that an obstruction is a report of the
console's own weakness.

:meth:`SpeedProfile.step` therefore takes a :class:`LeadCaps`: while the ideal
path is ahead of the jaws, the command may lead them by up to the cap in force.
It is bounded — which is what keeps the anchoring guarantee, that the servo's
position error is never larger than the mechanism can safely be asked for — and
it is applied only where a gap has already opened, so it titrates itself to the
friction actually in the way and a mechanism that keeps up never sees it.
Commanding the ideal path outright would be the unbounded version of the same
idea, and would leave every move running ``kp·lead/kd`` above the speed it was
asked for.

The cap has two tiers, and which one is in force is decided by how close the
move is to its target: a large one while travelling, to break static friction,
narrowing to a small one inside the press zone so that an arrival is not pressed
with the travelling squeeze.  See
:data:`~litearm_studio_daemon.gripper.constants.CONTACT_LEAD_TRAVEL_MM`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .. import constants
from ..units import Limits


@dataclass(frozen=True)
class ProfileOutput:
    """One tick's worth of trajectory."""

    q_cmd_mm: float
    """Position to command this tick, in mm."""

    vel_mm_s: float
    """Signed velocity feed-forward, in mm/s."""

    err_mm: float
    """Signed remaining distance to the target."""

    arrived: bool
    """True once ``|err| <= tol``.  The caller decides when that counts."""

    stalled: bool
    """True when the reference is at full speed but the jaws have not moved."""

    lost_mm: float
    """Motion the reference asked for that the jaws did not deliver.

    Grows only while the fingers are held up, so it is a direct measure of
    "pressed against something" — see :attr:`SpeedProfile.virtual_mm`.
    """

    contact: bool
    """True once :attr:`lost_mm` passes ``CONTACT_LOST_MM``."""


def _slew(current: float, target: float, max_delta: float) -> float:
    """Move ``current`` toward ``target`` by at most ``max_delta``."""
    if max_delta <= 0:
        return current
    delta = target - current
    if delta > max_delta:
        return current + max_delta
    if delta < -max_delta:
        return current - max_delta
    return target


@dataclass(frozen=True)
class LeadCaps:
    """The two ceilings on a plain move's lead, and where the low one applies.

    Mirrors the LiteGrip SDK's ``MotionConfig`` (``litegrip/actions.py``):
    ``travel_mm`` is ``max_lead_mm``, the cap while the move is still
    travelling; ``press_mm`` is ``stop_lead_mm``, the cap once the jaws are
    within ``press_zone_mm`` of the target.  The split is what lets a move push
    hard enough to break static friction without holding that push against a
    limit it has arrived at — see
    :data:`~litearm_studio_daemon.gripper.constants.CONTACT_LEAD_TRAVEL_MM`.
    """

    travel_mm: float
    press_mm: float
    press_zone_mm: float

    def cap_mm(self, remaining_mm: float) -> float:
        """The cap to use this tick, ``remaining_mm`` away from the target."""
        if remaining_mm <= self.press_zone_mm:
            return self.press_mm
        return self.travel_mm


#: The zero lead a force-carrying move wants: the plain anchored law.
NO_LEAD = LeadCaps(0.0, 0.0, 0.0)


class SpeedProfile:
    """Stateful wrapper around the trapezoid, one instance per motion.

    Usage: ``step(measured_mm, dt)`` once per control tick; feed the returned
    ``q_cmd_mm`` through :meth:`Limits.to_rad` and out as one MIT frame.
    """

    def __init__(
        self,
        limits: Limits,
        target_mm: float,
        speed_mm_s: float = constants.SPEED_DEFAULT_MM_S,
        acc_mm_s2: float = constants.ACC_DEFAULT_MM_S2,
        tol_mm: float = constants.TOL_MM,
    ) -> None:
        self.limits = limits
        self.speed_mm_s = limits.clamp_speed(speed_mm_s)
        self.acc_mm_s2 = max(acc_mm_s2, constants.ACC_MIN_MM_S2)
        self.tol_mm = max(tol_mm, 1.0e-6)

        self.target_mm = limits.clamp_mm(target_mm)
        self.v_ref = 0.0
        # The unobstructed path, integrated independently of the measurement.
        # ``None`` until the first step, which seeds it from the jaws.
        self.virtual_mm: float | None = None
        self._was_tracking = False
        self._stall_ticks = 0
        self._last_measured: float | None = None

    # ── control ─────────────────────────────────────────────────────────────
    def set_target(self, target_mm: float, speed_mm_s: float | None = None) -> None:
        """Retarget in flight.  The velocity reference is preserved, so a small
        correction continues smoothly instead of restarting the ramp."""
        self.target_mm = self.limits.clamp_mm(target_mm)
        if speed_mm_s is not None:
            self.speed_mm_s = self.limits.clamp_speed(speed_mm_s)
        self._stall_ticks = 0
        # A retarget invalidates the accumulated shortfall: the fingers may have
        # been resting on something, and that is no longer "lost" motion.
        self.virtual_mm = None

    def hold(self, measured_mm: float) -> ProfileOutput:
        """Command the measured position with zero velocity — used by HOLD."""
        q = self.limits.clamp_mm(measured_mm)
        self.v_ref = 0.0
        self.virtual_mm = q
        return _output(q, 0.0, 0.0, arrived=True)

    def step(self, measured_mm: float, dt: float, lead: LeadCaps = NO_LEAD) -> ProfileOutput:
        """Advance one tick and return what to command.

        ``lead`` is the two-tier ceiling on how far the command may run ahead of
        the measurement, over and above the tick's own step, while the ideal path
        is ahead of the jaws.  It is the fix for the one case the anchored
        reference cannot serve: at cruise the error it commands is one tick of
        travel, so the torque behind it falls with the speed and a mechanism with
        more friction than that stops — see
        :data:`~litearm_studio_daemon.gripper.constants.CONTACT_LEAD_TRAVEL_MM`.
        :data:`NO_LEAD` (the default) is the plain anchored law, and is what a
        force-carrying move wants.
        """
        if math.isnan(measured_mm) or dt <= 0:
            return _output(self.limits.clamp_mm(self.target_mm), 0.0, 0.0)

        measured = self.limits.clamp_mm(measured_mm)
        if self.virtual_mm is None:
            self.virtual_mm = measured

        err = self.target_mm - measured
        rem = abs(err)
        sign = 1.0 if err >= 0 else -1.0

        # Inside the arrival band: command the target exactly so the servo holds
        # it, and bleed the velocity reference to zero.
        #
        # Two things here are deliberate.  The reported velocity is the slewed
        # ``self.v_ref`` and never a literal 0, because the caller feeds it
        # straight into the MIT velocity term, where a step to zero is a torque
        # step of ``kd · v`` — 15 N at 50 mm/s.  And ``arrived`` is only raised
        # once that reference has actually reached zero: it is the condition the
        # caller switches to HOLD on, so it has to mean *stopped*, not merely
        # *within tolerance*.  Entering the band at speed is normal — the band is
        # 0.4 mm wide and the jaws cover that in one tick at any real speed — and
        # the ~40 ms of deceleration that follows happens under this branch,
        # reporting the true decaying velocity the whole way.
        if rem <= self.tol_mm:
            self.v_ref = _slew(self.v_ref, 0.0, self.acc_mm_s2 * dt)
            self.virtual_mm = measured
            return _output(
                self.target_mm, self.v_ref, err, arrived=self.v_ref == 0.0
            )

        # Decelerate to a stop before reversing — otherwise a target that flips
        # sign would be chased at the old speed.
        if self.v_ref * sign < 0.0:
            v_allow = 0.0
        else:
            # v = sqrt(2·a·s): the fastest we may go and still stop in `rem`.
            v_allow = math.sqrt(2.0 * self.acc_mm_s2 * max(rem - self.tol_mm, 0.0))
            v_allow = min(self.speed_mm_s, v_allow)

        self.v_ref = _slew(self.v_ref, sign * v_allow, self.acc_mm_s2 * dt)

        # The unobstructed path.  Never commanded — only compared against the
        # measurement to see how much motion went missing.  Deliberately NOT
        # clamped to the travel: clamping pins it at the target while the jaws
        # are still catching up, which reads as an enormous gap and reports
        # contact on an empty move.
        #
        # It is not integrated while the reference is still accelerating.  The
        # plant is chasing a moving target there and lags it by a few
        # millimetres — an artefact of acceleration, not of obstruction, and
        # several times larger than the gap a real contact produces in the time
        # it takes to notice.  Seeding the comparison once the reference has
        # caught up with the speed the trapezoid allows discards that transient
        # instead of trying to threshold past it.
        #
        # The test is against the speed allowed this tick (``v_allow``), not
        # against the move's top speed.  A move decelerating toward its target is
        # not accelerating, and the last millimetres — the press zone above all —
        # are exactly where the lead has to stay available: with the old
        # top-speed test a jaw that caught on the closing dead-band just short of
        # the limit had no push left to break it, so the move ended at its
        # deadline a few millimetres open (issue #72).
        tracking = sign * self.v_ref >= 0.0 and abs(self.v_ref) >= v_allow - 1e-9
        if tracking:
            if not self._was_tracking:
                # The shortfall is measured *from* the moment the reference is
                # tracking, so the tick that begins it has none.  Seeding and
                # integrating in the same tick puts a whole tick of travel into
                # the gap before the jaws have been given the chance to deliver
                # any of it, and the gap then never closes: a perfect plant sits
                # one tick of travel behind the ideal path forever, which at
                # 150 mm/s is 0.75 mm of the 1 mm contact budget spent on an
                # empty move.
                self.virtual_mm = measured
            else:
                self.virtual_mm += self.v_ref * dt
            lost_mm = max(0.0, (self.virtual_mm - measured) * sign)
        else:
            self.virtual_mm = measured
            lost_mm = 0.0
        self._was_tracking = tracking

        # What to command.  The tick's step is the whole of it on a mechanism
        # that keeps up: ``lost_mm`` is zero and the lead adds nothing.  It is
        # the mechanism that does *not* keep up that needs it, and the gap it has
        # already opened is what sizes it — so the extra push is never more than
        # the friction actually in the way, and it is bounded whatever the
        # friction turns out to be.  The cap narrows near the target so an
        # arrival is not pressed with the travelling squeeze, and it is charged
        # against the contact threshold rather than added to it, so a move that
        # meets something still calls it after ``CONTACT_LOST_MM`` of unmet
        # demand however large the cap is.
        lead_mm = min(lost_mm, max(lead.cap_mm(rem), 0.0))
        advance = abs(self.v_ref * dt) + lead_mm
        if advance > rem:  # never let the reference overshoot the target
            advance = rem
        q_cmd = self.limits.clamp_mm(measured + sign * advance)

        # Stall: we are asking for motion and getting none.
        stalled = False
        if self._last_measured is not None:
            moved = abs(measured - self._last_measured)
            if moved < constants.STALL_RAD / max(self.limits.rad_to_mm, 1e-9):
                self._stall_ticks += 1
                stalled = self._stall_ticks >= constants.STALL_WINDOW
            else:
                self._stall_ticks = 0
        self._last_measured = measured

        return _output(
            q_cmd,
            self.v_ref,
            err,
            stalled=stalled,
            lost_mm=lost_mm,
            contact=lost_mm + lead_mm >= constants.CONTACT_LOST_MM,
        )


def _output(
    q_cmd_mm: float,
    vel_mm_s: float,
    err_mm: float,
    *,
    arrived: bool = False,
    stalled: bool = False,
    lost_mm: float = 0.0,
    contact: bool = False,
) -> ProfileOutput:
    """Build a :class:`ProfileOutput`, defaulting the contact fields."""
    return ProfileOutput(
        q_cmd_mm=q_cmd_mm,
        vel_mm_s=vel_mm_s,
        err_mm=err_mm,
        arrived=arrived,
        stalled=stalled,
        lost_mm=lost_mm,
        contact=contact,
    )


def simulate(
    limits: Limits,
    start_mm: float,
    target_mm: float,
    speed_mm_s: float = constants.SPEED_DEFAULT_MM_S,
    acc_mm_s2: float = constants.ACC_DEFAULT_MM_S2,
    dt: float = constants.CTRL_DT,
    max_ticks: int = 20000,
    tol_mm: float = constants.TOL_MM,
) -> list[ProfileOutput]:
    """Run a profile against an ideal (instantly-tracking) plant.

    Test and analysis helper: the real plant lags, but this isolates the
    trajectory's own properties — no overshoot, no overspeed, finite settle.
    """
    prof = SpeedProfile(limits, target_mm, speed_mm_s, acc_mm_s2, tol_mm)
    out: list[ProfileOutput] = []
    measured = start_mm
    for _ in range(max_ticks):
        step = prof.step(measured, dt)
        out.append(step)
        measured = step.q_cmd_mm
        if step.arrived:
            break
    return out
