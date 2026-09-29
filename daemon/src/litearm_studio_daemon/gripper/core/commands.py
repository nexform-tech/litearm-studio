"""The command set: what the GUI asks the worker to do.

Frozen dataclasses rather than a kind-plus-payload dict, so a command cannot be
mutated after it is queued — the widget it was built from may have moved on by
the time the worker drains it, and the worker must act on what was asked at the
moment it was asked.

Why a queue and not Qt signals
------------------------------
The command path deliberately does not run through the Qt event loop: if the GUI
blocks on a modal dialog or a slow repaint, the worker keeps ticking and the
motor keeps being commanded.  Draining a plain ``queue.Queue`` also gives
coalescing for free — see :func:`coalesce`, which is what turns fifty drag
events between two ticks into one move without any dedicated arbitration code.

The E-stop is the exception and does not appear here: it travels on a
``threading.Event`` the tick checks before anything else, because a command that
can be queued behind fifty other commands is not an emergency stop.  Only its
*release* is a command, since releasing has to be the deliberate act.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Union

from .. import constants

# ── base ────────────────────────────────────────────────────────────────────
class Command:
    """Marker base class for every command.

    Deliberately not itself a dataclass: subclasses should not inherit fields,
    because each command's payload is its own and a shared ``source`` field
    would force every subclass to be written around the base's default.
    """

    def describe(self) -> str:  # pragma: no cover - overridden by all of them
        return type(self).__name__


# ── link and power ──────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Connect(Command):
    def describe(self) -> str:
        return "连接"


@dataclass(frozen=True)
class Disconnect(Command):
    def describe(self) -> str:
        return "断开连接"


@dataclass(frozen=True)
class Enable(Command):
    def describe(self) -> str:
        return "使能"


@dataclass(frozen=True)
class Disable(Command):
    def describe(self) -> str:
        return "失能"


@dataclass(frozen=True)
class ClearFault(Command):
    def describe(self) -> str:
        return "清除故障"


@dataclass(frozen=True)
class ResetEStop(Command):
    """Release the latched emergency stop.

    A command rather than an event, because it must go through the same gate
    re-check as any other motion: releasing the latch on a gripper whose
    calibration is missing or reversed would undo the reason it latched.
    """

    source: str = "gui"

    def describe(self) -> str:
        return "复位急停"


# ── motion ──────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class MoveToMm(Command):
    """Servo to an absolute position.  This is what the slider posts."""

    target_mm: float
    source: str = "slider"

    def describe(self) -> str:
        return f"移动到 {self.target_mm:.1f} mm（来源 {self.source}）"


@dataclass(frozen=True)
class Open(Command):
    source: str = "open"

    def describe(self) -> str:
        return f"张开（来源 {self.source}）"


@dataclass(frozen=True)
class Close(Command):
    force_n: float | None = None
    source: str = "close"

    def describe(self) -> str:
        # The force is shown because it is what the operator set, and it is
        # otherwise invisible in the log on the move that actually used it.
        cap = "" if self.force_n is None else f"，限力 {self.force_n:.1f} N"
        return f"闭合（来源 {self.source}{cap}）"


@dataclass(frozen=True)
class Grasp(Command):
    """Close under a force setpoint."""

    force_n: float | None = None
    source: str = "grasp"

    def describe(self) -> str:
        cap = "" if self.force_n is None else f" {self.force_n:.1f} N"
        return f"夹取{cap}（来源 {self.source}）"


@dataclass(frozen=True)
class BackOff(Command):
    """Open ``delta_mm`` further than where the jaws are — the release after a grasp.

    Relative to the *measured* position rather than to the target, and that is
    the whole of why this is a command of its own instead of a :class:`MoveToMm`
    the GUI computes: a grasp drives to 0 mm under a force cap, so its target is
    the closed end and "the target plus ten millimetres" is a command back into
    the object being held.  Where the jaws actually are is knowledge the worker
    has and the page only has a twenty-millisecond-old copy of.
    """

    delta_mm: float = constants.RELEASE_OPEN_MM
    source: str = "back_off"

    def describe(self) -> str:
        return f"放开（在当前位置再张开 {self.delta_mm:.1f} mm，来源 {self.source}）"


@dataclass(frozen=True)
class Stop(Command):
    """Hold the current position with the position gain and no torque.

    The motor stays enabled, so it keeps resisting: this is "stop moving", not
    "let go".  :class:`Release` is the one that lets go.
    """

    source: str = "stop"

    def describe(self) -> str:
        return f"停止（保持位置，来源 {self.source}）"


@dataclass(frozen=True)
class Release(Command):
    """Zero torque, still enabled and back-drivable.  The jaws can be pushed.

    Named 零重力 on the button and in the log, like :class:`SetZeroGravity`
    below it — the two are the same physical state and the operator has one word
    for it.  They stay two commands because they are two different acts: this
    one is a resting state the button puts the axis in, and
    :class:`SetZeroGravity` is a step of the calibration wizard that has to be
    left again to finish.
    """

    source: str = "release"

    def describe(self) -> str:
        return f"零重力（零力矩，来源 {self.source}）"


@dataclass(frozen=True)
class SetZeroGravity(Command):
    on: bool
    source: str = "gui"

    def describe(self) -> str:
        return "进入零重力" if self.on else "退出零重力"


# ── parameters ──────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class SetSpeed(Command):
    speed_mm_s: float

    def describe(self) -> str:
        return f"速度设为 {self.speed_mm_s:.1f} mm/s"


@dataclass(frozen=True)
class SetForce(Command):
    force_n: float

    def describe(self) -> str:
        return f"夹持力设为 {self.force_n:.1f} N"


@dataclass(frozen=True)
class SetMount(Command):
    """Record the declared mounting direction (``"normal"`` / ``"reverse"``).

    The declaration is the *input* to the calibration resolution (§5.3 row 5), so
    it has to reach the backend before a load — the same reason ``SetTravelMm``
    is a command: the backend is only ever touched on the tick thread.
    """

    mount: str | None

    def describe(self) -> str:
        return f"装配方向设为 {self.mount or '（未声明）'}"


@dataclass(frozen=True)
class SetTravelMm(Command):
    """Record the measured travel of this unit.

    Ours, not the SDK's: the calibration schema has no field for it, and it is
    the numerator of every millimetre the console shows
    (``docs/GRIPPER_INTEGRATION.md`` D5).  A command rather than a constructor
    argument because the backend pins itself to the first thread that performs
    I/O, so it has to be applied on the tick thread like everything else.

    The daemon queues it at session construction, ahead of any connect by FIFO
    order, which is what makes the first probe use the operator's travel rather
    than the SDK's 120 mm nominal.
    """

    travel_mm: float

    def describe(self) -> str:
        return f"行程设为 {self.travel_mm:.1f} mm"


# ── calibration ─────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class LoadCalibration(Command):
    path: str | None = None

    def describe(self) -> str:
        return f"载入标定 {self.path or '（默认路径）'}"


@dataclass(frozen=True)
class SetCalibrationPath(Command):
    """Pin a calibration file for this channel (§5.3 row 1).

    The record holds it so it survives a restart, and the backend needs it too:
    the next "resolve this channel's calibration" must answer with the pinned
    file rather than with whatever the channel's default location happens to
    contain.
    """

    path: str | None

    def describe(self) -> str:
        return f"固定标定文件为 {self.path or '（无）'}"


@dataclass(frozen=True)
class LoadTemplate(Command):
    """Declare the mounting direction by loading an SDK template *by name*.

    By name and never by copying the file: the templates carry nominal 120 mm
    geometry whose only job is to declare which way the jaws open, and a copy in
    the user calibration directory would pass for a measurement
    (``docs/GRIPPER_INTEGRATION.md`` D4).
    """

    name: str

    def describe(self) -> str:
        return f"载入标称模板 {self.name}"


@dataclass(frozen=True)
class SaveCalibration(Command):
    path: str | None = None

    def describe(self) -> str:
        return f"保存标定到 {self.path or '（默认路径）'}"


@dataclass(frozen=True)
class StartGuidedCalibration(Command):
    """Probe both travel limits by stepping into them.

    The only command in the set that authorises movement without a valid
    calibration, because it is the thing that produces one.

    ``reversed_mount`` says which way the jaws open, and it has to come from the
    operator: the probe is producing a calibration precisely because there is no
    file to read it from, and a probe that steps the wrong way records the closed
    stop as the open one — a result that validates, saves, and drives the gripper
    inverted.
    """

    reversed_mount: bool = False
    source: str = "guided"

    def describe(self) -> str:
        mounting = "（反向装配）" if self.reversed_mount else ""
        return f"开始引导式标定{mounting}"


@dataclass(frozen=True)
class ConfirmProbeLimit(Command):
    """The operator says the jaws have reached the limit.

    Replaces the SDK's "press Enter" (gripper.py:582), which needs stdin to be a
    terminal and therefore cannot be reached from a worker thread — let alone
    from a GUI.
    """

    source: str = "confirm"

    def describe(self) -> str:
        return "确认已到极限"


@dataclass(frozen=True)
class StartManualCalibration(Command):
    """Hold the axis limp so the operator can work the jaws to each extreme."""

    source: str = "manual"

    def describe(self) -> str:
        return "开始手动两点标定（零重力）"


@dataclass(frozen=True)
class RecordOpenLimit(Command):
    """The jaws are at the open extreme, and the operator says so.

    Two commands rather than one carrying a label, because the label is the
    whole content of the command and the console's mounting direction comes out
    of it: whichever point is recorded as the closed one is 0 mm.  A flow that
    could carry the label as a string could carry it wrong, and the result would
    be a complete, plausible, inverted calibration.
    """

    source: str = "manual"

    def describe(self) -> str:
        return "记录张开极限"


@dataclass(frozen=True)
class RecordCloseLimit(Command):
    """The jaws are at the closed extreme — the end that is 0 mm."""

    source: str = "manual"

    def describe(self) -> str:
        return "记录闭合极限"


@dataclass(frozen=True)
class CancelCalibration(Command):
    """Abort a probe and leave the axis free.

    The SDK has no equivalent: ``calibrate_guided`` blocks in
    ``control_mit_stream`` with no abort hook, so its probe cannot be called off
    once started.
    """

    source: str = "cancel"

    def describe(self) -> str:
        return "取消标定"


# ── housekeeping ────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Heartbeat(Command):
    """The GUI is alive.  Its absence is what the worker's watchdog watches."""

    def describe(self) -> str:
        return "心跳"


