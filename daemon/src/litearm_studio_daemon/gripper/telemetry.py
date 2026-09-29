"""Telemetry dataclasses shared by the backends, the worker and the UI.

Two levels, deliberately separated:

``Telemetry``
    A snapshot of the physical gripper, exactly what a backend can observe.
    Pure data, no interpretation.

``TelemetryFrame``
    What the worker publishes to the GUI at 50 Hz: the physical snapshot plus
    link health and command context.  All unit conversions happen before this
    point, so the GUI never does arithmetic on raw radians.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from . import constants


@dataclass(frozen=True)
class Telemetry:
    """A snapshot of the gripper's physical state."""

    position_rad: float = 0.0
    velocity_rad_s: float = 0.0
    torque_nm: float = 0.0
    temperature_mos: int = 0
    temperature_coil: int = 0
    error_code: int = 0
    position_mm: float = 0.0
    force_n: float = 0.0
    t: float = field(default_factory=time.time)

    @property
    def is_enabled(self) -> bool:
        return self.error_code == constants.ERROR_ENABLED

    @property
    def is_error(self) -> bool:
        return self.error_code not in constants.OK_ERROR_CODES

    @property
    def is_moving(self) -> bool:
        return abs(self.velocity_rad_s) > 0.01

    @property
    def force_magnitude(self) -> float:
        """``|force_n|``.

        The SDK derives force as ``torque × NM_TO_N`` with no sign guarantee
        (the winding direction flips it), so the magnitude is what an operator
        wants to read while the signed torque stays available alongside.
        """
        return abs(self.force_n)


@dataclass(frozen=True)
class TelemetryFrame:
    """Worker → GUI publish, 50 Hz."""

    # ── physical ────────────────────────────────────────────────────────────
    t: float
    #: ``None`` until a status frame has actually been received.  Every consumer
    #: must render that as "unknown" rather than as zero: the motor's cached
    #: angle is 0.0 rad before the first frame, and converting it produces a
    #: millimetre reading of a place the jaws have never been — which the slider
    #: would then show, and which a position command would then be computed
    #: from.
    position_mm: float | None
    #: The same reading in the motor's own units, gated the same way.  The
    #: millimetres are computed *through* a calibration, so they cannot be used
    #: to check one — the calibrate page shows this number for the one question
    #: that needs the raw value: which way the encoder runs.
    position_rad: float | None
    velocity_mm_s: float
    force_n: float
    torque_nm: float
    temperature_mos: int
    temperature_coil: int
    error_code: int

    # ── derived state ───────────────────────────────────────────────────────
    enabled: bool
    moving: bool
    grasped: bool

    # ── link health ─────────────────────────────────────────────────────────
    rx_frames: int
    rx_hz: float
    stale_ms: float

    # ── command context ─────────────────────────────────────────────────────
    motion_state: str
    cmd_mm: float | None
    vel_ref_mm_s: float
    err_mm: float | None

    # ── loop health ─────────────────────────────────────────────────────────
    cycle_ms: float
    overruns: int

    def as_dict(self) -> dict[str, float | int | str | bool | None]:
        """Flattened view, for logging and tests."""
        return {
            "t": round(self.t, 4),
            "position_mm": (
                None if self.position_mm is None else round(self.position_mm, 4)
            ),
            "position_rad": (
                None if self.position_rad is None else round(self.position_rad, 6)
            ),
            "velocity_mm_s": round(self.velocity_mm_s, 4),
            "force_n": round(self.force_n, 4),
            "torque_nm": round(self.torque_nm, 6),
            "temperature_mos": self.temperature_mos,
            "temperature_coil": self.temperature_coil,
            "error_code": self.error_code,
            "enabled": self.enabled,
            "moving": self.moving,
            "grasped": self.grasped,
            "rx_frames": self.rx_frames,
            "rx_hz": round(self.rx_hz, 2),
            "stale_ms": round(self.stale_ms, 2),
            "motion_state": self.motion_state,
            "cmd_mm": None if self.cmd_mm is None else round(self.cmd_mm, 4),
            "vel_ref_mm_s": round(self.vel_ref_mm_s, 4),
            "err_mm": None if self.err_mm is None else round(self.err_mm, 4),
            "cycle_ms": round(self.cycle_ms, 4),
            "overruns": self.overruns,
        }


EMPTY_FRAME = TelemetryFrame(
    t=0.0,
    position_mm=None,
    position_rad=None,
    velocity_mm_s=0.0,
    force_n=0.0,
    torque_nm=0.0,
    temperature_mos=0,
    temperature_coil=0,
    error_code=constants.ERROR_DISABLED,
    enabled=False,
    moving=False,
    grasped=False,
    rx_frames=0,
    rx_hz=0.0,
    stale_ms=0.0,
    motion_state="IDLE",
    cmd_mm=None,
    vel_ref_mm_s=0.0,
    err_mm=None,
    cycle_ms=0.0,
    overruns=0,
)
