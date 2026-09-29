"""The motion state machine — one MIT frame per tick, never a blocking call.

Every state's ``tick`` sends at most one frame and returns, so the worker's loop
stays interruptible: an E-stop, a new slider target or a fault is noticed within
one 5 ms tick.  That property is the whole reason the console drives the motor
through ``send_mit_frame`` instead of any SDK convenience method, all of which
block inside ``control_mit_stream`` with no abort hook.

Force semantics
---------------
A force setpoint is a torque feed-forward, and two things make it mean what it
says.

**The reference freezes at contact.**  The SDK's ``set_force``
(gripper.py:988-997) commands ``q_target = get_position()`` plus
``tau_feedforward``, and the reason is not cosmetic: a reference that keeps
advancing past a blocked object grows the MIT position error ``kp·(q_cmd − q)``
without bound, and that term adds to the feed-forward.  Measured in simulation,
a 40 N setpoint delivered 59 N with the reference advancing.

**The position gain is zero while holding force.**  This is where this console
deliberately diverges from the SDK, which holds force at ``kp=150``.  Any
position term is added to the feed-forward, so the delivered force depends on
how far the jaws sank into the object — with ``kp=150`` a 40 N setpoint landed
at 31 N against a 500 Nm/rad object, and would run *over* the setpoint against a
stiffer one.  With ``kp=0`` the torque is the feed-forward alone and the grip
force equals the setpoint, which is what makes the 40 N rating a real bound
rather than an aspiration.  ``kd`` still damps velocity, and the two guards
below still stop the jaws running away:

* the reference is clamped to the calibrated travel, so even with no object the
  fingers halt at the closed stop;
* the feed-forward is capped by :func:`~litearm_studio_daemon.gripper.units.clamp_force_torque`.

A force-mode close therefore cannot exceed its setpoint anywhere in its travel,
including against the hard stop.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum

from .. import constants
from ..units import Limits, clamp_force, clamp_force_torque, mm_to_rad_per_s
from .profile import SpeedProfile


class MotionState(str, Enum):
    IDLE = "IDLE"
    HOLD = "HOLD"
    #: A hold at an angle rather than at a millimetre — the only position
    #: command in this class that no travel is needed to express.  See
    #: :meth:`MotionFSM.hold_rad`.
    HOLD_RAD = "HOLD_RAD"
    SERVO = "SERVO"
    HOLD_FORCE = "HOLD_FORCE"
    RELEASE = "RELEASE"
    ZERO_G = "ZERO_G"
    FAULT = "FAULT"
    BLOCKED = "BLOCKED"


@dataclass(frozen=True)
class FrameOut:
    """What the FSM commanded this tick — carried into telemetry."""

    q_cmd_mm: float | None
    vel_ref_mm_s: float
    err_mm: float | None
    kp: float
    kd: float
    tau_nm: float
    sent: bool
    note: str = ""


@dataclass
class MotionParams:
    """Command parameters, settable from the GUI while running."""

    speed_mm_s: float = constants.SPEED_DEFAULT_MM_S
    acc_mm_s2: float = constants.ACC_DEFAULT_MM_S2
    force_n: float = constants.FORCE_DEFAULT_N
    kp: float = constants.KP_MOVE
    kd: float = constants.KD_DEFAULT


class MotionFSM:
    """Owns the commanded trajectory.  Call :meth:`tick` once per control tick."""

    def __init__(self, limits: Limits, params: MotionParams | None = None) -> None:
        self.limits = limits
        self.params = params or MotionParams()
        self.state = MotionState.IDLE
        self.profile: SpeedProfile | None = None
        self.source = ""
        self.last_command_mm: float | None = None

        self._force_n: float = 0.0  # setpoint carried by the active move
        self._frozen_mm: float | None = None
        # The pose held by HOLD_RAD, in radians and never clamped.  Meaningful
        # only in that state; every other state that holds a pose holds it in
        # millimetres, and there is deliberately no path from one to the other.
        self._frozen_rad: float | None = None
        # The ramped torque feed-forward and velocity reference.  ``None``
        # means "not in force mode", which seeds both from what is in flight.
        self._tau_cmd: float | None = None
        self._vel_cmd_rad = 0.0
        self._settle_ticks = 0
        self._elapsed = 0.0
        # How long this move may take before it is declared lost.  ``None``
        # until the first tick of the move, because it depends on how far the
        # jaws actually are from the target, which is only known from telemetry.
        self._deadline_s: float | None = None
        self._stall_reported = False
        self._note = ""
        # The most recent ProfileOutput, for telemetry and diagnosis.
        self.last_profile_out = None

    # ── configuration ───────────────────────────────────────────────────────
    def set_limits(self, limits: Limits) -> None:
        self.limits = limits
        if self.profile is not None:
            self.profile.limits = limits

    def set_gains(self, kp: float, kd: float) -> None:
        self.params.kp = kp
        self.params.kd = kd

    def set_speed(self, speed_mm_s: float) -> None:
        self.params.speed_mm_s = self.limits.clamp_speed(speed_mm_s)

    def set_force(self, force_n: float) -> None:
        from ..units import clamp_force

        self.params.force_n = clamp_force(force_n)

    # ── commands ────────────────────────────────────────────────────────────
    def move_to_mm(self, target_mm: float, source: str, force_n: float | None = None) -> None:
        """Servo to ``target_mm``, optionally capping the squeeze at ``force_n``.

        ``force_n`` defaults to *no force limit* rather than to the configured
        grasp force.  Inheriting a default here would put every plain move —
        including ``open()`` — into force mode, where the position gain is zero
        and the fingers would drive at the force setpoint instead of tracking
        the trajectory.  Force is opt-in, and only :meth:`grasp` and an explicit
        ``close(force_n=...)`` ask for it.
        """
        target = self.limits.clamp_mm(target_mm)
        self.last_command_mm = target
        self.source = source
        # Clamped on the way in, so the setpoint held anywhere in this class is
        # always a force the mechanism can actually apply.  The frame is clamped
        # independently further down, but ``force_setpoint()`` is published to
        # the UI, and a state machine that reports a 999 N grip is lying about
        # the one number an operator reads to decide whether to stand clear.
        self._force_n = 0.0 if force_n is None else clamp_force(force_n)
        self._tau_cmd = None
        self._vel_cmd_rad = 0.0
        self._settle_ticks = 0
        self._elapsed = 0.0
        self._deadline_s = None
        self._stall_reported = False
        self._note = ""

        if self.profile is None:
            self.profile = SpeedProfile(
                self.limits, target, self.params.speed_mm_s, self.params.acc_mm_s2
            )
        else:
            self.profile.set_target(target, self.params.speed_mm_s)
        self.state = MotionState.SERVO

    def open(self, source: str = "open") -> None:
        self.move_to_mm(self.limits.max_stroke_mm, source)

    def close(self, source: str = "close", force_n: float | None = None) -> None:
        self.move_to_mm(0.0, source, force_n=force_n)

    def grasp(self, force_n: float | None = None, source: str = "grasp") -> None:
        """Close until contact, then hold the contact point with ``tau_ff``."""
        self.move_to_mm(0.0, source, force_n=force_n if force_n is not None else self.params.force_n)

    def hold(self, measured_mm: float) -> None:
        """Stop moving and hold where we are, with zero feed-forward torque."""
        self.state = MotionState.HOLD
        self.profile = None
        self._force_n = 0.0
        self._tau_cmd = None
        self._vel_cmd_rad = 0.0
        self._frozen_mm = self.limits.clamp_mm(measured_mm)
        self._frozen_rad = None
        self.last_command_mm = None
        self.source = "stop"
        self._note = ""

    def hold_rad(self, measured_rad: float) -> None:
        """Hold at the angle the motor just reported.

        The one position command here that is expressed in nothing but the
        encoder's own reading, and therefore the only one that means the same
        thing under every calibration.  A hold in millimetres cannot say that:
        it goes through ``clamp_mm``/``clamp_rad``, so under limits that are
        wrong — or merely not in force yet — "stay where you are" becomes a
        command to drive somewhere inside a travel.

        That matters at the end of a probe, which is the one motion in the
        console that deliberately leaves the calibrated travel: it goes looking
        for the mechanical stops, and it stops *on* one.  The pose to hand back
        is the one the jaws are in, which is exactly what this holds.
        """
        self.state = MotionState.HOLD_RAD
        self.profile = None
        self._force_n = 0.0
        self._tau_cmd = None
        self._vel_cmd_rad = 0.0
        self._frozen_rad = float(measured_rad)
        self._frozen_mm = None
        self.last_command_mm = None
        self.source = "stop"
        self._note = ""

    def hold_force(self, force_n: float, measured_mm: float, source: str = "hold_force") -> None:
        """Freeze at the current position and apply a grip force there."""
        self.state = MotionState.HOLD_FORCE
        self.profile = None
        self._force_n = clamp_force(force_n)
        self._tau_cmd = None
        self._vel_cmd_rad = 0.0
        self._frozen_mm = self.limits.clamp_mm(measured_mm)
        self._frozen_rad = None
        self.last_command_mm = self._frozen_mm
        self.source = source
        self._note = ""

    def release(self, source: str = "release") -> None:
        """Zero stiffness and zero torque — the jaws can be moved by hand."""
        self.state = MotionState.RELEASE
        self.profile = None
        self._force_n = 0.0
        self._tau_cmd = None
        self._vel_cmd_rad = 0.0
        self.last_command_mm = None
        self.source = source
        self._note = ""

    def zero_gravity(
        self, on: bool, measured_mm: float | None = None, source: str = "zero_g"
    ) -> None:
        """Enter/leave zero gravity.  Same frames as RELEASE; distinct label.

        Entering needs no measurement — zero stiffness commands no pose — but
        leaving does, because it holds the pose the jaws are in.  ``None`` means
        the caller has not measured one, and the only state that asks nothing of
        a position nobody has measured is RELEASE, so that is what it becomes.
        """
        if on:
            self.state = MotionState.ZERO_G
            self.profile = None
            self._force_n = 0.0
            self._tau_cmd = None
            self._vel_cmd_rad = 0.0
            self.last_command_mm = None
            self.source = source
        elif measured_mm is None:
            self.release(source)
        else:
            self.hold(measured_mm)
            self.source = source

    def fault(self) -> None:
        self.state = MotionState.FAULT
        self.profile = None
        self._force_n = 0.0
        self._tau_cmd = None
        self._vel_cmd_rad = 0.0
        self.last_command_mm = None
        self._note = ""

    def idle(self) -> None:
        self.state = MotionState.IDLE
        self.profile = None
        self._force_n = 0.0
        self._tau_cmd = None
        self._vel_cmd_rad = 0.0
        self.last_command_mm = None

    # ── the tick ────────────────────────────────────────────────────────────
    def tick(
        self,
        backend,
        telemetry,
        dt: float,
        allow_motion: bool,
        blocked_reason: str = "",
        telemetry_current: bool = True,
    ) -> FrameOut:
        """Send one frame for the current state.

        ``allow_motion`` is the gate plus link/error health.  It is re-checked
        here, on the worker thread, rather than trusted from the UI: a bug in a
        widget must not be able to drive an uncalibrated motor.

        ``telemetry_current`` is the other half of that health: whether the
        snapshot describes *now*.  It is the worker's to know — a backend can
        only report what it observed, and ``Telemetry`` carries no age — and it
        matters because stillness in an old reading is not evidence of anything;
        see :data:`~litearm_studio_daemon.gripper.constants.CONTACT_FRESH_MS`.
        """
        pos_mm = self.limits.clamp_mm(telemetry.position_mm)
        p = self.params

        # ── states that never need the gate ─────────────────────────────────
        if self.state in (MotionState.IDLE, MotionState.FAULT):
            return FrameOut(None, 0.0, None, 0.0, 0.0, 0.0, False, "idle")

        if self.state in (MotionState.RELEASE, MotionState.ZERO_G):
            # Zero stiffness has nothing to gate: there is no command to get
            # wrong, and the point of these states is that the jaws are free.
            # ``ungated`` because of that: this frame must reach the motor on a
            # console whose calibration is unusable, or 零重力 does nothing and an
            # operator with a bad file cannot move the jaws by hand — which is
            # exactly when they need to re-calibrate.
            return self._send(
                backend, pos_mm, 0.0, 0.0, 0.0, 0.0, 0.0, self.state.value, ungated=True
            )

        if self.state is MotionState.HOLD_RAD:
            # The other state a shut gate cannot refuse, and for the same
            # reason: nothing here is derived from the limits in doubt.  It is
            # a position *hold*, though, where RELEASE is a position *release* —
            # the difference between an axis that stays where it was left and
            # one that is free to go wherever the mechanism's own springs push
            # it, which at the end of a probe is where the operator is looking.
            return self._hold_rad_frame(backend)

        if self.state is MotionState.BLOCKED:
            # A move that was refused.  It is abandoned, not resumed: the
            # operator re-issues once the gate is open again, because the jaws
            # have usually moved by then and the trajectory is stale.
            if not allow_motion:
                return self._refused(blocked_reason)
            self.hold(pos_mm)
            return self._hold_frame(backend, pos_mm)

        # ── every remaining state commands a position derived from the limits,
        #    so every one of them is gated ───────────────────────────────────
        if not allow_motion:
            if self.state is MotionState.SERVO:
                self._block(pos_mm, blocked_reason)
            return self._refused(blocked_reason)

        if self.state is MotionState.HOLD:
            # Keeps sending frames so the pose is held — the motor needs a
            # command to stay put — but there is no torque in it.
            return self._hold_frame(backend, pos_mm)

        if self.state is MotionState.HOLD_FORCE:
            frozen = self._frozen_mm if self._frozen_mm is not None else pos_mm
            return self._force_frame(backend, frozen, telemetry, dt, "hold_force")

        # ── SERVO ───────────────────────────────────────────────────────────
        assert self.profile is not None
        self._elapsed += dt
        # A plain move gets the bounded lead that keeps its push independent of
        # the speed it was sent at; a force-carrying one does not, because there
        # the position gain is the approach gain and the same lead on its own
        # would read as the contact it is trying to detect.
        out = self.profile.step(
            pos_mm, dt, 0.0 if self._force_n > 0.0 else constants.CONTACT_LEAD_RAD
        )
        self.last_profile_out = out
        if self._deadline_s is None:
            self._deadline_s = self._move_deadline(abs(out.err_mm))

        # Contact or obstruction.  On a force-carrying move, freeze here and
        # switch to pure torque instead of pushing — see the module docstring
        # for why the freeze and the zero position gain are both required.
        #
        # The lost-motion half of the test is a claim about *now*, and a reading
        # that arrived some frames ago cannot make it: a cached position
        # accumulates the gap at the reference speed while the jaws travel
        # perfectly well, and the velocity in that same stale frame is zero, so
        # nothing downstream can veto it.  The torque channel needs no such
        # guard — a torque is what the drive is applying, whenever it was read.
        contact = (out.contact and telemetry_current) or (
            self._force_n > 0.0 and abs(telemetry.torque_nm) >= constants.CONTACT_TAU_NM
        )
        if contact:
            if self._force_n > 0.0:
                self.hold_force(self._force_n, pos_mm, source=self.source)
                return self._force_frame(backend, pos_mm, telemetry, dt, "contact")
            if self._jaws_have_stopped(telemetry, out.vel_mm_s):
                self._stall_reported = True
                self.hold(pos_mm)
                self._note = "堵转：位置未随时间变化"
                return FrameOut(None, 0.0, None, 0.0, 0.0, 0.0, False, self._note)
            # A gap that is still closing while the jaws keep moving is the
            # mechanism lagging the model, not something in the way — see
            # :data:`~litearm_studio_daemon.gripper.constants.CONTACT_STILL_RATIO`.  The move
            # carries on and the gap is re-tested every tick, so jaws that really
            # have been brought to a stop against something are caught on the
            # tick they stop.

        if out.arrived:
            self._settle_ticks += 1
            if self._force_n > 0.0:
                # Reached the target (or the closed stop) under force: hold the
                # force at the resting position.
                self.hold_force(self._force_n, pos_mm, source=self.source)
                return self._force_frame(backend, pos_mm, telemetry, dt, "grip")
            if self._settle_ticks * dt >= constants.SETTLE_S:
                target = self.limits.clamp_mm(self.last_command_mm or pos_mm)
                self.hold(target)
                return self._send(backend, target, 0.0, p.kp, p.kd, 0.0, 0.0, "arrived")
        else:
            self._settle_ticks = 0

        if self._elapsed >= self._deadline_s and not self._stall_reported:
            # Neither arrived nor counted as stalled: the jaws are creeping too
            # slowly to look stuck, but they are not converging either.  Stop
            # and say so rather than keep pressing indefinitely.
            self._stall_reported = True
            self.hold(pos_mm)
            self._note = f"{self._deadline_s:.0f}s 内未到位，已停止"
            return FrameOut(None, 0.0, None, 0.0, 0.0, 0.0, False, self._note)

        return self._send(
            backend,
            out.q_cmd_mm,
            out.vel_mm_s,
            # Approach softly whenever a force setpoint is pending: the gain in
            # force during the approach is the squeeze applied before contact is
            # detected, so it is a force-control parameter, not a servo one.
            constants.KP_GRASP_APPROACH if self._force_n > 0.0 else p.kp,
            p.kd,
            0.0,
            out.err_mm,
            "servo",
        )

    # ── gate refusal ────────────────────────────────────────────────────────
    def _block(self, measured_mm: float, reason: str) -> None:
        """Abandon the active move because the gate is shut."""
        self.state = MotionState.BLOCKED
        self.profile = None
        self._force_n = 0.0
        self._tau_cmd = None
        self._vel_cmd_rad = 0.0
        self._frozen_mm = self.limits.clamp_mm(measured_mm)
        self._frozen_rad = None
        self._note = reason

    def _refused(self, reason: str) -> FrameOut:
        """Send nothing at all while the gate is shut.

        Not even a hold frame, and that is the whole point: with the gate shut it
        is the *limits* that are in doubt, and ``q_cmd`` is derived from them.
        Under a reversed calibration every millimetre reading maps to an angle
        that drives the wrong way, so "hold still" can be a command to close hard.
        The worker zero-torques alongside this, so the motor is not left acting on
        whatever frame it last received.
        """
        if reason:
            self._note = reason
        return FrameOut(None, 0.0, None, 0.0, 0.0, 0.0, False, self._note)

    # ── contact corroboration ───────────────────────────────────────────────
    def _jaws_have_stopped(self, telemetry, ref_mm_s: float) -> bool:
        """Whether the jaws are held still, rather than merely lagging.

        The lost-motion gap says the jaws are behind where the trajectory
        expected them; this says whether they are behind because something is
        holding them or because the mechanism simply does not keep up.  Only the
        second reading is an obstruction, and the difference between them is the
        measured speed against the speed that was asked for — see
        :data:`~litearm_studio_daemon.gripper.constants.CONTACT_STILL_RATIO`.

        Measured as a fraction, so the answer does not depend on the speed
        setting.  A reference of zero has no yardstick to compare against and is
        reported as "not stopped": a gap cannot accumulate without the reference
        at cruise, so nothing is lost by leaving that case to the move deadline.
        A velocity that cannot be read is not evidence of an obstruction either,
        and the same backstop bounds it.
        """
        ref_rad_s = abs(
            mm_to_rad_per_s(
                ref_mm_s, self.limits.rad_to_mm, direction=self.limits.direction
            )
        )
        if ref_rad_s <= 0.0:
            return False
        measured_rad_s = abs(telemetry.velocity_rad_s)
        if not math.isfinite(measured_rad_s):
            return False
        return measured_rad_s <= constants.CONTACT_STILL_RATIO * ref_rad_s

    # ── deadlines ───────────────────────────────────────────────────────────
    def _move_deadline(self, distance_mm: float) -> float:
        """How long this move may take before it is declared lost.

        The ideal trapezoid duration — the ramp up and down, plus the cruise
        between them, or the triangular profile if the move is too short to reach
        the commanded speed — times :data:`STALL_TIMEOUT_FACTOR`, floored at
        :data:`STALL_TIMEOUT_MIN_S`.  Scaling it with the move is what lets the
        slow end of the speed slider finish: a fixed deadline refuses to let a
        120 mm move at 5 mm/s take the 24 s it is supposed to take.
        """
        p = self.params
        speed = max(p.speed_mm_s, 1e-9)
        acc = max(p.acc_mm_s2, 1e-9)
        distance = max(distance_mm, 0.0)

        if distance <= speed * speed / acc:
            ideal = 2.0 * math.sqrt(distance / acc)  # triangular: never at cruise
        else:
            ideal = distance / speed + speed / acc
        return max(constants.STALL_TIMEOUT_MIN_S, ideal * constants.STALL_TIMEOUT_FACTOR)

    # ── frame assembly ──────────────────────────────────────────────────────
    def _hold_frame(self, backend, pos_mm: float) -> FrameOut:
        """Command the frozen pose with the position gain and no feed-forward."""
        # A millimetre hold and a hold at an angle are two different commands
        # that both look like HOLD to a reader of the frames, so the state that
        # owns each one is the only thing keeping them apart.  A frozen angle
        # here means the state and the fields disagree.
        assert self._frozen_rad is None
        q = self._frozen_mm if self._frozen_mm is not None else pos_mm
        p = self.params
        return self._send(backend, q, 0.0, p.kp, p.kd, 0.0, 0.0, "hold")

    def _hold_rad_frame(self, backend) -> FrameOut:
        """The same hold, sent straight to the backend without the limits.

        ``_send`` puts every command through ``clamp_mm`` and ``clamp_rad``,
        which is what makes a commanded position safe — and is exactly what
        this one must not have.  A hold at the angle the motor just reported is
        the identity: clamped, it would become a command to leave that angle,
        and the limits it would be clamped by are the ones nobody has vetted
        yet.  So the frame is built here, and ``q_cmd_mm`` is ``None`` because
        there is no millimetre this command corresponds to.
        """
        # The twins of the two assertions at the top of ``_hold_frame``, and
        # they are what keeps the two ways of freezing an axis from drifting
        # into each other: exactly one of the two fields is live, and this is
        # the state that says which.
        assert self._frozen_rad is not None
        assert self._frozen_mm is None
        p = self.params
        # ``ungated``: the pose held here is the one the encoder just reported,
        # and behind a shut gate it is outside the travel by definition — the
        # gate is shut because the file does not describe this gripper.  A
        # *gated* hold would be refused here, leaving the log claiming the axis
        # is held while it is actually free.
        sent = bool(
            backend.stream_frame(self._frozen_rad, p.kp, p.kd, 0.0, 0.0, ungated=True)
        )
        return FrameOut(None, 0.0, None, p.kp, p.kd, 0.0, sent, "hold_rad")

    def _force_frame(
        self, backend, hold_mm: float, telemetry, dt: float, note: str
    ) -> FrameOut:
        """The frame for every force-holding state: ramp to pure torque, kp=0.

        The position gain is zero — see the module docstring for why that is
        what makes the delivered force equal the setpoint, and therefore what
        makes ``FORCE_MAX_N`` an actual cap rather than an aspiration.

        Both remaining terms are ramped rather than stepped, and each fixes a
        measured overshoot:

        *Torque.*  Stepping the feed-forward makes the fingers bounce off the
        object and the damping term fight the rebound — 56 N from a 40 N grip.

        *Velocity reference.*  The damping term is ``kd·(dq_cmd − dq)``, so
        zeroing ``dq_cmd`` while the jaws are still moving is itself a torque
        step proportional to approach speed: 15 N at 50 mm/s and 46 N at
        150 mm/s, applied to whatever was just touched.  Seeding the reference
        at the measured velocity starts that term at zero and lets it decay.

        Note that this is also why the force displayed during a *free* move is
        not zero: a braking torque is a real motor torque.  Only the settled
        value after the ramp is the grip force.
        """
        target = clamp_force_torque(self._force_n)
        alpha = min(dt / constants.FORCE_RAMP_S, 1.0)
        if self._tau_cmd is None:
            # Entering force mode: continue from the torque in flight so the
            # transition is continuous.
            self._tau_cmd = (
                telemetry.torque_nm if abs(telemetry.torque_nm) < abs(target) else target
            )
            self._vel_cmd_rad = telemetry.velocity_rad_s

        self._tau_cmd += (target - self._tau_cmd) * alpha
        self._vel_cmd_rad += (0.0 - self._vel_cmd_rad) * alpha

        return self._send(
            backend,
            hold_mm,
            0.0,
            0.0,
            self.params.kd,
            self._tau_cmd,
            0.0,
            note,
            dq_rad=self._vel_cmd_rad,
        )

    def _send(
        self,
        backend,
        q_cmd_mm: float,
        vel_mm_s: float,
        kp: float,
        kd: float,
        tau_nm: float,
        err_mm: float,
        note: str,
        dq_rad: float | None = None,
        ungated: bool = False,
    ) -> FrameOut:
        q_mm = self.limits.clamp_mm(q_cmd_mm)
        q_rad = self.limits.clamp_rad(self.limits.to_rad(q_mm))
        if dq_rad is None:
            dq_rad = mm_to_rad_per_s(
                vel_mm_s, self.limits.rad_to_mm, direction=self.limits.direction
            )
        sent = bool(backend.stream_frame(q_rad, kp, kd, dq_rad, tau_nm, ungated=ungated))
        return FrameOut(
            q_cmd_mm=q_mm,
            vel_ref_mm_s=vel_mm_s,
            err_mm=err_mm,
            kp=kp,
            kd=kd,
            tau_nm=tau_nm,
            sent=sent,
            note=note or self._note,
        )

    # ── introspection ───────────────────────────────────────────────────────
    @property
    def note(self) -> str:
        return self._note

    @property
    def is_moving(self) -> bool:
        return self.state is MotionState.SERVO

    def force_setpoint(self) -> float:
        return self._force_n if self.state is MotionState.HOLD_FORCE else 0.0


def simulate_move(
    limits: Limits,
    start_mm: float,
    target_mm: float,
    speed_mm_s: float = constants.SPEED_DEFAULT_MM_S,
    dt: float = constants.CTRL_DT,
    max_ticks: int = 20000,
) -> tuple[list[FrameOut], MotionState]:
    """Drive a :class:`MotionFSM` against an ideal plant.  Test helper."""

    class _Ideal:
        def __init__(self) -> None:
            self.mm = start_mm

        def stream_frame(self, q_rad, kp, kd, dq=0.0, tau=0.0, *, ungated=False) -> bool:
            del ungated  # an ideal plant has no gate to relax
            self.mm = limits.to_mm(q_rad)
            return True

    from ..telemetry import Telemetry

    backend = _Ideal()
    fsm = MotionFSM(limits, MotionParams(speed_mm_s=speed_mm_s))
    fsm.move_to_mm(target_mm, "test")
    outs: list[FrameOut] = []
    for _ in range(max_ticks):
        tele = Telemetry(position_mm=backend.mm, position_rad=limits.to_rad(backend.mm))
        outs.append(fsm.tick(backend, tele, dt, allow_motion=True))
        if fsm.state is not MotionState.SERVO:
            break
    return outs, fsm.state
