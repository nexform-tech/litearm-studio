"""The worker: the one thread that touches the backend.

Why one thread
--------------
The SDK is not thread-safe in any sense.  It has no locks, no background control
thread, and every motion method runs its own 200 Hz blocking loop in the caller's
thread over a single socket and a single ``MotorState``.  Two threads driving one
``LiteGrip`` instance therefore interleave frames on the wire.  Rather than
document that and hope, the backend pins itself to the first thread that performs
I/O (:meth:`~litearm_studio_daemon.gripper.backend.GripperBackend._claim`) and raises on any
later call from another one — a race becomes an immediate, reproducible failure.

Above that, this class is the only place the backend is called at all.  The GUI
never touches it: it posts commands into :class:`CommandQueue` and receives
``TelemetryFrame`` objects.  That is also why the command path is a queue rather
than a Qt signal — a modal dialog or a slow repaint must not be able to stall the
control loop, and the motor needs a frame every 5 ms for as long as it is enabled.

Draining the queue is the arbitration
-------------------------------------
There is no separate "is a move already in flight" bookkeeping.  A slider drag
emits one command per pixel; between two ticks there may be fifty, and draining
them all in one tick is both correct and pointless — each would rebuild the
trajectory — so :func:`~litearm_studio_daemon.gripper.core.commands.coalesce` folds adjacent
runs of the same kind to their last member.  Fifty drag events become one move to
where the operator's finger actually is, for free.

The E-stop is deliberately *not* in the queue.  A command can be queued behind
fifty others; an emergency stop cannot.  It travels on a ``threading.Event`` that
the tick checks before it looks at anything else, and only its release is a
command, because releasing has to be a deliberate act.

Stopping is three different things
----------------------------------
The SDK offers one ``stop()``.  An operator needs three, and conflating them is
how a gripper gets dropped or keeps squeezing:

========  =========================================  ==================
停止       hold the current position, position gain     stays enabled
零重力     zero stiffness, zero torque, back-drivable    stays enabled
急停       zero torque then disable, and latch           disabled
========  =========================================  ==================

The middle one is ``MotionState.RELEASE`` — the button's zero gravity.  The
calibration wizard has a zero-gravity state of its own (``ZERO_G``, entered by
``SetZeroGravity``): same physics, and the two are deliberately separate states,
because the wizard's has to be left again before the manual two-point flow can
record anything.

The latch is what makes the third one different in kind: once tripped, every
motion command is refused until :class:`~litearm_studio_daemon.gripper.core.commands.ResetEStop`,
and the reset re-runs the gate first, because releasing the latch on a gripper
with no usable calibration would undo the reason it latched.

Qt-free by design
-----------------
:class:`WorkerLoop` holds the entire loop and takes any object with the signal
attributes as its emitter, so the 200 Hz logic can be driven a tick at a time in
a test with no QApplication, no thread, and no sleeping.  :class:`GripperWorker`
adds the ``QThread`` and the signals and nothing else.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from enum import Enum
from typing import Any, Callable


from .. import constants
from ..calibration import (
    PROVENANCE_FACTORY,
    PROVENANCE_MEMORY,
    PROVENANCE_TEMPLATE,
    PROVENANCE_USER,
    CalibrationInfo,
)
from ..telemetry import Telemetry, TelemetryFrame
from ..units import frame_mismatch, rad_per_s_to_mm
from . import commands as cmd
from .calibration_fsm import GuidedCalibFSM, TwoPointCalibFSM
from .commands import AnyCommand
from .motion import FrameOut, MotionFSM, MotionParams, MotionState

log = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════
# The gate
# ═══════════════════════════════════════════════════════════════════════════
class GateState(str, Enum):
    """Whether the axis may be commanded, and if not, why not.

    Four states, because the three ways a calibration can fall short are not the
    same kind of thing.  ``TEMPLATE`` is the one the daemon added: the SDK's
    nominal template declares a *direction* and a nominal geometry, so it is
    enough to open and close the jaws — commands that drive to the ends of the
    travel and do not depend on a measured span — and not enough to name a
    millimetre target, which would be wrong by about 40 % (the template's
    geometry is a 120 mm unit's).

    ``FACTORY`` is *surmountable*: the numbers are self-consistent, they simply
    may belong to a different unit, and the operator is the only one who can
    know.  Reversed, missing or wrong-frame calibrations are never surmountable —
    no acknowledgement makes those numbers describe this gripper.
    """

    READY = "READY"
    TEMPLATE = "TEMPLATE"
    FACTORY = "FACTORY"
    BLOCKED = "BLOCKED"


GATE_LABELS = {
    GateState.READY: "就绪",
    GateState.TEMPLATE: "标称模板（未实测）",
    GateState.FACTORY: "出厂标定（待确认）",
    GateState.BLOCKED: "已阻断",
}

# ── wire error kinds, for alerts raised on the tick thread ──────────────────
# The browser translates these names through ``common:errors.*`` (see
# ``src/lib/arm/errors.ts``).  They are the same strings the daemon uses as
# ``err.kind`` on a ``res`` frame, so a failure reads the same however it
# reaches the operator — synchronously or from the tick.
KIND_NOT_CONNECTED = "GripperNotConnectedError"
KIND_LINK = "GripperLinkError"
KIND_FAULT = "GripperFaultActiveError"
KIND_CALIBRATION = "GripperCalibrationError"
KIND_ESTOPPED = "GripperEstoppedError"
KIND_BUSY = "GripperBusyError"


def exception_kind(exc: BaseException) -> str | None:
    """The wire kind for a backend failure, or ``None`` when it has none.

    A backend exception that declares ``kind`` names its own wire error (the
    transport failures do — see ``backend/__init__.py``); anything else falls
    back to its class name, which is what the arm's ``res`` frames already carry
    (``errors.error_to_dict``).  A bare ``ValueError`` therefore arrives as
    ``"ValueError"``: untranslated, but honest, and the text is still there.
    """
    declared = getattr(exc, "kind", None)
    if isinstance(declared, str) and declared:
        return declared
    return type(exc).__name__


#: The gate states whose limits may be used to *name a pose* in millimetres:
#: a measured calibration, or a template's nominal geometry (the pose a hold
#: freezes is the one the encoder just reported, so the span only has to be
#: self-consistent — which a template's is).
GATE_POSE = frozenset({GateState.READY, GateState.TEMPLATE})

#: The gate states that allow a *millimetre target* — only a calibration whose
#: numbers describe this unit.  A template's nominal geometry does not, and an
#: unacknowledged factory file's may belong to another gripper.
GATE_GEOMETRY = frozenset({GateState.READY})


def evaluate_gate(
    info: CalibrationInfo | None,
    allow_factory: bool = False,
    measured_rad: float | None = None,
) -> tuple[GateState, str]:
    """Decide whether ``info`` permits motion, and say why in the operator's terms.

    Pure, and evaluated on the worker thread rather than trusted from the UI, for
    the same reason the motion FSM re-checks the gate: a bug in a widget must not
    be able to drive an uncalibrated motor.

    ``measured_rad`` is the live motor angle when one is known, and it is here
    because a file can be wrong in a way that reading the file cannot reveal —
    see :func:`frame_mismatch`.  Passing ``None`` skips that one check and
    changes nothing else.
    """
    if info is None:
        return GateState.BLOCKED, "后端尚未报告标定信息；运动已禁止"
    if info.problems:
        return GateState.BLOCKED, "；".join(info.problems)
    if info.limits is None:
        return GateState.BLOCKED, f"{info.label}：没有可用的行程数据"

    if measured_rad is not None:
        mismatch = frame_mismatch(info.limits, measured_rad)
        if mismatch:
            return GateState.BLOCKED, mismatch

    if info.provenance == PROVENANCE_USER:
        return GateState.READY, f"{info.label}：{info.path}"

    if info.provenance == PROVENANCE_TEMPLATE:
        # Surmountable for direction-only commands and for nothing else: the
        # gate itself answers with the subset it allows, and the caller decides
        # what its command needs (see ``WorkerLoop._refusal``).
        return (
            GateState.TEMPLATE,
            f"{info.label}：模板只声明装配方向与标称几何（120 mm 规格），"
            "从未在本机实测 —— 只允许张开/闭合/零重力，"
            "任何毫米目标都会错约 40 %；请先运行标定",
        )

    if info.provenance == PROVENANCE_FACTORY:
        if allow_factory:
            return GateState.READY, "已确认使用出厂标定"
        return (
            GateState.FACTORY,
            "正在使用 SDK 内置的出厂标定。若本机夹爪与出厂数据不是同一台，"
            "所有 mm 与力的读数都会是错的 —— 请先自行标定，或确认风险后勾选允许",
        )

    if info.provenance == PROVENANCE_MEMORY:
        return (
            GateState.BLOCKED,
            "标定结果尚未保存到文件；保存之前运动会被拒绝，"
            "因为内存中的数据重启后就没了",
        )

    return GateState.BLOCKED, f"{info.label}：没有可用的标定文件"


# ═══════════════════════════════════════════════════════════════════════════
# The command queue
# ═══════════════════════════════════════════════════════════════════════════
#: Commands the operator can simply repeat, so dropping the oldest one under
#: pressure loses nothing that will not be re-issued a moment later.  Everything
#: else — a connect, a fault clear, a calibration step, a shutdown — has an
#: effect a later command of the same kind does not supersede.
DROPPABLE = (cmd.MoveToMm, cmd.SetSpeed, cmd.SetForce)


class CommandQueue:
    """A bounded FIFO with a condition variable.

    Not ``queue.Queue``: the overflow policy has to look at the whole backlog to
    find the oldest *droppable* command, and doing that one ``get()`` at a time
    under a ``Queue`` would race the producers it is trying to relieve.
    """

    def __init__(self, maxlen: int = constants.COMMAND_QUEUE_MAX) -> None:
        self._items: deque[AnyCommand] = deque()
        self._cv = threading.Condition()
        self._maxlen = int(maxlen)
        self._closed = False
        self.dropped = 0

    def __len__(self) -> int:
        with self._cv:
            return len(self._items)

    def put(self, command: AnyCommand) -> int:
        """Append a command.  Returns how many were dropped to make room."""
        with self._cv:
            dropped = 0
            while len(self._items) >= self._maxlen:
                if not self._drop_one():
                    # Nothing droppable is queued: by then the backlog is
                    # entirely lifecycle commands and the worker is stuck inside
                    # one of them.  Refusing the new command is the honest
                    # choice — dropping a connect or a fault clear to make room
                    # for a slider tick would lose the thing that unblocks it.
                    self.dropped += 1
                    self._cv.notify()
                    return dropped + 1
                dropped += 1
                self.dropped += 1
            self._items.append(command)
            self._cv.notify()
            return dropped

    def _drop_one(self) -> bool:
        """Remove the oldest droppable command.  False if there is none."""
        for i, item in enumerate(self._items):
            if isinstance(item, DROPPABLE):
                del self._items[i]
                return True
        return False

    def drain(self) -> list[AnyCommand]:
        with self._cv:
            items = list(self._items)
            self._items.clear()
            return items

    def wait_for_work(self, timeout: float) -> bool:
        """Block until something is queued or the queue closes.  True if either."""
        with self._cv:
            if self._items or self._closed:
                return True
            self._cv.wait(timeout)
            return bool(self._items) or self._closed

    @property
    def closed(self) -> bool:
        with self._cv:
            return self._closed

    def close(self) -> None:
        with self._cv:
            self._closed = True
            self._cv.notify_all()


# ═══════════════════════════════════════════════════════════════════════════
# The loop
# ═══════════════════════════════════════════════════════════════════════════
CONN_DISCONNECTED = "disconnected"
CONN_CONNECTING = "connecting"
CONN_CONNECTED = "connected"
CONN_ERROR = "error"


class WorkerLoop:
    """Everything the worker does, with no Qt in it.

    ``signals`` is anything with the emit attributes the :class:`GripperWorker`
    declares; a Qt instance passes itself, and a test passes a recorder.  Signals
    are used rather than callbacks because that is what the GUI needs, and a
    callback list would be a second, worse notification system beside it.
    """

    def __init__(
        self,
        backend: Any,
        signals: Any,
        *,
        clock: Callable[[], float] | None = None,
        sleep: Callable[[float], None] | None = None,
        params: MotionParams | None = None,
        watchdog_s: float | None = constants.GUI_WATCHDOG_S,
        dt: float = constants.CTRL_DT,
        can_link: Any | None = None,
    ) -> None:
        self.backend = backend
        self._signals = signals
        self._clock = clock or time.monotonic
        self._sleep = sleep or time.sleep
        self._dt = float(dt)
        self._watchdog_s = watchdog_s
        #: Prepares the CAN interface before a connect, or None when there is
        #: nothing to prepare.  Duck-typed rather than imported: only the real
        #: backend's wiring has one, and this module must not import a
        #: subprocess-spawning helper to describe an interface it never uses.
        self._can_link = can_link

        self._queue = CommandQueue()
        self._motion = MotionFSM(backend.limits(), params or MotionParams())
        self._info: CalibrationInfo | None = None
        self._gate: GateState | None = None
        self._gate_reason = ""
        self._allow_factory = False

        self._probe: GuidedCalibFSM | TwoPointCalibFSM | None = None
        #: Id of the probe in flight, and the terminal outcome of the last one as
        #: ``(id, ok, reason)``.  A waiter that watched ``_probe`` alone could not
        #: tell "this probe finished" from "this probe was aborted and the
        #: previous calibration is still in force" — and every abort path
        #: (watchdog, E-stop, disconnect) leaves ``_info`` at that previous
        #: calibration.  ``_cmd_zero`` waits on the id, so an aborted probe can
        #: no longer be answered with the calibration it never measured.
        self._probe_seq = 0
        self._probe_outcome: tuple[int, bool, str] | None = None
        self._tele = Telemetry()
        self._last_frame = _idle_frame(self)

        self._connected = False
        self._enabled = False
        self._torn_down = False
        self._tick_errors = 0
        #: Ticks the run loop has completed.  Added for the daemon, which has to
        #: be able to show that the tick is itself the keepalive: the drive
        #: leaves the enabled state after 0.4 s without a frame, so a gap in
        #: this counter while the motor is enabled is the failure the loop
        #: exists to prevent.
        self.ticks = 0

        self._stop = threading.Event()
        self._estop = threading.Event()
        self._estop_engaged = False
        self._estop_reason = ""

        self._last_rx_t = self._clock()
        self._rx_times: deque[float] = deque(maxlen=400)
        self._rx_frames = 0
        self._overruns = 0
        self._cycle_ms = 0.0
        #: Set when the motor is enabled but no status frame has been counted
        #: yet, so the axis is being left free rather than held somewhere
        #: unknown.  Cleared on the first frame the tick sees.
        self._awaiting_position = False
        #: Whether a status frame has arrived *since this energisation* — the
        #: only basis on which this class will name a position.  A disabled drive
        #: stops answering, and the SDK goes on serving the angle it last saw, so
        #: a hand can move the jaws while that number sits still.  See
        #: :meth:`_measured_mm`.
        self._have_position = False

        #: When the GUI last spoke — stamped from the GUI thread by ``submit()``
        #: and read on the worker thread.  A float assignment is atomic and the
        #: clock only moves forward, so the worst a race produces is a reading
        #: one tick old.
        self._last_heartbeat = self._clock()
        self._uv_times: deque[float] = deque(maxlen=16)
        self._degraded = False
        self._reported_error = 0
        self._zeroed_for_gate = False
        self._probe_pub_t = 0.0
        #: How long the current probe has gone without a frame reaching the
        #: motor.  See :meth:`_watch_probe_frames`.
        self._probe_unsent_s = 0.0
        # Seeded past the interval so the very first tick publishes: the GUI's
        # first paint happens before there has been time for two.
        self._pub_accum = 1.0
        self._last_state = ""

    # ── lifecycle ───────────────────────────────────────────────────────────
    def run(self) -> None:
        """The thread body.  Never lets an exception out.

        An exception escaping ``QThread.run`` aborts the process (Qt does not
        catch it), which is exactly what the ``finally`` below exists to prevent:
        the motor would be left enabled with the last frame it was given.
        """
        try:
            self._run_loop()
        except BaseException as exc:  # noqa: BLE001 - see the docstring
            self._log("fatal", f"控制线程异常退出: {exc!r}")
            log.exception("控制线程异常退出")
        finally:
            self.teardown()

    def _run_loop(self) -> None:
        last = self._clock() - self._dt
        deadline = self._clock()
        while not self._stop.is_set():
            now = self._clock()
            dt = min(max(now - last, 0.0), constants.MAX_TICK_DT_S)
            last = now
            try:
                self.tick_once(dt)
                self.ticks += 1
                self._tick_errors = 0
            except Exception as exc:  # noqa: BLE001 - a bad tick must not abort
                self._tick_errors += 1
                fatal = self._tick_errors >= constants.MAX_CONSECUTIVE_TICK_ERRORS
                self._log(
                    "fatal" if fatal else "error",
                    f"控制 tick 出错（连续 {self._tick_errors} 次）: {exc!r}",
                )
                if fatal:
                    # No kind: this is not an E-stop and not (yet) a named link
                    # failure — the text carries the diagnosis, and a wrong label
                    # is worse than an untranslated one.
                    self._abandon(f"连续 {self._tick_errors} 次 tick 失败，已停止控制",
                                  kind=None)
                    break
            deadline += self._dt
            delay = deadline - self._clock()
            if delay > 0.0:
                self._sleep(delay)
            else:
                # Fell behind: resynchronise rather than accumulating a debt that
                # would make every later tick a catch-up burst.
                deadline = self._clock()

    def teardown(self) -> None:
        """Zero torque, disable, disconnect — in that order, exactly once.

        Called from three places (the loop's ``finally``, ``aboutToQuit`` and the
        atexit/signal handlers) because none of them covers every exit path, and
        it is idempotent so that overlapping them is harmless.

        Each step is guarded rather than skipped when its precondition is false:
        a motor that was never energised has nothing to unload, and calling the
        SDK's ``stop()`` on it would cost up to 20 ms of link time for nothing.
        """
        if self._torn_down:
            return
        self._torn_down = True

        if self._enabled and self._connected:
            self._quietly("零力矩", self.backend.zero_torque)
        if self._connected:
            self._quietly("失能", self.backend.disable)
            self._quietly("断开", self.backend.disconnect)

        self._enabled = False
        self._connected = False
        self._awaiting_position = False
        self._signals.conn_state.emit(CONN_DISCONNECTED, "已断开")

    def shutdown(self, timeout_ms: int = constants.SHUTDOWN_WAIT_MS) -> bool:
        """Ask the loop to end.  True if it stopped inside the timeout.

        The waiting itself belongs to whoever owns the thread — ``QThread.wait``
        for the GUI, ``Thread.join`` for a test — so this only raises the flag
        and hands back; a loop that is not running has already stopped.
        """
        del timeout_ms
        self._stop.set()
        self._queue.close()
        return True

    def _quietly(self, what: str, call: Callable[[], Any]) -> None:
        try:
            call()
        except Exception as exc:  # noqa: BLE001 - teardown must finish
            self._log("warn", f"关闭时{what}失败（已忽略）: {exc!r}")

    # ── the tick ────────────────────────────────────────────────────────────
    def tick_once(self, dt: float) -> TelemetryFrame:
        """One control tick, in the order the ordering matters.

        Commands first, so a stop given this tick takes effect this tick.  Then
        the axis, then the link, then publish: ``stream_frame``'s return value is
        only meaningful once something has been sent, and the position the FSM
        steers by is the one the previous tick brought in.
        """
        started = self._clock()
        self._service_commands()
        self._service_watchdog()

        if self._connected:
            fresh = bool(self.backend.poll())
        else:
            fresh = False
        tele = self.backend.read()
        self._tele = tele
        self._track_link(fresh)

        if self._awaiting_position:
            measured = self._measured_mm()
            if measured is not None:
                # The frame has arrived: now there is somewhere honest to hold.
                # Until this ran the axis was left free, which is the only state
                # that asks nothing of a position nobody has measured.  Which
                # units the hold is in is the gate's answer, not this one's — a
                # console enabled with no usable calibration holds the angle
                # rather than a millimetre nobody has vetted.
                self._awaiting_position = False
                self._hold_measured("使能后尚未读到位置")
                if self._gate in GATE_POSE:
                    self._log("info", f"已读到位置 {measured:.1f} mm，在此保持")

        self._evaluate_gate()

        if self._estop.is_set():
            self._engage_estop()
            out = FrameOut(None, 0.0, None, 0.0, 0.0, 0.0, False, "急停")
        elif self._probe is not None:
            out = self._tick_probe(tele, dt)
        elif self._enabled:
            # ``geometry=False``: this is the question "may the axis be driven at
            # all", and a nominal template answers yes — it allows 张开/闭合 and a
            # hold under its own limits.  The stricter question ("may this command
            # name a millimetre") is asked where a command enters, in
            # ``_require_motion``, because the FSM cannot tell an in-flight 闭合
            # from an in-flight 移动.
            refusal, _kind = self._refusal(geometry=False)
            out = self._motion.tick(
                self.backend,
                tele,
                dt,
                not refusal,
                refusal,
                # Deliberately not `fresh` above: that one means a frame arrived
                # *this* tick, and a drive answering every other tick is still
                # telling us where the jaws are.  This is the looser question the
                # contact detector needs — is the reading in hand describing now.
                telemetry_current=self._stale_ms() <= constants.CONTACT_FRESH_MS,
            )
        else:
            out = FrameOut(None, 0.0, None, 0.0, 0.0, 0.0, False, "")

        self._service_faults(tele)
        self._cycle_ms = (self._clock() - started) * 1000.0
        if self._cycle_ms > self._dt * 1500.0:
            self._overruns += 1

        self._publish(tele, out, dt)
        return self._last_frame

    # ── publishing ──────────────────────────────────────────────────────────
    def _publish(self, tele: Telemetry, out: FrameOut, dt: float) -> None:
        self._pub_accum += dt
        if self._pub_accum < 1.0 / constants.TELEMETRY_HZ:
            return
        self._pub_accum = 0.0

        limits = self._motion.limits
        frame = TelemetryFrame(
            t=tele.t,
            position_mm=self._measured_mm(),
            position_rad=self._measured_rad(),
            velocity_mm_s=rad_per_s_to_mm(
                tele.velocity_rad_s, limits.rad_to_mm, direction=limits.direction
            ),
            force_n=tele.force_n,
            torque_nm=tele.torque_nm,
            temperature_mos=tele.temperature_mos,
            temperature_coil=tele.temperature_coil,
            error_code=tele.error_code,
            enabled=self._enabled,
            moving=abs(tele.velocity_rad_s) > 0.01,
            grasped=self._motion.state is MotionState.HOLD_FORCE,
            rx_frames=self._rx_frames,
            rx_hz=self._rx_hz(),
            stale_ms=self._stale_ms(),
            motion_state=self._motion_label(),
            cmd_mm=out.q_cmd_mm,
            vel_ref_mm_s=out.vel_ref_mm_s,
            err_mm=out.err_mm,
            cycle_ms=self._cycle_ms,
            overruns=self._overruns,
        )
        self._last_frame = frame
        self._signals.telemetry.emit(frame)

        if self._motion.state.value != self._last_state:
            self._last_state = self._motion.state.value
            self._signals.motion_state.emit(self._last_state)

    def _motion_label(self) -> str:
        """What the axis is doing, for the status line.

        A probe replaces the FSM's label rather than running beside it: during a
        probe the motion FSM is idle and *not* what is driving the motor, and a
        status line reading ``IDLE`` while the jaws are being driven into a hard
        stop would be worse than useless.
        """
        if self._probe is not None:
            return self._probe.phase.value
        if self._estop.is_set():
            return "ESTOP"
        return self._motion.state.value

    # ── link health ─────────────────────────────────────────────────────────
    def _track_link(self, fresh: bool) -> None:
        now = self._clock()
        if fresh:
            self._last_rx_t = now
            self._rx_frames += 1
            self._rx_times.append(now)
            if self._enabled:
                # A frame that arrived while the motor is being addressed is an
                # answer about now.  One that arrives while it is not — a frame
                # already in flight when 失能 was pressed — is the drive's last
                # word before it stopped, and says nothing about a hand that has
                # moved the jaws since.
                self._have_position = True
        elif not self._enabled:
            # Silence is the expected state while the motor is not being
            # addressed, so the staleness clock restarts rather than runs.  A
            # link-health display that counted it would read "9995 ms stale" on
            # a console that had simply never enabled anything.
            self._last_rx_t = now
            self._rx_times.clear()
        while self._rx_times and now - self._rx_times[0] > constants.LINK_RX_WINDOW_S:
            self._rx_times.popleft()

    def _stale_ms(self) -> float:
        return (self._clock() - self._last_rx_t) * 1000.0

    def _rx_hz(self) -> float:
        return len(self._rx_times) / constants.LINK_RX_WINDOW_S

    def _link_dead(self) -> bool:
        """True when the link has gone quiet while it should be talking.

        Only meaningful while enabled: both backends' ``poll`` returns False
        whenever the motor is not enabled, so a console that treated silence as
        death unconditionally would declare the link dead the moment it disabled
        the motor, and refuse to enable it again.
        """
        if not self._enabled:
            return False
        if self._rx_frames == 0:
            # Never heard anything at all.  Counted from the moment we asked it
            # to talk, otherwise a slow enable would look like a dead link.
            return self._stale_ms() > constants.LINK_STALE_MS
        return self._stale_ms() > constants.LINK_STALE_MS

    def _measured_mm(self) -> float | None:
        """Where the jaws are, or ``None`` if this energisation has not measured them.

        Every position command in this class is computed *from* a measurement —
        the profile is anchored to it, and a hold freezes it — so a command
        issued before one exists is a command computed from a number the motor
        has not sent.  The SDK's cached angle is 0.0 rad until a status frame
        arrives, and ``to_mm(0.0)`` is somewhere inside the travel: converting it
        produces a plausible-looking millimetre reading of a place the jaws have
        never been.  That is what drove a real gripper to its closed stop on the
        tick 使能 was pressed — the reading converted to −11 mm, the clamp lifted
        it to 0 mm, and the hold then commanded the closed end.

        The test is :attr:`_have_position` — a status frame has arrived since the
        motor was last energised.  Counting frames from the connection instead is
        what broke this.  A disabled drive stops answering while the SDK goes on
        serving the angle from before the disable, and a hand can push the jaws
        anywhere while that number sits still.  The count outlived the disable, so
        the next 使能 took the hold branch with the pre-disable pose and commanded
        it with full position gain — and since the display is drawn from this same
        reading, the operator had been watching that number the whole time they
        were pushing.

        Not the worker's frame count itself, which is still the signal
        :meth:`_link_dead` trusts: that answers "has this link ever spoken", a
        different question, and its answer must not change here.  The gate is
        deliberately pessimistic — the SDK's own ``enable`` polls for a frame
        internally, so one may arrive without this counting it, which costs a
        couple of ticks.  Eroding a claim in the direction of refusing motion is
        the right way round.
        """
        if not self._connected or not self._enabled or not self._have_position:
            return None
        return self._tele.position_mm

    def _measured_rad(self) -> float | None:
        """The same reading, in the units the motor reported it in.

        :meth:`_measured_mm`'s twin, and gated the same way for the same
        reason.  It exists for the one command that must not go through the
        calibration at all: a hold at the pose the jaws are already in.
        """
        if not self._connected or not self._enabled or not self._have_position:
            return None
        return self._tele.position_rad

    def _hold_measured(self, release_reason: str) -> None:
        """Hold where the jaws are, or let go when that is not yet known.

        A hold freezes a *measurement*, so with no frame received there is
        nothing to freeze and the FSM would be handed the placeholder angle
        instead — the same mistake :meth:`_measured_mm` exists to prevent, one
        layer down.  Releasing is the safe direction: the motor stays enabled and
        stays where it is, and the next measurement turns this into a real hold.

        A shut gate changes the *units*, not the willingness to hold.  There is
        no vetted travel to name a millimetre in, and none is needed: the pose
        worth holding is the one the encoder just measured, and commanding that
        angle goes through nothing the gate is there to protect — it is the
        identity under every calibration there could be.  See
        :meth:`~litearm_studio_daemon.gripper.core.motion.MotionFSM.hold_rad`.
        """
        if self._measured_rad() is None:
            self._motion.release(release_reason)
            return
        if self._gate in GATE_POSE:
            self._motion.hold(self._measured_mm())
            return
        measured_rad = self._measured_rad()
        self._motion.hold_rad(measured_rad)
        self._log(
            "info",
            f"标定不可用：已在 {measured_rad:.6f} rad 驻留（按实测角度，不经过毫米换算）",
        )

    def _refusal(self, geometry: bool = True) -> tuple[str, str | None]:
        """Why motion is refused right now, and which wire error kind it is.

        Returns ``("", None)`` when motion is allowed.  ``geometry`` says whether
        the command needs a measured span or only a direction.  A nominal
        template answers the second and not the first, so the difference is the
        whole reason the gate has a state of its own for it: 张开 and 闭合 drive
        to the ends of the travel and are meaningful whatever the span is, while
        a millimetre target computed from nominal geometry is wrong by the ratio
        between this unit and a 120 mm one.

        The kind travels with the reason because a refusal raised on the tick
        thread has no ``res`` frame to answer: it reaches the operator as a
        ``gripper_alert``, and without a kind the browser has nothing to
        translate and shows the daemon's Chinese text (``daemon/README.md``).
        """
        if self._estop.is_set():
            return f"急停已触发（{self._estop_reason}）；请先复位", KIND_ESTOPPED
        if not self._connected:
            return "尚未连接", KIND_NOT_CONNECTED
        if not self._enabled:
            return "电机未使能", None
        if self._gate is not GateState.READY:
            if self._gate is GateState.TEMPLATE and not geometry:
                pass
            else:
                return self._gate_reason or "标定未就绪", KIND_CALIBRATION
        if self._link_dead():
            return f"链路已断：{self._stale_ms():.0f} ms 未收到状态帧", KIND_FAULT
        # Last, and deliberately: no measurement is *why* nothing can be
        # commanded, but a dead link or a shut gate is *why* there is no
        # measurement, and the cause is the half the operator can act on.
        if self._measured_mm() is None:
            return "尚未读到位置；本次使能后还没收到过状态帧", None
        if self._tele.is_error:
            return (f"电机故障：{constants.describe_error(self._tele.error_code)}",
                    KIND_FAULT)
        return "", None

    # ── the gate ────────────────────────────────────────────────────────────
    def _evaluate_gate(self) -> None:
        # A position is only meaningful once the motor has actually answered:
        # before the first frame the backend reports a placeholder, and judging a
        # placeholder against the travel would block a console that had merely
        # not enabled anything yet.  ``_track_link`` runs earlier in the tick, so
        # by the time this sees a live angle the tick it arrived on is the tick
        # that checks it — which is the tick before any frame could be sent.
        measured = self._measured_rad()
        state, reason = evaluate_gate(self._info, self._allow_factory, measured)
        if state is self._gate and reason == self._gate_reason:
            return
        previous = self._gate
        self._gate = state
        self._gate_reason = reason
        self._signals.gate_state.emit(state.value, reason)

        if state is not GateState.TEMPLATE and state not in GATE_GEOMETRY:
            # The gate closing is the one moment a *position* command must be
            # withdrawn rather than merely refused: the FSM stops sending frames,
            # and the motor would otherwise go on executing the last one, which
            # was derived from the very limits that are now in doubt.
            if previous in GATE_GEOMETRY and self._enabled:
                self._zero_torque_quietly("闸门关闭，已撤销位置指令")
                self._zeroed_for_gate = True
            return

        # ⚠ A nominal template is deliberately *not* treated as a closed gate
        # here: it carries limits of its own (nominal ones), 张开/闭合 are
        # allowed under it, and an enabled motor with no frame sent to it is not
        # a safe resting state — so it holds like any other usable calibration.
        self._zeroed_for_gate = False
        # ``HOLD_RAD`` is in this list because the gate opening is what retires
        # it: an angle hold was the only hold there was while no travel could be
        # trusted, and the moment one can be, the console goes back to naming
        # the pose in millimetres like any other — same pose, ordinary units,
        # and the UI's target column filled in again.
        if self._enabled and self._motion.state in (
            MotionState.IDLE,
            MotionState.BLOCKED,
            MotionState.HOLD_RAD,
        ):
            # The axis holds its pose the moment it is allowed to, rather than
            # waiting for the operator to command a move: an enabled DM motor
            # with no frames sent to it is not a safe resting state.
            self._hold_measured("闸门已打开，但尚未读到位置")

    def _refresh_calibration(self, info: CalibrationInfo | None = None) -> None:
        if info is None:
            info = self.backend.calibration_info()
        self._info = info
        if info is not None and info.limits is not None:
            self._motion.set_limits(info.limits)
        self._signals.calib_info.emit(info)
        # A calibration change invalidates every millimetre the loop is holding,
        # and it does so silently: the numbers are not out of range, they mean
        # something else now.  Both halves of that are dealt with here, and in
        # this order.
        #
        # First the reading: the backend converted it with the limits in force
        # when it read them, so it is re-taken with the new ones.  The angle is
        # the same number either way — only the conversion changed, and this is
        # where the new one applies.
        #
        # Then the target: a hold or a move stored in mm was an operator's intent
        # expressed in the old frame, and there is no honest way to translate it —
        # so the axis is re-anchored where it is rather than sent on toward a
        # number that has changed meaning.  Without this the gate opens onto a
        # hold from the previous calibration, which is how loading a *correct*
        # file made a real axis set off for the far end of its new travel.
        self._tele = self.backend.read()
        self._evaluate_gate()
        if self._enabled and self._gate in GATE_POSE:
            self._hold_measured("标定已更新，已重新驻留在当前位置")

    # ── faults ──────────────────────────────────────────────────────────────
    def _service_faults(self, tele: Telemetry) -> None:
        code = tele.error_code
        if code == self._reported_error:
            return
        self._reported_error = code
        if tele.is_error:
            self._motion.fault()
            self._zero_torque_quietly("电机故障，已撤销位置指令")
            self._signals.fault.emit(
                code,
                constants.describe_error(code),
                constants.FAULT_HINTS.get(code, ""),
            )
            if code == constants.ERROR_UV:
                self._note_undervoltage()
        elif code == constants.ERROR_ENABLED:
            self._log("info", "电机已使能，故障已清除")

    def _note_undervoltage(self) -> None:
        """Count UV events in a window; a repeat offender gets a speed cap.

        One undervoltage is a supply that sagged under a transient load.  Three
        in a minute is a supply that cannot hold the gripper at all, and the
        console's answer to that is to stop asking so much of it rather than to
        let the operator keep tripping it.
        """
        now = self._clock()
        self._uv_times.append(now)
        while self._uv_times and now - self._uv_times[0] > constants.UV_FAULT_WINDOW_S:
            self._uv_times.popleft()
        if len(self._uv_times) > constants.UV_FAULT_MAX and not self._degraded:
            self._degraded = True
            self._motion.set_speed(
                min(self._motion.params.speed_mm_s, constants.UV_DEGRADED_SPEED_MM_S)
            )
            self._alert(
                "warn",
                f"{constants.UV_FAULT_WINDOW_S:.0f} s 内出现 {len(self._uv_times)} 次欠压，"
                f"速度已限制为 {constants.UV_DEGRADED_SPEED_MM_S:.0f} mm/s。"
                "请检查夹爪 24V 供电",
            )

    # ── commands ────────────────────────────────────────────────────────────
    def submit(self, command: AnyCommand) -> int:
        """Queue a command from any thread.  Returns how many were dropped.

        Speaking is what makes the GUI alive, so the heartbeat is stamped here,
        on arrival, and not when the command is applied.  The two are the same
        thing until the loop blocks: a connect can sit inside an authorization
        dialog for a minute, and a slow ``enable()`` for ten seconds, and in both
        cases the heartbeats piling up in the queue are evidence that nobody
        should be shutting anything down — evidence the loop would only get to
        read *after* the watchdog had already looked at the clock.
        """
        self._last_heartbeat = self._clock()
        dropped = self._queue.put(command)
        if dropped:
            self._log("warn", f"命令队列已满，丢弃了 {dropped} 条可重复的运动/参数命令")
        return dropped

    def estop(self, reason: str = "手动急停") -> None:
        """Trip the latch.  Callable from any thread; takes effect within a tick."""
        self._estop_reason = reason
        self._estop.set()

    @property
    def estopped(self) -> bool:
        return self._estop.is_set()

    def set_allow_factory(self, allow: bool) -> None:
        """The operator's acknowledgement of the factory-calibration risk."""
        self._allow_factory = bool(allow)

    def _service_commands(self) -> None:
        drained = self._queue.drain()
        if not drained:
            return
        for command in cmd.coalesce(drained):
            try:
                self._apply(command)
            except Exception as exc:  # noqa: BLE001 - reported, never fatal
                self._alert("error", f"命令失败「{command.describe()}」: {exc}",
                            kind=exception_kind(exc))

    def _apply(self, command: AnyCommand) -> None:  # noqa: C901 - a dispatch table
        self._log("debug", f"命令: {command.describe()}")

        # ── link and power ──────────────────────────────────────────────────
        if isinstance(command, cmd.Connect):
            self._connect()
        elif isinstance(command, cmd.Disconnect):
            self._disconnect()
        elif isinstance(command, cmd.Enable):
            self._enable()
        elif isinstance(command, cmd.Disable):
            self._motion.idle()
            self.backend.disable()
            self._enabled = False
            self._awaiting_position = False
            self._conn_emit(CONN_CONNECTED, "电机已失能")
        elif isinstance(command, cmd.ClearFault):
            self._clear_fault()
        elif isinstance(command, cmd.ResetEStop):
            self._reset_estop()

        # ── motion ──────────────────────────────────────────────────────────
        elif isinstance(command, (cmd.MoveToMm, cmd.Open, cmd.Close, cmd.Grasp)):
            self._end_probe_on_interrupt(command.describe())
            # 张开/闭合 drive to the ends of the travel and are the one pair a
            # nominal template can answer (§5.3's gate): they depend on the
            # direction, not on the span.  A millimetre target does depend on the
            # span, so it needs a calibration that describes this unit.
            geometry = not isinstance(command, (cmd.Open, cmd.Close))
            if not self._require_motion(command.describe(), geometry=geometry):
                return
            if isinstance(command, cmd.MoveToMm):
                self._motion.move_to_mm(command.target_mm, command.source)
            elif isinstance(command, cmd.Open):
                self._motion.open(command.source)
            elif isinstance(command, cmd.Close):
                self._motion.close(command.source, force_n=command.force_n)
            else:
                self._motion.grasp(command.force_n, command.source)
        elif isinstance(command, cmd.BackOff):
            # Gated exactly like the moves above, and for the same reason: it is
            # a millimetre command derived from the travel.  The way to let go of
            # something on a console whose calibration is unusable is 零重力 or
            # 停止, both of which are ungated — not this.
            self._end_probe_on_interrupt(command.describe())
            if not self._require_motion(command.describe()):
                return
            measured = self._measured_mm()
            # ``_refusal`` will not let a command through without a measurement,
            # so this only has to satisfy the type checker and say why.
            assert measured is not None
            # Opening from where the jaws *are*: the target of a grasp is the
            # closed end, so a target-relative release would drive back into the
            # object.  ``move_to_mm`` clamps, so a release at the top of the
            # travel is a move of zero length rather than an out-of-range one.
            self._motion.move_to_mm(measured + command.delta_mm, command.source)
        elif isinstance(command, cmd.Stop):
            self._end_probe_on_interrupt(command.describe())
            if self._estop.is_set():
                self._alert("warn", "急停中：请先复位再操作")
                return
            # Allowed through without the gate: this is the button an operator
            # reaches for when something is wrong, and it is the one motion whose
            # whole purpose is to stop rather than to go anywhere.  It holds at
            # the measured angle when the gate is shut, which needs no limits.
            if self._gate in GATE_POSE:
                self._hold_measured("已停止，但尚未读到位置，先零重力")
            else:
                self._motion.idle()
                self._zero_torque_quietly(f"已停止：{self._gate_reason}")
        elif isinstance(command, cmd.Release):
            self._end_probe_on_interrupt(command.describe())
            self._motion.release(command.source)
        elif isinstance(command, cmd.SetZeroGravity):
            if command.on:
                self._end_probe_on_interrupt(command.describe())
            if command.on and not self._enabled:
                self._alert("warn", "电机未使能，无法进入零重力")
                return
            self._motion.zero_gravity(command.on, self._measured_mm(), command.source)

        # ── parameters ──────────────────────────────────────────────────────
        elif isinstance(command, cmd.SetSpeed):
            self._motion.set_speed(command.speed_mm_s)
        elif isinstance(command, cmd.SetForce):
            self._motion.set_force(command.force_n)
        elif isinstance(command, cmd.SetMount):
            self.backend.set_mount(command.mount)
        elif isinstance(command, cmd.SetTravelMm):
            self.backend.set_travel_mm(command.travel_mm)
            if self._connected:
                # The mm scale is derived from the travel, so every limit in
                # force describes the old one.  A connected backend is asked to
                # resolve its calibration again — the same path a load takes,
                # which is what re-derives the scale and re-anchors the axis.
                #
                # ⚠ A template is reloaded *by name*: re-resolving with no
                # argument would fall back to the channel's file or the factory
                # data, silently changing the declared direction at the moment
                # the operator changed the travel.
                template = self._info.template if self._info is not None else None
                self._load_calibration(None, template=template)

        # ── calibration ─────────────────────────────────────────────────────
        elif isinstance(command, cmd.LoadCalibration):
            self._load_calibration(command.path)
        elif isinstance(command, cmd.SetCalibrationPath):
            self.backend.set_calibration_path(command.path)
        elif isinstance(command, cmd.LoadTemplate):
            self._load_calibration(None, template=command.name)
        elif isinstance(command, cmd.SaveCalibration):
            self._save_calibration(command.path)
        elif isinstance(command, cmd.StartGuidedCalibration):
            self._start_probe(guided=True, reversed_mount=command.reversed_mount)
        elif isinstance(command, cmd.StartManualCalibration):
            self._start_probe(guided=False)
        elif isinstance(command, cmd.ConfirmProbeLimit):
            if isinstance(self._probe, GuidedCalibFSM):
                self._probe.confirm()
            else:
                self._alert("warn", "当前没有正在进行的引导式探测")
        elif isinstance(command, (cmd.RecordOpenLimit, cmd.RecordCloseLimit)):
            self._record_manual_limit(isinstance(command, cmd.RecordOpenLimit))
        elif isinstance(command, cmd.CancelCalibration):
            self._cancel_probe()

        # ── housekeeping ────────────────────────────────────────────────────
        elif isinstance(command, cmd.Heartbeat):
            # Nothing to do: ``submit`` already recorded it, on the thread that
            # sent it, which is the half that matters.  Listed rather than left
            # to fall through to "unknown command".
            pass
        elif isinstance(command, cmd.Inject):
            self.backend.inject(**command.values)
            self._log("info", f"已注入: {command.describe()}")
        elif isinstance(command, cmd.Shutdown):
            self._stop.set()
        else:  # pragma: no cover - the union covers every command
            self._log("warn", f"未知命令已忽略: {command!r}")

    # ── link and power ──────────────────────────────────────────────────────
    def _connect(self) -> None:
        if self._connected:
            self._log("info", "已经连接")
            return
        self._conn_emit(CONN_CONNECTING, "正在连接…")
        if self._can_link is not None:
            self._signals.busy.emit(
                True, f"正在准备 {self._can_link.channel}…（可能需要授权）"
            )
        self._prepare_link()
        self._signals.busy.emit(True, "正在连接夹爪…")
        try:
            self.backend.connect()
        except Exception as exc:
            self._conn_emit(CONN_ERROR, str(exc))
            self._alert("error", f"连接失败: {exc}", kind=exception_kind(exc))
            return
        finally:
            self._signals.busy.emit(False, "")
        self._connected = True
        self._last_rx_t = self._clock()
        self._rx_times.clear()
        self._rx_frames = 0
        self._conn_emit(CONN_CONNECTED, self.backend.describe())
        # The load is explicit and immediate.  The SDK's own fallback to the
        # factory file is silent, so nothing here may leave the choice to it.
        self._load_calibration(None)

    def _prepare_link(self) -> None:
        """Give the interface a chance to exist before the SDK opens it.

        A CAN interface is down until someone raises it, and raising it needs
        root; without this the operator's first press of 连接 can only fail, and
        the fix is a terminal and a sudo password.  So it is done here, once per
        connect, and — this is the part that matters — **it is never allowed to
        be the reason a connection fails**.  The interface may legitimately be
        already up (managed by hand, by a unit file, or it is a virtual bus with
        nothing to configure), and only the open attempt knows whether the link
        works.  Everything this finds is reported and then dropped.
        """
        link = self._can_link
        if link is None:
            # The simulator has no interface, and asking for a password to
            # configure a bus that does not exist would be theatre.
            return
        try:
            outcome = link.ensure()
        except Exception as exc:  # noqa: BLE001 - reported, never fatal
            self._alert(
                "warn", f"准备 {link.channel} 时出错（仍会尝试连接）: {exc!r}",
                kind=KIND_LINK,
            )
            return

        self._log("warn" if outcome.needs_attention else "info", outcome.detail)
        if outcome.needs_attention:
            self._alert("warn", outcome.detail, kind=KIND_LINK)

    def _disconnect(self) -> None:
        if not self._connected:
            return
        self._end_probe_on_interrupt("断开连接")
        if self._enabled:
            self._motion.idle()
            self.backend.disable()
            self._enabled = False
            self._awaiting_position = False
        self.backend.disconnect()
        self._connected = False
        self._conn_emit(CONN_DISCONNECTED, "已断开连接")

    def _enable(self) -> None:
        # First, because it is the reason that explains the others: the latch
        # has already disabled the motor, so an enable that got past this would
        # look like it worked and leave the axis dead.  The connect bar blocks
        # the button, but commands are serviced before the tick's own E-stop
        # check, so an 使能 already in the queue would re-energise a latched
        # axis — and the queue is reachable without the window.
        if self._estop.is_set():
            self._alert(
                "warn", f"急停中，无法使能（{self._estop_reason}）；请先复位",
                kind=KIND_ESTOPPED,
            )
            return
        if not self._connected:
            self._alert("warn", "请先连接", kind=KIND_NOT_CONNECTED)
            return
        # The gate decides what may be *commanded*, never whether the axis may be
        # energised at all.  Refusing to enable on a console whose calibration is
        # unusable locks the operator out of the one flow that can replace it:
        # the manual probe records its limits off a motor that answers, and
        # enabling is what makes it answer.  So the motor comes up either way,
        # and the hold is taken in whichever units the gate leaves open —
        # millimetres when it is READY, the measured angle itself when it is not.
        # See :meth:`_hold_measured`.
        state, reason = evaluate_gate(self._info, self._allow_factory)
        # Whatever this console claimed to know about the jaws is about to stop
        # being true: the axis has been free, and a hand — or gravity — may have
        # moved it since.  Forgetting it here, before the motor is energised, is
        # what makes the hold below a hold at the pose the jaws are in *now*
        # rather than the pose they were in when 失能 was last pressed.
        self._have_position = False
        self._signals.busy.emit(True, "正在使能（可能需要数秒）…")
        try:
            self.backend.enable()
        except Exception as exc:
            self._alert("error", f"使能失败: {exc}", kind=exception_kind(exc))
            code = getattr(exc, "code", None)
            if code is not None:
                self._signals.fault.emit(
                    int(code),
                    constants.describe_error(int(code)),
                    constants.FAULT_HINTS.get(int(code), ""),
                )
            return
        finally:
            self._signals.busy.emit(False, "")

        self._enabled = True
        self._reported_error = 0
        self._last_rx_t = self._clock()
        if state not in GATE_POSE:
            # Said plainly, because the alternative is an operator who believes
            # a gripper that will not move is a broken one.  It is a gripper
            # whose calibration nobody has vetted, and the way out is a probe.
            self._alert(
                "warn",
                f"标定不可用（{reason}）：轴按实测角度驻留，不能按毫米运动。"
                "修好文件或重新标定后即可恢复",
            )
        measured = self._measured_mm()
        if measured is None:
            # Enabled, but no frame has been counted since this energisation —
            # so it does not know where the jaws are, and must not pretend it
            # does.  Holding a position here would freeze the motor's placeholder
            # angle, or the angle from before the last 失能, and send the axis to
            # it; zero gain instead leaves the motor where it is until the first
            # frame arrives, which the tick below picks up.
            self._awaiting_position = True
            self._motion.release("使能后尚未读到位置")
            self._log("info", "电机已使能；尚未读到位置，先零重力，读到后自动保持")
        else:
            self._awaiting_position = False
            self._hold_measured("使能后尚未读到位置")
            if state in GATE_POSE:
                self._log("info", f"电机已使能，保持当前位置 {measured:.1f} mm")

    def _clear_fault(self) -> None:
        if not self._connected:
            self._alert("warn", "请先连接", kind=KIND_NOT_CONNECTED)
            return
        self._signals.busy.emit(True, "正在清除故障…")
        try:
            self.backend.clear_fault()
        except Exception as exc:
            self._alert("error", f"清除故障失败: {exc}", kind=exception_kind(exc))
            return
        finally:
            self._signals.busy.emit(False, "")
        self._reported_error = -1  # force a re-read on the next tick
        self._log("info", "故障已清除")
        if self._enabled and self._gate in GATE_POSE:
            self._hold_measured("故障已清除，但尚未读到位置")

    def _reset_estop(self) -> None:
        if not self._estop.is_set():
            self._log("info", "急停未触发，无需复位")
            return
        # The gate is re-checked *before* the latch is released, not after: a
        # latch released on a gripper with no usable calibration would undo the
        # reason it latched.
        state, reason = evaluate_gate(self._info, self._allow_factory)
        if state not in GATE_POSE:
            self._alert("warn", f"无法复位急停：{reason}", kind=KIND_CALIBRATION)
            return
        self._estop.clear()
        self._estop_engaged = False
        self._estop_reason = ""
        self._signals.fault.emit(0, "急停已复位", "请确认现场安全后再使能")
        self._log("warn", "急停已复位；电机仍处于失能状态")

    # ── motion ──────────────────────────────────────────────────────────────
    def _require_motion(self, what: str, *, geometry: bool = True) -> bool:
        refusal, kind = self._refusal(geometry=geometry)
        if refusal:
            self._alert("warn", f"「{what}」被拒绝：{refusal}", kind=kind)
            return False
        return True

    # ── parameters ──────────────────────────────────────────────────────────

    # ── calibration ─────────────────────────────────────────────────────────
    def _travel_mm(self) -> float:
        """The measured travel in force, as the backend knows it.

        The backend is the owner because the travel is per unit and the SDK's
        schema cannot carry it: the daemon records it per channel and hands it to
        the backend (``SetTravelMm``), which derives its mm scale from it.  The
        module constant is only a fallback for a backend that cannot answer.
        """
        try:
            return float(self.backend.limits().max_stroke_mm)
        except Exception:  # noqa: BLE001 - a backend without limits is not fatal here
            return float(constants.DEFAULT_TRAVEL_MM)

    def _load_calibration(self, path: str | None, template: str | None = None) -> None:
        """Apply a calibration and publish its provenance.

        ``template`` names an SDK template (``"normal"`` / ``"reverse"``) and is
        passed through *as a name*; ``path`` is the explicit file; neither means
        "let the backend resolve the §5.3 order for this channel".
        """
        ok = bool(self.backend.load_calibration(path, template))
        self._refresh_calibration()
        info = self._info
        if ok and info is not None:
            self._log("info", f"已载入标定: {info.describe()}")
            if info.warnings:
                self._alert("warn", "；".join(info.warnings))
        else:
            reason = "；".join(info.problems) if info is not None else "未知原因"
            self._alert("error", f"标定不可用：{reason}", kind=KIND_CALIBRATION)

    def _save_calibration(self, path: str | None) -> str | None:
        """Write the calibration out, returning where it landed or ``None``.

        The return value exists for the one caller that has to *decide*
        something on the answer — a finished probe, whose hand-back depends on
        whether the file now carries the result (see :meth:`_save_probe_result`).
        Everything else reports the outcome through the alerts below, which are
        the record as well as the message (see :meth:`_alert`).
        """
        try:
            written = self.backend.save_calibration(path)
        except Exception as exc:
            self._alert("error", f"保存标定失败: {exc}", kind=KIND_CALIBRATION)
            return None
        self._refresh_calibration()
        self._alert("info", f"标定已保存到 {written}")
        return written

    def _save_probe_result(self, probe: Any, info: CalibrationInfo) -> bool:
        """Write a finished probe out, and say whether the file now carries it.

        The operator used to have to press 保存 for this, and that press was the
        only thing between a finished probe and a console that would not move: a
        result in memory is *usable* but not *saved*, and an unsaved calibration
        holds the gate shut.  A probe is a calibration the operator asked for by
        hand, step by step, so it is written without being asked for once more.
        The button survives as the retry for the case where the write itself
        fails — a read-only directory, a full disk, the SDK refusing.

        A result that does not pass validation is deliberately *not* written.
        The file on disk is a working calibration, and replacing it with numbers
        the console has just called unusable would destroy it; the operator is
        better served by a console that keeps refusing to move than by one that
        moves on bad numbers.  The check has to live here because saving is
        automatic now: the probe itself refuses only a degenerate travel
        (calibration_fsm.summarise), so this is the first place the rest of
        ``validate_limits`` gets a say.
        """
        if not info.usable:
            reason = "；".join(info.problems) or "未通过校验"
            self._alert(
                "warn",
                f"{probe.note}。结果未自动保存：{reason}。"
                "运动限制未解除，请重新标定或手工修好文件",
            )
            return False
        if self._save_calibration(None) is None:
            self._alert(
                "warn",
                f"{probe.note}。结果尚未保存，保存之前不会解除运动限制。"
                "排除原因后可按「重新保存标定…」重试",
            )
            return False
        return True

    def _record_manual_limit(self, opening: bool) -> None:
        """Take the labelled point the operator has just pressed for.

        A press that arrives out of step is refused and logged rather than
        taken as whichever point is due.  The two readings are the whole content
        of the calibration — the closed one is 0 mm — so a press accepted as the
        other point is not a small error: it inverts the travel, and the file it
        produces passes every check the console makes.
        """
        probe = self._probe
        if not isinstance(probe, TwoPointCalibFSM):
            self._alert("warn", "当前没有正在进行的手动标定")
            return
        wanted = "张开" if opening else "闭合"
        taken = probe.record_open() if opening else probe.record_close()
        if taken:
            self._log("info", f"已记录{wanted}极限，下一控制周期取得角度读数")
        else:
            self._log("warn", f"当前步骤不在记录{wanted}极限，已忽略这次按键")

    def _start_probe(self, *, guided: bool, reversed_mount: bool = False) -> None:
        # The E-stop is checked first because it is the reason that explains the
        # others: the E-stop latches and disables the motor, so a probe attempted
        # while it is latched would otherwise be refused with "enable the motor
        # first" — advice that cannot be taken until the E-stop is reset, and
        # which hides the actual cause from the operator.
        if self._estop.is_set():
            self._alert("warn", "急停中，无法开始标定", kind=KIND_ESTOPPED)
            return
        if not self._connected:
            self._alert("warn", "请先连接", kind=KIND_NOT_CONNECTED)
            return
        if not self._enabled:
            self._alert("warn", "标定需要电机使能；请先使能再开始")
            return
        if self._probe is not None and self._probe.is_active:
            self._alert("warn", "已有标定正在进行", kind=KIND_BUSY)
            return

        # The measured travel, written down here rather than read off the limits
        # in force: the probe records the angles either side of it, and those two
        # angles are the whole of the calibration.  Reading it from the limits
        # would make the result depend on whatever file is being replaced.
        #
        # Taken from the backend rather than from the module constant: the
        # constant is the reference unit's 85 mm, and the daemon records the
        # travel per channel (docs/GRIPPER_INTEGRATION.md D5, §5.6).
        stroke = self._travel_mm()
        probe: GuidedCalibFSM | TwoPointCalibFSM
        if guided:
            probe = GuidedCalibFSM(stroke, reversed_mount=reversed_mount)
        else:
            probe = TwoPointCalibFSM(stroke)

        # Where the jaws are, before anything is commanded from it.  The raw
        # telemetry is not a reading: the SDK serves ``0.0`` rad until a status
        # frame has arrived, and ``0.0`` is *inside* the travel, so it converts
        # to a plausible millimetre value of a place the jaws have never been.
        # Every other command path refuses on :meth:`_measured_rad`; a probe is
        # the worst one to skip it, because it seeds its reference from this
        # number and then drives ungated at ``kp=60`` for a whole step interval.
        entry_rad = self._measured_rad()
        if entry_rad is None:
            self._alert(
                "error", "还没有读到位置，无法开始标定；请先使能并等状态帧到达",
                kind=KIND_CALIBRATION,
            )
            return
        # The probe owns the axis from here: the motion FSM must not be holding a
        # position at the same time, or the two would send frames alternately.
        self._motion.idle()
        if not probe.start(entry_rad):
            self._alert("error", f"无法开始标定：{probe.note}", kind=KIND_CALIBRATION)
            return
        self._probe = probe
        self._probe_seq += 1
        self._probe_outcome = None
        self._probe_pub_t = 0.0
        self._probe_unsent_s = 0.0
        if not guided:
            # A manual probe is the operator's hands on the jaws, so the axis has
            # to be free for the whole of it and the console has to say so — a
            # 记录 button that works while the page still looks like it is
            # holding a position is a wizard nobody trusts.
            #
            # After ``probe.start``, not before: a probe that refuses to start
            # returns above, and it must not leave a zero-gravity state behind it
            # for a wizard that never opened.  ``None`` for the measurement
            # because entering needs none — zero stiffness commands no pose.
            #
            # The frames do not change, and there are not two things driving the
            # axis.  The probe's own frames are zero-gain and ungated — the same
            # ones ZERO_G sends, from TwoPointCalibFSM.tick through FREE_FRAME —
            # and the motion FSM is not ticked while a probe is active
            # (tick_once branches on the probe first).  So this is the label the
            # operator reads, not a second owner of the axis.
            #
            # The guided probe is left exactly as it was: it drives the jaws into
            # the stops itself and needs the axis to itself to do it.
            self._motion.zero_gravity(True, None, "开始手动标定")
            self._log(
                "warn",
                "已进入零重力：用手把两片手指分别推到张开和闭合极限，"
                "每到一个按一次对应的「记录」；标定结束时自动退出零重力并驻留",
            )
        kind = "引导式" if guided else "手动两点"
        self._log("warn", f"开始{kind}标定，入口位置 {self._tele.position_rad:.6f} rad")

    def _tick_probe(self, tele: Telemetry, dt: float) -> FrameOut:
        assert self._probe is not None
        probe = self._probe
        out = probe.tick(tele.position_rad, dt)

        sent = False
        if out.q_rad is not None:
            # ``ungated`` is the whole point of the probe: it is the one motion
            # that must happen before a calibration exists, and it is allowed
            # outside the travel the calibration describes, because the
            # mechanical stops it is looking for are outside it by design.
            sent = bool(
                self.backend.stream_frame(
                    out.q_rad, out.kp, out.kd, 0.0, out.tau_nm, ungated=True
                )
            )
            self._watch_probe_frames(sent, dt, probe)

        self._publish_probe_progress(probe, dt)
        if probe.is_active:
            return FrameOut(None, 0.0, None, out.kp, out.kd, out.tau_nm, sent, out.note)

        self._finish_probe(probe, tele)
        return FrameOut(None, 0.0, None, 0.0, 0.0, 0.0, sent, probe.note)

    def _watch_probe_frames(self, sent: bool, dt: float, probe: Any) -> None:
        """Stop a probe that is moving nothing, and say why.

        A probe steers by the angle it reads and records a limit when that angle
        stops changing — so a probe whose frames never reach the motor, or whose
        feedback has gone silent, records *both* limits wherever the jaws happen
        to be.  That is not a theoretical worry: it is what a real run did, and
        the operator got "行程异常: 两个极限落在同一个位置 (-1.370650 rad)"
        from a probe that had not moved the axis at all, on a console that had
        been sending fine a minute earlier.  Nothing in that message could have
        told anyone which of the two had happened.

        The stall window a phase needs to invent a limit is
        ``GUIDED_STALL_CYCLES × GUIDED_STEP_INTERVAL_S`` — 1.8 s — and this
        fires in ``PROBE_REFUSED_FAIL_S``, well inside it, so the real reason is
        reported instead of a limit.  Which conditions are checked, and which
        deliberately are not, are in :meth:`_probe_stall_reason`.
        """
        reason = self._probe_stall_reason()
        if reason:
            probe.fail(f"标定中止：{reason}")
            return
        if sent:
            self._probe_unsent_s = 0.0
            return
        self._probe_unsent_s += dt
        if self._probe_unsent_s >= constants.PROBE_REFUSED_FAIL_S:
            probe.fail(
                f"标定中止：位置帧连续 {self._probe_unsent_s:.1f} s 未能发出，"
                "电机没有收到任何指令"
            )

    def _probe_stall_reason(self) -> str:
        """Why a probe cannot move the axis right now, or ``""``.

        The gate is deliberately absent from this list.  A probe runs *while*
        the gate is shut — that is the normal state during one, since the
        calibration in force is the thing being replaced — so a gate check here
        would make every calibration impossible.  The E-stop is absent because
        the tick checks it before the probe is ticked at all.

        What is left is the reachable-backwards set: a motor that is not
        enabled, a bus that has stopped answering (which also fails
        ``_link_dead`` for any motion), and a fault.  Each of them means the
        reading the probe steers by is not the jaws' position.
        """
        if not self._connected:
            return "尚未连接"
        if not self._enabled:
            return "电机未使能"
        if self._link_dead():
            return f"{self._stale_ms():.0f} ms 未收到状态帧"
        if self._tele.is_error:
            return f"电机故障：{constants.describe_error(self._tele.error_code)}"
        return ""

    def _publish_probe_progress(self, probe: Any, dt: float) -> None:
        self._probe_pub_t += dt
        if self._probe_pub_t < 0.1:
            return
        self._probe_pub_t = 0.0
        note = probe.note
        if isinstance(probe, TwoPointCalibFSM) and probe.remaining_s > 0.0:
            note = f"{note}（剩余 {probe.remaining_s:.0f} s）"
        self._signals.calib_progress.emit(probe.phase.value, probe.progress, note)

    def _finish_probe(self, probe: Any, tele: Telemetry) -> None:
        self._probe = None
        result = probe.result
        if result is not None:
            info = self.backend.set_calibration_memory(
                result.zero_rad, result.open_rad, result.rad_to_mm, result.max_stroke_mm
            )
            self._refresh_calibration(info)
            for line in result.notes:
                self._log("info", f"标定记录：{line}")
            saved = self._save_probe_result(probe, info)
        else:
            # What the probe did get to see, logged *before* the verdict: on a
            # failed probe these lines are the whole account of it — which limit
            # was decided, and on what grounds — and without them the operator is
            # left with a verdict and no evidence.
            for line in getattr(probe, "notes", ()):
                self._log("info", f"标定记录：{line}")
            self._refresh_calibration()
            self._alert("warn", f"标定未完成：{probe.note}", kind=KIND_CALIBRATION)
            saved = False
        # The outcome a waiter is allowed to act on.  "The probe ended" is not
        # the same answer as "the probe produced a calibration": a result that
        # could not be written is not one either, because the gate it would open
        # is the in-memory (unsaved) provenance the wire must never call measured.
        if result is not None and saved:
            self._probe_outcome = (self._probe_seq, True, "")
        elif result is None:
            self._probe_outcome = (self._probe_seq, False, probe.note or "标定未完成")
        else:
            self._probe_outcome = (self._probe_seq, False, "标定结果未能写入标定文件")
        self._signals.calib_progress.emit(probe.phase.value, 1.0, probe.note)
        self._hand_back_after_probe(probe, saved=saved)

    def _hand_back_after_probe(self, probe: Any, *, saved: bool) -> None:
        """Close a probe out: leave zero gravity and put the axis somewhere.

        Reached by every way a probe can end — finished, cancelled, failed —
        and it is the last of those that makes it matter: the operator's hands
        are on the jaws for the whole of a manual probe, so a console that
        quietly stays free is a console they are still holding up, at the moment
        the wizard has just said the calibration is over.

        Leaving zero gravity goes through ``hold_rad`` rather than
        ``zero_gravity(False, measured_mm)``, which holds a *clamped* millimetre
        — derived from the very limits that are in doubt on this path, and the
        one thing a shut gate must not command.  What is held instead is a
        measurement: the pose the encoder has just reported, which needs no
        limits at all.

        For an enabled motor this cannot mean dropping to IDLE: that state sends
        no frame at all, and a drive with no frame to act on is a drive whose
        jaws are free.  What it was holding is a press against a hard stop, and
        what it is left holding is nothing, so the fingers answer with whatever
        the mechanism's own springs want — which is the pop the operator sees, at
        the one moment the console stops telling the motor anything.
        """
        if not isinstance(probe, GuidedCalibFSM):
            # Only a manual probe put the axis in zero gravity, so only a manual
            # probe has one to leave.
            self._log("info", "标定结束，已退出零重力")
        if not self._enabled:
            self._motion.idle()
        elif saved:
            # Nothing left to hand back: writing the result is what opened the
            # gate, and the re-read that follows the write saw a READY gate and
            # held the measured pose there and then (see _refresh_calibration).
            # Sending the hold a second time would repeat the same frame, so the
            # hand-back is over before it starts.
            return
        elif self._gate in GATE_POSE:
            self._hold_measured("标定结束，但尚未读到位置，先零重力")
        else:
            # Behind a shut gate there is no vetted travel to name a millimetre
            # in, and there does not need to be: the pose to hold is the one the
            # jaws are already in, which the encoder has just measured.  Nothing
            # is un-gated by this — the axis is held where the probe left it, and
            # every command that would move it is still refused until the result
            # is saved.
            measured_rad = self._measured_rad()
            if measured_rad is None:
                # No reading, so no pose to hold to.  Zero stiffness asks
                # nothing of a position nobody has measured — and still keeps
                # the frames coming, which is the whole point of not idling.
                self._motion.release("标定结束，尚未读到位置")
            else:
                self._motion.hold_rad(measured_rad)
                self._log(
                    "info",
                    f"标定结束，标定尚未生效：已在 {measured_rad:.6f} rad 驻留，运动限制未解除",
                )

    def _cancel_probe(self) -> None:
        if self._probe is None:
            self._alert("warn", "当前没有正在进行的标定")
            return
        self._probe.cancel()
        self._log("warn", f"已取消标定: {self._probe.phase.value}")

    def _end_probe_on_interrupt(self, what: str) -> None:
        """Any stop-like command ends an active probe.

        A probe that goes on pressing a hard stop after the operator has pressed
        stop is not a behaviour anyone would defend, so the probe is cancelled
        first and the command then applies to an axis nobody else is driving.
        """
        if self._probe is not None and self._probe.is_active:
            self._probe.cancel()
            # This path clears ``_probe`` without going through ``_finish_probe``,
            # so it is the only place that can record why the probe ended.  A
            # waiter that saw nothing here would be satisfied by the *previous*
            # calibration and answer with it.
            self._probe_outcome = (self._probe_seq, False, f"标定中止：{what}")
            self._log("warn", f"「{what}」中断了正在进行的标定，标定已取消")

    # ── shutdown and safety ─────────────────────────────────────────────────
    def _service_watchdog(self) -> None:
        """Stop the motion if the operator's upper computer has gone away.

        The last protection against a dead or hung client, and it fails in the
        safe direction: no heartbeat means no operator, which means no reason for
        the motor to stay energised.

        ⚠ Changed for the daemon: this no longer ends the loop.  In the console
        the client *was* the process, so a vanished GUI meant a vanished worker;
        here the session outlives every browser tab, exactly as the arm's does
        ("客户端断开不杀会话").  A page reload must not leave the gripper
        unreachable, so the watchdog de-energizes and keeps ticking — the
        heartbeat resumes the moment a client comes back.
        """
        if self._watchdog_s is None:
            return
        if self._clock() - self._last_heartbeat <= self._watchdog_s:
            return
        if not self._enabled and self._probe is None:
            # Nothing to unload: saying so once per tick would be noise, and the
            # heartbeat is stamped again on the first frame from a new client.
            self._last_heartbeat = self._clock()
            return
        self._alert(
            "fatal",
            f"上位机心跳已中断 {self._watchdog_s:.0f} s，视为上位机已退出："
            "已零力矩并失能",
        )
        self._end_probe_on_interrupt("上位机心跳中断")
        self._probe = None
        self._safe_stop()
        # Re-arm rather than repeat: the next frame from a client re-stamps the
        # heartbeat, so this fires once per absence instead of every 5 ms.
        self._last_heartbeat = self._clock()

    def _engage_estop(self) -> None:
        if self._estop_engaged:
            return
        self._estop_engaged = True
        self._abandon(f"急停：{self._estop_reason}")
        self._signals.fault.emit(0, "急停已触发", "排除原因后按「复位急停」")

    def _abandon(self, reason: str, *, kind: str | None = KIND_ESTOPPED) -> None:
        """Drop everything and leave the motor harmless.

        ``kind`` is the wire error class the operator's browser translates, so it
        has to name the cause: an E-stop and a control loop that died on its back
        are not the same event, and reporting the second as ``GripperEstoppedError``
        told an English console the E-stop had latched when nothing had.
        """
        self._end_probe_on_interrupt("停止")
        self._probe = None
        self._motion.idle()
        self._alert("error", reason, kind=kind)
        self._safe_stop()

    def _safe_stop(self) -> None:
        """Zero torque then disable.  The order matters: a disabled DM motor
        coasts, and the frames already in flight should not be a position
        command when that happens."""
        self._zero_torque_quietly("安全停止")
        if self._enabled and self._connected:
            try:
                self.backend.disable()
            except Exception as exc:  # noqa: BLE001
                self._log("warn", f"失能失败（已忽略）: {exc!r}")
        self._enabled = False
        self._awaiting_position = False

    def _zero_torque_quietly(self, why: str) -> None:
        if not (self._enabled and self._connected):
            return
        try:
            self.backend.zero_torque()
            self._log("warn", f"已零力矩：{why}")
        except Exception as exc:  # noqa: BLE001
            self._log("error", f"零力矩失败: {exc!r}")

    # ── signal helpers ──────────────────────────────────────────────────────
    def _conn_emit(self, state: str, detail: str) -> None:
        self._signals.conn_state.emit(state, detail)

    def _log(self, level: str, text: str) -> None:
        self._signals.log.emit(level, text)
        if level in ("error", "fatal"):
            log.error(text)
        elif level == "warn":
            log.warning(text)
        else:
            log.debug(text)

    def _alert(self, level: str, text: str, kind: str | None = None) -> None:
        """Show the operator something, and write it to the log file as well.

        The two channels answer different questions.  The alert is what the
        operator sees now; the file is all anyone reading afterwards has, and
        for the alerts that matter — a calibration the console refused to move
        on, a save that failed, an E-stop — the alert is the only place the
        reason exists at all.  Written nowhere but the widget, it is gone the
        moment the window is.

        ``kind`` is the wire error class name (``GripperCalibrationError`` and
        friends) when this alert has one.  The text stays the daemon's own — it
        is the diagnostic detail — but the browser can now translate the *label*
        for the kinds it knows, instead of showing a Chinese sentence in an
        English window.  An alert with no derivable kind passes ``None`` and the
        browser falls back to the text.

        The level mapping is written out rather than shared with :meth:`_log`,
        because the two disagree on purpose: an ``info`` line in the log is a
        running commentary and belongs at DEBUG, while an ``info`` alert is
        something the operator was shown and belongs in the file at the level it
        was shown at.
        """
        self._signals.alert.emit(level, text, kind)
        if level in ("error", "fatal"):
            log.error(text)
        elif level == "warn":
            log.warning(text)
        else:
            log.info(text)

    # ── introspection, for the UI's first paint and for tests ───────────────
    @property
    def queue(self) -> CommandQueue:
        return self._queue

    @property
    def gate(self) -> GateState | None:
        return self._gate

    @property
    def info(self) -> CalibrationInfo | None:
        return self._info

    @property
    def motion(self) -> MotionFSM:
        return self._motion

    @property
    def telemetry(self) -> Telemetry:
        return self._tele

    def measured_rad(self) -> float | None:
        """The last measured angle, or ``None`` when none has been counted.

        Public twin of :meth:`_measured_rad`, for the session: it refuses a probe
        before queueing it, instead of leaving the operator with a five-second
        wait and a generic "could not start" after the tick refused it.
        """
        return self._measured_rad()

    @property
    def probe(self) -> Any:
        return self._probe

    @property
    def probe_seq(self) -> int:
        """Id of the probe in flight (0 before the first one); only moves forward."""
        return self._probe_seq

    @property
    def probe_outcome(self) -> tuple[int, bool, str] | None:
        """``(probe id, ok, reason)`` of the last probe that reached an end.

        ``None`` while one is running or before the first; ``ok`` is false for
        every way a probe can end without leaving a saved calibration.
        """
        return self._probe_outcome

    @property
    def stopping(self) -> bool:
        """True once the loop has been asked to end — watchdog, shutdown or fatal."""
        return self._stop.is_set()

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def last_frame(self) -> TelemetryFrame:
        return self._last_frame


def _idle_frame(_loop: WorkerLoop) -> TelemetryFrame:
    """The frame a loop publishes before it has connected: nothing is known."""
    return TelemetryFrame(
        t=0.0,
        # No connection, so no frame has ever arrived and the position is
        # unknown rather than zero — a zero here is the closed stop.
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
        motion_state=MotionState.IDLE.value,
        cmd_mm=None,
        vel_ref_mm_s=0.0,
        err_mm=None,
        cycle_ms=0.0,
        overruns=0,
    )


# ═══════════════════════════════════════════════════════════════════════════
