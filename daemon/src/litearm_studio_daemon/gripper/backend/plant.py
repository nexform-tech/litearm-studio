"""A pure model of the gripper's dynamics.

Deliberately has no clock, no ``sleep``, no threads and no Qt: :meth:`Plant.step`
is a pure function of the elapsed ``dt``, so the whole model is deterministic and
testable, and the real-time pacing lives in :mod:`litearm_studio_daemon.gripper.backend.sim`.

The model is the DM4310 MIT law the SDK actually commands::

    tau = kp·(q_cmd − q) + kd·(dq_cmd − dq) + tau_ff

followed by a first-order current-loop lag, Coulomb + viscous friction, and
integration.  Hard stops and an optional object between the jaws enter as
*damped springs* added to the dynamics, so the jaws settle a fraction of a
millimetre into whatever they pushed against — which is what a real finger does.

Two modelling choices are load-bearing and were both wrong in a first cut:

*Contact is a spring, not a position clamp.*  Clamping the position makes the
reaction an impulsive constraint force that is unbounded and has nothing to do
with the motor's torque — it produced 4600 N transients.  As a spring, the
equilibrium is self-consistent: the motor's torque IS the grip force.

*The reported torque is the motor's torque alone.*  Adding a separate contact
term to it double-counts the reaction, and the sum was independent of the force
setpoint (every setpoint from 5 N to 999 N reported the same 112.5 N).  The SDK
reads the motor's own torque estimate, so that is what this reports.

The friction and thermal coefficients are tuning choices, not datasheet values.
Their job is to make the simulated gripper behave *plausibly enough to exercise
the UI*: visible tracking lag, force that climbs when blocked, temperature that
responds to sustained effort.  ``tests/test_plant.py`` pins the behaviours that
matter, so if these numbers move the test says why they were chosen.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .. import constants
from ..telemetry import Telemetry
from ..units import Limits, derive_scale, force_from_torque


#: The two angles of the SDK's bundled example calibration, kept because they put
#: the simulator in the same angular range as a real bench unit.
_CLOSED_RAD = 1.775959
_OPEN_RAD = -0.064279


@dataclass
class PlantConfig:
    """Physical parameters of the simulated unit.

    Defaults describe the example user calibration shipped with the SDK
    (``zero 1.775959`` / ``open −0.064279``), so the simulator's numbers land in
    the same range as a real bench unit's.  The millimetres per rad is derived
    from those angles and the travel the console is configured for, exactly as a
    real calibration's is: the SDK's example file says 65.21, which is its own
    120 mm nominal over this travel, and a simulated gripper built on that number
    would reproduce the very defect the derivation exists to remove — a slider
    spanning a fraction of the travel its jaws actually have.
    """

    closed_rad: float = _CLOSED_RAD
    open_rad: float = _OPEN_RAD
    rad_to_mm: float = round(
        derive_scale(abs(_CLOSED_RAD - _OPEN_RAD), constants.DEFAULT_TRAVEL_MM), 2
    )

    inertia: float = 0.10  # kg·m², reflected through the fingers
    viscous: float = 0.02  # Nm·s/rad
    coulomb: float = 0.01  # Nm
    tau_elec: float = 0.005  # s, current-loop lag
    tau_limit: float = 10.0  # Nm — DM4310 rating, == 100 N theoretical

    # Contact stiffness/damping.  Stiff enough to stop the jaws promptly,
    # soft enough to integrate stably with explicit Euler at 200 Hz and to
    # keep the impulse from a full-speed arrival bounded: the damping torque is
    # ``c · ω``, and at 150 mm/s (2.3 rad/s) a critical-damping value for
    # k=2000 (c=28) would apply over 60 Nm to the frame.
    #
    # Implied penetration at the 10 Nm torque limit is 10/800 = 0.0125 rad
    # (0.8 mm) into a hard stop and 10/500 = 0.02 rad (1.3 mm) into an object.
    # Damping ratios land near critical; ω·dt stays well inside the explicit
    # Euler stability bound of ~2.
    stop_k: float = 800.0  # Nm/rad against a hard stop, ω·dt ≈ 0.45
    stop_c: float = 12.0  # Nm·s/rad, ζ ≈ 0.67
    contact_k: float = 500.0  # Nm/rad against an object between the jaws
    contact_c: float = 8.0  # Nm·s/rad, ζ ≈ 0.57

    amb_temp: float = 28.0
    # I²R-like heating: proportional to tau², so sustained grip is what warms it.
    mos_heat_gain: float = 0.02
    mos_cool_rate: float = 0.06
    coil_heat_gain: float = 0.015
    coil_cool_rate: float = 0.02

    status_hz: float = 500.0  # the motor emits status frames at its own rate


class Plant:
    """The simulated gripper.  Call :meth:`step` once per control tick."""

    def __init__(self, config: PlantConfig | None = None) -> None:
        self.config = config or PlantConfig()
        self.limits = Limits(
            self.config.closed_rad, self.config.open_rad, self.config.rad_to_mm
        )

        self.q = self.config.closed_rad  # start closed, like a powered-off unit
        self.dq = 0.0
        self.tau = 0.0
        self.temp_mos = self.config.amb_temp
        self.temp_coil = self.config.amb_temp

        # Last command received from the controller.
        self._q_cmd = self.q
        self._dq_cmd = 0.0
        self._kp = 0.0
        self._kd = 0.0
        self._tau_ff = 0.0

        self._status_accum = 0.0

        # Optional obstruction: a rigid object this many mm open blocks closing.
        self.object_mm: float | None = None

    # ── external interface ──────────────────────────────────────────────────
    def stream(
        self, q: float, kp: float, kd: float, dq: float = 0.0, tau: float = 0.0
    ) -> None:
        """Latch the command the controller just sent."""
        self._q_cmd = q
        self._kp = kp
        self._kd = kd
        self._dq_cmd = dq
        self._tau_ff = tau

    def step(self, dt: float) -> None:
        """Advance the dynamics by ``dt`` seconds."""
        if dt <= 0.0:
            return
        cfg = self.config

        # MIT control law, then the drive's torque limit.
        tau_cmd = (
            self._kp * (self._q_cmd - self.q)
            + self._kd * (self._dq_cmd - self.dq)
            + self._tau_ff
        )
        tau_ll = _clamp(tau_cmd, -cfg.tau_limit, cfg.tau_limit)

        # First-order current-loop lag.
        alpha = min(dt / cfg.tau_elec, 1.0) if cfg.tau_elec > 0 else 1.0
        self.tau += (tau_ll - self.tau) * alpha

        # Reaction from whatever the fingers are pressed against.
        #
        # Worked out in millimetres and converted once at the end, because
        # millimetres are what the two stops are *named* by: nought is closed and
        # the full stroke is open, whichever way round the encoder runs.  Written
        # in q instead — "past the larger angle, so pressed into the closed stop"
        # — it is only correct on the classic mounting, and on a reverse-mounted
        # gripper it silently swaps the two stops, and the object contact with
        # them, which is the same class of mistake as the conversion formulas.
        #
        # ``to_mm`` is a linear map and so is defined past both stops: a negative
        # reading is past the closed stop, one above ``stroke_mm`` is past the
        # open one.  Each spring restores toward zero penetration and each damps
        # the motion, hence the ``- *_c * dq``: the damping term must oppose the
        # velocity, and writing ``+ stop_c * dq`` on one of them made it
        # accelerate the jaws *through* the stop instead of absorbing them (a
        # −22 Nm kick that threw the gripper from 117 mm back to 10 mm).
        limits = self.limits
        tau_ext = 0.0

        if limits.rad_to_mm != 0:
            # The sign that drives the jaws back toward open, which is the
            # direction the springs and the object push in.
            toward_open = limits.direction
            scale = limits.rad_to_mm
            mm = limits.to_mm(self.q)

            penetration = -mm  # pressed past the closed stop
            if penetration > 0.0:
                tau_ext += toward_open * cfg.stop_k * penetration / scale
                tau_ext -= cfg.stop_c * self.dq

            # The open stop is where the operator recorded the open extreme, not
            # the top of the commanded range: the range deliberately stops
            # ``SPAN_INSET_MM`` short of it, so the jaws are never commanded onto
            # the stop they were calibrated against.
            penetration = mm - limits.stroke_mm  # pressed past the open stop
            if penetration > 0.0:
                tau_ext -= toward_open * cfg.stop_k * penetration / scale
                tau_ext -= cfg.stop_c * self.dq

            if self.object_mm is not None:
                # An obstruction outside the recorded travel is folded onto the
                # nearest extreme — out there its exact position stops mattering,
                # because the reaction pins the jaws against that stop instead.
                object_mm = min(max(self.object_mm, 0.0), limits.stroke_mm)
                penetration = object_mm - mm  # closed past the object
                if penetration > 0.0:
                    tau_ext += toward_open * cfg.contact_k * penetration / scale
                    tau_ext -= cfg.contact_c * self.dq

        # Friction: Coulomb (smoothed through tanh to avoid a sign chatter at
        # zero velocity) plus viscous.
        tau_fric = cfg.coulomb * math.tanh(self.dq / 1.0e-3) + cfg.viscous * self.dq
        accel = (self.tau + tau_ext - tau_fric) / cfg.inertia

        self.dq += accel * dt
        self.q += self.dq * dt

        self._update_temperatures(dt)

        # The motor emits status frames on its own schedule, independently of
        # whether anyone reads them; cap the backlog so a long stall cannot
        # bank an unbounded count and then deliver a burst.
        self._status_accum = min(self._status_accum + dt * cfg.status_hz, 2.0)

    def poll(self) -> bool:
        """Consume one status frame.  True iff one was available.

        Mirrors ``LiteGrip.poll(timeout_s=0)``: non-blocking, and the boolean it
        returns is the only fresh-frame signal the SDK exposes.
        """
        if self._status_accum >= 1.0:
            self._status_accum -= 1.0
            return True
        return False

    def snapshot(self, t: float = 0.0) -> Telemetry:
        """Current state as a :class:`Telemetry`."""
        pos_mm = self.limits.to_mm(self.q)
        # The motor's own torque estimate, which is what the SDK reports and
        # what the force conversion is defined on.  At equilibrium against an
        # object this equals the contact reaction, so a blocked gripper reads
        # the force it is actually applying.
        tau = self.tau
        return Telemetry(
            position_rad=self.q,
            velocity_rad_s=self.dq,
            torque_nm=tau,
            temperature_mos=int(round(self.temp_mos)),
            temperature_coil=int(round(self.temp_coil)),
            error_code=constants.ERROR_ENABLED,
            position_mm=pos_mm,
            force_n=force_from_torque(tau),
            t=t,
        )

    def reset(self) -> None:
        """Return to the powered-off pose."""
        self.q = self.config.closed_rad
        self.dq = 0.0
        self.tau = 0.0
        self.temp_mos = self.config.amb_temp
        self.temp_coil = self.config.amb_temp
        self.object_mm = None

    # ── helpers ─────────────────────────────────────────────────────────────
    def _update_temperatures(self, dt: float) -> None:
        cfg = self.config
        tau_sq = self.tau * self.tau
        self.temp_mos += (cfg.mos_heat_gain * tau_sq - cfg.mos_cool_rate * (self.temp_mos - cfg.amb_temp)) * dt
        self.temp_coil += (
            cfg.coil_heat_gain * tau_sq - cfg.coil_cool_rate * (self.temp_coil - cfg.amb_temp)
        ) * dt
        # Never fall below ambient.
        self.temp_mos = max(self.temp_mos, cfg.amb_temp)
        self.temp_coil = max(self.temp_coil, cfg.amb_temp)


def _clamp(value: float, lo: float, hi: float) -> float:
    return min(max(value, lo), hi)
