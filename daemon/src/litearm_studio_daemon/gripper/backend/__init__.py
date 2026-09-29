"""Backend abstraction: the seam between the control logic and the hardware.

The interface exposes only the *primitives* the motion FSM needs, and never the
SDK's convenience methods.  That is what lets the same FSM, the same profile and
the same gate run against real hardware and against the simulator — so the
simulator exercises the production logic instead of standing beside it.  It is
also what keeps every SDK call inside one thread.

The SDK's own high-level motion methods are deliberately absent.  Each is
unusable here for a concrete reason:

``move_at_speed``
    Ends every call with a fixed 20-frame (~100 ms) hold
    (gripper.py:1117-1121), so slicing it for live feedback stutters.
``goto``/``move_to``/``goto_rad``
    ``duration`` is a settle time, not a speed, so the speed setting cannot be
    honoured.  Also clamps to a config-derived range that is inverted while
    uncalibrated (gripper.py:947).
``open``/``close``/``grasp``
    All funnel into ``control_mit_stream``, which has no abort hook
    (can_bus.py:342), so an E-stop could not interrupt them.
``home``
    Uses the hardcoded ``GripperParams.POS_CLOSED_RAD`` rather than
    ``config.pos_closed_rad`` (gripper.py:781), so it is wrong after
    calibration.
``calibrate_guided``/``calibrate_manual``
    Read stdin / rely on Ctrl+C and print to stdout — unreachable from a worker
    thread.  Reimplemented in :mod:`litearm_studio_daemon.gripper.core.calibration_fsm`.
"""

from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from typing import Any

from ..calibration import CalibrationInfo
from ..telemetry import Telemetry
from ..units import Limits


class BackendError(RuntimeError):
    """Base class for backend failures the worker reports to the GUI."""


class ConnectFailed(BackendError):
    """The transport could not be opened (missing interface, no adapter)."""

    #: The wire error this reaches the operator as, so an alert raised on the
    #: tick thread can be translated by the browser (see ``common:errors.*``).
    kind = "GripperLinkError"


class EnableFailed(BackendError):
    """The motor refused to enable — usually a latched fault or no 24 V."""

    kind = "GripperFaultActiveError"


class LinkDown(BackendError):
    """The frame never left the machine: the CAN interface is down or absent.

    Separate from :class:`EnableFailed` because the two ask for different things
    of the operator — a link problem is fixed at the adapter, a motor problem at
    the drive — and because the underlying errno is not a motor code at all.  It
    arrives on 使能 rather than on 连接 only because ``connect()`` merely opens a
    socket; the first frame that has to leave is the enable's.
    """

    kind = "GripperLinkError"


class FaultActive(BackendError):
    """The motor is reporting a fault; carries the raw error code."""

    kind = "GripperFaultActiveError"

    def __init__(self, code: int, message: str = "") -> None:
        self.code = code
        super().__init__(message or f"电机故障 0x{code:X}")


class NotReady(BackendError):
    """An operation was attempted before connect/enable."""


class Unsupported(BackendError):
    """The operation does not apply to this backend."""