@dataclass(frozen=True)
class Inject(Command):
    """Simulator only: set plant conditions or latch a fault."""

    values: dict[str, Any] = field(default_factory=dict)

    def describe(self) -> str:
        inner = ", ".join(f"{k}={v}" for k, v in self.values.items())
        return f"注入 {inner}"


@dataclass(frozen=True)
class Shutdown(Command):
    """End the session: the worker disables the motor and stops its loop."""

    def describe(self) -> str:
        return "退出"


AnyCommand = Union[
    Connect,
    Disconnect,
    Enable,
    Disable,
    ClearFault,
    ResetEStop,
    MoveToMm,
    Open,
    Close,
    Grasp,
    BackOff,
    Stop,
    Release,
    SetZeroGravity,
    SetSpeed,
    SetForce,
    SetMount,
    SetTravelMm,
    LoadCalibration,
    SaveCalibration,
    SetCalibrationPath,
    LoadTemplate,
    StartGuidedCalibration,
    ConfirmProbeLimit,
    StartManualCalibration,
    RecordOpenLimit,
    RecordCloseLimit,
    CancelCalibration,
    Heartbeat,
    Inject,
    Shutdown,
]

#: Commands of which only the last in a run can matter.  Everything else — a
#: connect, a fault clear, a calibration step — has an effect that a later
#: command of the same kind does not supersede.
COALESCABLE = (MoveToMm, SetSpeed, SetForce, Heartbeat)


def coalesce(commands: list[AnyCommand]) -> list[AnyCommand]:
    """Collapse adjacent runs of the same coalescable kind to their last member.

    This is the whole of the console's command arbitration.  A slider drag emits
    a move per pixel; between two ticks there may be fifty of them, and only the
    last describes where the operator's finger actually is.  Applying all fifty
    would be correct but pointless — each one rebuilds the profile — and would
    fill the log with forty-nine targets that were never reached.

    Adjacent runs only, never a reordering.  Collapsing a kind across an
    intervening command of another kind would change what the sequence means:
    ``SetSpeed(10), MoveTo(50), SetSpeed(80)`` is a move that starts at 10 and
    speeds up, and folding the two speeds together would silently pick one.
    """
    out: list[AnyCommand] = []
    for cmd in commands:
        if (
            out
            and isinstance(cmd, COALESCABLE)
            and type(out[-1]) is type(cmd)
        ):
            out[-1] = cmd
        else:
            out.append(cmd)
    return out