class GripperBackend(ABC):
    """Primitives shared by the real and simulated backends.

    Thread ownership is enforced, not merely documented.  The SDK is not
    thread-safe — one socket, one ``MotorState``, no locks — so two threads
    driving one instance would interleave frames.  :meth:`_claim` pins the
    backend to whichever thread performs its first I/O and raises on any later
    call from a different one, which turns a subtle race into an immediate,
    reproducible failure.
    """

    def __init__(self) -> None:
        self._owner_tid: int | None = None
        self._claim_lock = threading.Lock()

    def _claim(self) -> None:
        tid = threading.get_ident()
        with self._claim_lock:
            if self._owner_tid is None:
                self._owner_tid = tid
            elif tid != self._owner_tid:
                raise RuntimeError(
                    "backend used from two threads: "
                    f"owner={self._owner_tid} caller={tid}. The SDK is not "
                    "thread-safe; all access must go through one worker."
                )

    @property
    def owner_tid(self) -> int | None:
        return self._owner_tid

    # ── lifecycle (may block; never called from a motion path) ──────────────
    @abstractmethod
    def connect(self) -> None:
        """Open the transport.  Raises :class:`ConnectFailed`."""

    @abstractmethod
    def disconnect(self) -> None:
        """Close the transport.  Must be safe to call when not connected."""

    @abstractmethod
    def enable(self) -> None:
        """Enable the motor.  Raises :class:`EnableFailed`; can take ~10 s."""

    @abstractmethod
    def disable(self) -> None:
        """Disable the motor.  Must be safe to call when already disabled."""

    @abstractmethod
    def clear_fault(self) -> None:
        """Clear a latched fault.  Raises :class:`FaultActive` on failure."""

    # ── the control-rate primitives ─────────────────────────────────────────
    @abstractmethod
    def stream_frame(
        self,
        q_rad: float,
        kp: float,
        kd: float,
        dq_rad_s: float = 0.0,
        tau_nm: float = 0.0,
        *,
        ungated: bool = False,
    ) -> bool:
        """Send one MIT frame.  Returns False when the frame could not be sent.

        A ``False`` here is the only synchronous dead-link signal the SDK
        offers: ``CanTransport.recv`` swallows all ``OSError`` and returns
        ``None``, so a dead link otherwise looks exactly like an idle one.

        ``ungated`` says the frame carries no target the calibration may veto,
        and it is a property of the frame rather than of its caller.  There are
        two such frames: a probe step, which is looking for the mechanical stops
        the calibration records, and therefore has to be allowed outside the
        travel and before a calibration exists at all; and a zero-gain or
        hold-at-what-was-measured frame — 零重力 (``RELEASE``), the
        wizard's zero gravity (``ZERO_G``), and the pose a probe is left in — which commands no pose, or the identity of the pose the
        encoder just reported.  Both relax the calibration requirement and the
        travel check and nothing else: a non-finite value or a negative gain is
        still refused, because those are wrong whatever the calibration says.

        It is not a licence for a *state*: nothing about holding 零重力 open
        for an hour widens what it permits, because what it permits is a frame with
        nothing in it to be wrong.
        """

    @abstractmethod
    def poll(self) -> bool:
        """Poll for one status frame.  True iff a fresh frame arrived."""

    @abstractmethod
    def read(self) -> Telemetry:
        """Snapshot of the cached state.  Must not block."""

    @abstractmethod
    def zero_torque(self) -> None:
        """Command zero torque, leaving the motor enabled and back-drivable."""

    # ── calibration plumbing ────────────────────────────────────────────────
    @abstractmethod
    def load_calibration(self, path: str | None = None,
                         template: str | None = None) -> bool:
        """Apply a calibration.  At most one of ``path`` and ``template``.

        With neither, the backend resolves the default itself — the §5.3 order
        for the real backend — and reports the provenance it found.  It must
        never leave the choice to the SDK, whose fallback is silent.

        ``template`` is a name from the SDK's ``CALIB_TEMPLATES`` and is applied
        *by name*: a template copied into the user directory would pass for a
        measurement.
        """

    @abstractmethod
    def save_calibration(self, path: str | None = None) -> str:
        """Persist the active calibration; returns the path written."""

    @abstractmethod
    def limits(self) -> Limits:
        """The travel limits currently in effect."""

    @abstractmethod
    def describe(self) -> str:
        """Short human-readable identity, for the title bar and logs."""

    # ── optional ────────────────────────────────────────────────────────────
    def calibration_info(self) -> CalibrationInfo | None:
        """The calibration currently applied, if this backend tracks one.

        The worker publishes this to the gate.  A backend that does not track
        it returns ``None``, and the gate then refuses motion — the safe
        default, since an unknown calibration is an unusable one.
        """
        return None

    def set_calibration_memory(
        self,
        zero_rad: float,
        open_rad: float,
        rad_to_mm: float,
        max_stroke_mm: float | None = None,
    ) -> CalibrationInfo:
        """Adopt unsaved probe results as the active calibration.

        The guided and manual probes produce a calibration before there is a
        file to load it from, so they need this rather than
        :meth:`load_calibration`.  The result is still refused by the gate until
        it has been saved, because an in-memory calibration does not survive a
        restart.
        """
        raise Unsupported("this backend cannot adopt an unsaved calibration")

    def set_calibration_path(self, path: str | None) -> None:
        """Pin the calibration file this channel resolves to (§5.3 row 1)."""
        raise Unsupported("this backend cannot pin a calibration file")

    def set_mount(self, mount: str | None) -> None:
        """Record the declared mounting direction, for calibration resolution.

        A declaration, not a reading: it names which SDK template the resolution
        order falls back to when the channel has no measured file of its own
        (§5.3 row 5).
        """
        raise Unsupported("this backend has no mount to declare")

    def set_travel_mm(self, max_stroke_mm: float) -> None:
        """Record the measured travel of this gripper, in millimetres.

        The SDK's calibration schema has no field for it, so it is ours to keep:
        it is the top of the commanded range, it is what the millimetres per rad
        is derived from, and it is the number a calibration file from another
        unit is caught disagreeing with.
        """
        raise Unsupported("this backend has a fixed travel")

    def calibrate_auto(self, **kwargs: Any) -> Any:
        """Fully automatic stall-detecting calibration.  Optional."""
        raise Unsupported("this backend does not support automatic calibration")

    def inject(self, **kwargs: Any) -> None:
        """Simulator only: inject faults or plant conditions."""
        raise Unsupported("fault injection is only available in simulation")


def make_backend(sim: bool = False, **kwargs: Any) -> GripperBackend:
    """Construct a backend.  Imported lazily so the GUI never pulls in CAN code."""
    if sim:
        from .sim import SimBackend

        return SimBackend(**kwargs)
    from .real import RealBackend

    return RealBackend(**kwargs)
