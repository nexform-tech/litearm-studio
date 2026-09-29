"""The gripper session: the daemon's half of the LiteGrip WebSocket contract.

One :class:`~litearm_studio_daemon.gripper.core.worker.WorkerLoop` on its own
thread, one command queue, one E-stop event, one state snapshot published to the
WebSocket.  The wire contract is ``docs/GRIPPER_INTEGRATION.md`` §4; this module
is where it is produced and consumed.

Three things this class owns that the lifted loop does not:

* **The thread.**  ``WorkerLoop`` has no thread of its own (that was Qt's job);
  here it is a plain :class:`threading.Thread` that runs ``WorkerLoop.run`` until
  shutdown.
* **The signal object.**  ``WorkerLoop`` publishes through an object with the
  attributes ``telemetry`` / ``motion_state`` / ``conn_state`` / ``fault`` /
  ``gate_state`` / ``calib_info`` / ``calib_progress`` / ``log`` / ``alert`` /
  ``busy``.  :class:`_Signals` implements that interface with callbacks that
  turn each one into a WebSocket frame.
* **Command intake.**  ``execute`` translates ``gripper.*`` calls into the frozen
  command dataclasses the queue holds, validates their arguments, and answers
  the ``res`` frame.  It is deliberately *not* a second control path: everything
  that touches the backend ends up on the tick thread.

The E-stop is the one command that does not go through ``execute``'s queue.  The
transport layer routes ``gripper.stop`` straight to :meth:`estop`, which sets the
event the tick reads before anything else — the same shape as the arm's
``estop``/``disable`` bypass, and for the same reason: a stop that can queue
behind other work is not an emergency stop.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ..errors import (
    GripperBusyError,
    GripperCalibrationError,
    GripperEstoppedError,
    GripperNotConnectedError,
    UnknownCommandError,
)
from . import calibration, constants
from .config import ChannelConfig, ChannelStore
from .core import commands as cmd
from .core.motion import MotionState
from .core.worker import (
    CONN_CONNECTED,
    CONN_CONNECTING,
    CONN_DISCONNECTED,
    CONN_ERROR,
    GateState,
    WorkerLoop,
)
from .telemetry import TelemetryFrame
from .units import clamp_force

log = logging.getLogger("litearm_studio_daemon.gripper.session")

#: Every command the gripper accepts, with the ``res`` value it answers with.
#: The whitelist is the single admission criterion, exactly as it is for the arm:
#: a name not in this table is an ``UnknownCommandError``, never a dynamic call.
GRIPPER_COMMANDS: Dict[str, str] = {
    "gripper.connect": "连接 (可选 channel/canId/mstId/mount) → {started}",
    "gripper.disconnect": "断开 → {stopped}",
    "gripper.list_channels": "枚举本机的 CAN 接口 → [name, …]",
    "gripper.enable": "使能 → {enabled}",
    "gripper.disable": "失能 → null",
    "gripper.clear_fault": "清故障 → null",
    "gripper.open": "张开 → {ok}",
    "gripper.close": "闭合 → {ok}",
    "gripper.grasp": "夹取 (forceN?, holdS?) → {ok}",
    "gripper.move_to": "移动到 targetMm (0..行程, speedMmS?) → {ok}",
    "gripper.release": "零重力 (零力矩, 仍使能) → null",
    "gripper.stop": "急停 (不排队, 立即生效) → null",
    "gripper.reset_stop": "复位急停 → null",
    "gripper.set_motion": "改速度/夹持力 → 生效中的设置",
    "gripper.load_template": "声明装配方向 (normal|reverse), 按名载入模板 → {mount, source}",
    "gripper.list_calibrations": "列出本通道可用的标定及其来源/校验 → [ … ]",
    "gripper.import_calibration": "载入指定标定文件并记住它 → {path, source}",
    "gripper.zero": "引导式实测 (travelMm) → {closedRad, openRad, radToMm}",
    "gripper.set_allow_factory": "确认/撤销「允许出厂标定」(持久化) → {allowFactory}",
}

#: Commands that need a connected session.  ``gripper.list_calibrations`` is
#: deliberately absent: listing files is a filesystem question, and the settings
#: page asks it before it connects.
_NEEDS_CONNECTION = frozenset({
    "gripper.enable", "gripper.disable", "gripper.clear_fault",
    "gripper.open", "gripper.close", "gripper.grasp", "gripper.move_to",
    "gripper.release", "gripper.reset_stop", "gripper.set_motion",
    "gripper.load_template", "gripper.import_calibration", "gripper.zero",
})

#: Commands the stop latch refuses.  Exactly the ones that move the jaws: 失能,
#: 停止, 零重力 and 复位 are all reachable *because* the axis is latched, and a
#: latch that also blocked them would leave an operator unable to unload it.
_MOTION_REQUESTS = frozenset({
    "gripper.open", "gripper.close", "gripper.grasp", "gripper.move_to",
})

#: The commands that turn a millimetre into a motor angle, and therefore need a
#: calibration whose numbers describe *this* unit.  张开/闭合 drive to the ends
#: of the travel and are meaningful under a nominal template; these are not.
_GEOMETRY_COMMANDS = frozenset({"gripper.move_to", "gripper.grasp"})

#: Wire names for the daemon's own connection states — identical strings today,
#: named here so the two can never drift apart silently.
_WIRE_STATUS = {
    CONN_DISCONNECTED: "disconnected",
    CONN_CONNECTING: "connecting",
    CONN_CONNECTED: "connected",
    CONN_ERROR: "error",
}

#: Motion FSM state → the wire's ``state`` field (§4.1).
_MOTION_WIRE = {
    MotionState.IDLE: "ready",
    MotionState.HOLD: "holding",
    MotionState.HOLD_RAD: "holding",
    MotionState.SERVO: "moving",
    MotionState.HOLD_FORCE: "grasping",
    MotionState.RELEASE: "ready",
    MotionState.ZERO_G: "ready",
    MotionState.FAULT: "fault",
    MotionState.BLOCKED: "fault",
}

#: Probe phase → the wire's ``phase`` field, which names the part of the travel
#: the probe is working on rather than the state machine's own step.
_PROBE_WIRE = {
    "OPEN_PROBE": "open",
    "OPEN_BACKOFF": "open",
    "CLOSE_PROBE": "close",
    "DONE": "done",
    "FAILED": "failed",
    "CANCELLED": "failed",
}


def _wire_source(info: Any) -> Optional[str]:
    """Calibration provenance → the wire's ``source`` field (§4.1).

    ``None`` means "no calibration has been resolved yet", which is a different
    statement from ``"missing"`` (resolution ran and found nothing).  The mapping
    itself lives on :class:`~litearm_studio_daemon.gripper.calibration.CalibrationInfo`
    so the session and the calibration page cannot disagree about it.
    """
    if info is None:
        return None
    return getattr(info, "wire_source", None)


class _Emitter:
    """One attribute of the signal object: an ``emit(*values)`` bound to a method."""

    __slots__ = ("_fn",)

    def __init__(self, fn: Callable[..., None]) -> None:
        self._fn = fn

    def emit(self, *values: Any) -> None:
        try:
            self._fn(*values)
        except Exception:  # noqa: BLE001 - a bad frame must not kill the tick
            log.warning("夹爪事件投递失败 (已忽略)", exc_info=True)


class _Signals:
    """The signal object :class:`WorkerLoop` publishes through."""

    def __init__(self, session: "GripperSession") -> None:
        self.telemetry = _Emitter(session._on_telemetry)
        self.motion_state = _Emitter(session._on_motion_state)
        self.conn_state = _Emitter(session._on_conn_state)
        self.fault = _Emitter(session._on_fault)
        self.gate_state = _Emitter(session._on_gate_state)
        self.calib_info = _Emitter(session._on_calib_info)
        self.calib_progress = _Emitter(session._on_calib_progress)
        self.log = _Emitter(session._on_log)
        self.alert = _Emitter(session._on_alert)
        self.busy = _Emitter(session._on_busy)


class GripperSession:
    """Drives one LiteGrip over SocketCAN, behind the daemon's WebSocket."""

    def __init__(
        self,
        *,
        fake: bool = False,
        channel: Optional[str] = None,
        store: Optional[ChannelStore] = None,
        on_event: Optional[Callable[[dict], None]] = None,
        can_setup: bool = True,
        autostart: bool = True,
    ) -> None:
        self._fake = bool(fake)
        self._store = store if store is not None else ChannelStore()
        self._listeners: List[Callable[[dict], None]] = []
        if on_event is not None:
            self._listeners.append(on_event)
        self._can_setup = bool(can_setup)

        #: The record in force.  ``gripper.connect`` may replace it; the store is
        #: the durable half.
        self._config = self._store.get(channel or self._default_channel())
        if channel and channel != self._config.channel:
            self._config = ChannelConfig(channel=channel,
                                         travel_mm=self._config.travel_mm)

        self._lock = threading.RLock()
        self._status = "disconnected"
        self._last_error: Optional[str] = None
        self._gate: Optional[GateState] = None
        self._gate_reason = ""
        self._last_frame: Optional[TelemetryFrame] = None
        #: When a ``grasp`` with a hold time should let go, or ``None``.
        self._release_at: Optional[float] = None
        self._closed = False

        self._signals = _Signals(self)
        self._loop: Optional[WorkerLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._build_loop(self._config)

        if autostart:
            self.start()

    # ------------------------------------------------------------------ 装配
    def _default_channel(self) -> str:
        """The channel to use when the caller names none.

        The most recently configured channel wins, so a machine with two
        grippers reconnects to the one the operator last used rather than
        snapping back to ``can0``.  Falls back to the constant, which is also
        what a first run has.
        """
        return self._store.last_channel() or constants.CAN_CHANNEL

    def _build_loop(self, config: ChannelConfig) -> None:
        """Construct the backend and the loop for ``config``.  No thread yet."""
        backend = self._make_backend(config)
        loop = WorkerLoop(
            backend,
            self._signals,
            watchdog_s=constants.GUI_WATCHDOG_S,
            can_link=self._make_can_link(config),
        )
        loop.set_allow_factory(bool(config.allow_factory))
        # ⚠ The travel goes in **through the queue**, not by calling the backend
        # here: the backend pins itself to the first thread that performs I/O,
        # and that thread is the tick.  FIFO order puts this ahead of any connect
        # the operator issues later, so the first probe uses the operator's
        # travel rather than the SDK's 120 mm nominal.
        loop.submit(cmd.SetTravelMm(float(config.travel_mm)))
        self._loop = loop

    def _make_backend(self, config: ChannelConfig) -> Any:
        if self._fake:
            from .backend.sim import SimBackend

            return SimBackend(realtime=True, channel=config.channel,
                              mount=config.mount,
                              pinned_path=config.calibration_path)
        # Imported here, not at module scope: ``litegrip`` needs ``fcntl`` and
        # ``PF_CAN`` and raises at import on Windows (D10), and the daemon must
        # still start there with the gripper absent.
        from .backend.real import RealBackend

        return RealBackend(
            channel=config.channel,
            can_id=config.can_id,
            mst_id=config.mst_id,
            max_stroke_mm=config.travel_mm,
            calibration_path=config.calibration_path,
            mount=config.mount,
        )

    def _make_can_link(self, config: ChannelConfig) -> Any:
        """The interface preparation hook, or ``None`` when there is none.

        The simulator has no interface, and a build with ``--no-can-setup`` must
        not hand the loop something that could raise a password dialog: the loop
        reports what the hook finds and then connects regardless, so ``None`` is
        a legitimate answer rather than a missing feature.
        """
        if self._fake or not self._can_setup:
            return None
        try:
            from .can_link import CanLink

            return CanLink(config.channel)
        except Exception:  # noqa: BLE001 - preparation is never fatal
            log.debug("没有可用的 CAN 准备钩子", exc_info=True)
            return None

    # ------------------------------------------------------------------ 线程
    def start(self) -> None:
        """Start the tick thread (idempotent)."""
        with self._lock:
            if self._closed or self._thread is not None:
                return
        self._start_thread()

    def _start_thread(self) -> None:
        with self._lock:
            loop = self._loop
            if loop is None or self._thread is not None:
                return
            thread = threading.Thread(target=self._run, args=(loop,),
                                      name="litearm-gripper", daemon=True)
            self._thread = thread
        thread.start()

    def _stop_thread(self, timeout_s: float = 5.0) -> bool:
        """Ask the tick thread to end and wait for it.  True if it ended.

        ⚠ The join happens **outside** ``self._lock``: the tick thread calls
        back into this session on every frame, and it takes that lock to do it,
        so joining while holding it would deadlock the moment a frame is in
        flight.
        """
        with self._lock:
            thread, loop, self._thread = self._thread, self._loop, None
        if loop is not None:
            loop.shutdown()
        if thread is None:
            return True
        if thread.is_alive():
            thread.join(timeout_s)
        return not thread.is_alive()

    def _run(self, loop: WorkerLoop) -> None:
        loop.run()          # never lets an exception out; tears down in finally
        with self._lock:
            current = self._loop is loop
        if current:
            self._on_conn_state(CONN_DISCONNECTED, "已断开")

    def close(self, timeout_s: float = 5.0) -> None:
        """Shut the session down: zero torque, disable, disconnect.

        Idempotent, and bounded — the caller is a process exiting, and a
        gripper left enabled with the last frame it was given is precisely what
        this exists to prevent (the arm's ``Session.close`` is the same shape).
        """
        with self._lock:
            if self._closed:
                return
            self._closed = True
        if not self._stop_thread(timeout_s):
            # The loop is still inside a backend call.  Everything else would
            # touch that backend from this thread, which the SDK forbids — so
            # the honest move is to say so rather than to race it.
            log.error("夹爪控制线程未在 %.1fs 内退出; 置零/失能由它的收尾路径完成",
                      timeout_s)

    # ------------------------------------------------------------------ 查询
    @property
    def fake(self) -> bool:
        return self._fake

    @property
    def config(self) -> ChannelConfig:
        with self._lock:
            return self._config

    @property
    def loop(self) -> WorkerLoop:
        assert self._loop is not None
        return self._loop

    @property
    def status(self) -> str:
        with self._lock:
            return self._status

    def connected(self) -> bool:
        return self.status == "connected"

    def conn_info(self) -> dict:
        """The ``gripper_conn`` frame's payload (without ``t``).

        ``mount`` is *read back* from the limits the device is actually running
        on, and only falls back to the declared record when nothing is loaded:
        a declaration is a request, and the operator has to be able to see which
        one the hardware ended up with (§6.3's read-back discipline).
        """
        with self._lock:
            config, status = self._config, self._status
            error, gate, reason = self._last_error, self._gate, self._gate_reason
            loop = self._loop
        info = loop.info if loop is not None else None
        mount = config.mount
        limits = getattr(info, "limits", None) if info is not None else None
        if limits is not None:
            mount = "reverse" if limits.reversed_mount else "normal"
        return {
            "status": status,
            "channel": config.channel,
            "canId": int(config.can_id),
            "mount": mount,
            "declaredMount": config.mount,
            "template": getattr(info, "template", None) if info is not None else None,
            "source": _wire_source(info),
            "path": getattr(info, "path", None) if info is not None else None,
            "travelMm": float(config.travel_mm),
            "error": error,
            "gate": gate.value if gate is not None else None,
            "gateReason": reason,
        }

    def state(self) -> Optional[dict]:
        """The most recent wire state, or ``None`` before the first frame."""
        with self._lock:
            frame = self._last_frame
        return None if frame is None else self._state_payload(frame)

    def gate(self) -> Optional[GateState]:
        with self._lock:
            return self._gate

    # ------------------------------------------------------------------ 发布
    def add_listener(self, cb: Callable[[dict], None]) -> None:
        """Register a frame listener.  Called on the tick thread — be quick."""
        with self._lock:
            self._listeners.append(cb)

    def remove_listener(self, cb: Callable[[dict], None]) -> None:
        with self._lock:
            try:
                self._listeners.remove(cb)
            except ValueError:
                pass

    def _broadcast(self, event: dict) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for cb in listeners:
            try:
                cb(event)
            except Exception:  # noqa: BLE001 - a broken listener is not the session's
                log.warning("夹爪事件监听器抛出异常 (已忽略)", exc_info=True)

    def _on_conn_state(self, state: str, detail: str) -> None:
        with self._lock:
            self._status = _WIRE_STATUS.get(state, state)
            if state == CONN_ERROR:
                self._last_error = detail
            elif state != CONN_CONNECTING:
                self._last_error = None
            if state == CONN_DISCONNECTED:
                self._release_at = None
        self._broadcast({"t": "gripper_conn", **self.conn_info()})

    def _on_gate_state(self, state: str, reason: str) -> None:
        with self._lock:
            try:
                self._gate = GateState(state)
            except ValueError:      # pragma: no cover - the loop's own enum
                self._gate = None
            self._gate_reason = reason
        # The gate and its reason are part of the connection frame, because that
        # is what a page reads to explain why its controls are disabled.
        self._broadcast({"t": "gripper_conn", **self.conn_info()})
        self._emit_state()

    def _on_calib_info(self, info: Any) -> None:
        # Provenance is part of the connection frame, so a calibration change is
        # a connection change as far as the UI is concerned.
        self._broadcast({"t": "gripper_conn", **self.conn_info()})

    def _on_calib_progress(self, phase: str, progress: float, note: str) -> None:
        # ``step``/``total`` are derived from the probe's own 0..1 progress: the
        # two probes have different notions of an iteration (a guided probe
        # steps, a two-point probe waits for a hand), so a real step count would
        # mean something different in each and the UI draws a bar either way.
        total = 100
        step = max(0, min(total, int(round(float(progress) * total))))
        self._broadcast({
            "t": "gripper_calib",
            "probe": "zero",
            "phase": _PROBE_WIRE.get(phase, phase.lower()),
            "step": step,
            "total": total,
            "progress": round(float(progress), 4),
            "detail": note,
        })

    def _on_fault(self, code: int, message: str, hint: str) -> None:
        text = message if not hint else f"{message} —— {hint}"
        level = "info" if int(code) in constants.OK_ERROR_CODES else "error"
        self._broadcast({"t": "gripper_alert", "level": level, "text": text,
                         "code": int(code)})

    def _on_log(self, level: str, text: str) -> None:
        log.log({"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING,
                 "error": logging.ERROR, "fatal": logging.CRITICAL}.get(level, logging.INFO),
                "%s", text)

    def _on_alert(self, level: str, text: str) -> None:
        self._broadcast({"t": "gripper_alert", "level": level, "text": text})

    def _on_busy(self, busy: bool, what: str) -> None:
        self._broadcast({"t": "gripper_busy", "busy": bool(busy), "what": what})

    def _on_motion_state(self, state: str) -> None:
        self._emit_state()

    def _on_telemetry(self, frame: TelemetryFrame) -> None:
        with self._lock:
            self._last_frame = frame
            release_at = self._release_at
        self._emit_state()
        if release_at is not None and time.monotonic() >= release_at:
            with self._lock:
                self._release_at = None
            # A timed grasp lets go by itself.  Submitting from the tick thread
            # is safe: the queue is thread-safe by construction.
            try:
                self._loop_submit(cmd.Release(source="grasp_hold"))
            except Exception:  # noqa: BLE001 - a refused release is reported below
                log.warning("定时放开失败", exc_info=True)

    def _emit_state(self) -> None:
        with self._lock:
            frame = self._last_frame
        if frame is None:
            return
        self._broadcast({"t": "gripper_state", "stamp": round(frame.t, 4),
                         "state": self._state_payload(frame)})

    def _state_payload(self, frame: TelemetryFrame) -> dict:
        loop = self._loop
        enabled = bool(loop is not None and loop.enabled)
        estopped = bool(loop is not None and loop.estopped)
        raw = frame.motion_state
        if estopped:
            state = "stopped"
        elif not enabled:
            state = "disabled"
        elif raw in _PROBE_WIRE and raw not in ("DONE", "FAILED", "CANCELLED"):
            state = "moving"
        else:
            state = _MOTION_WIRE.get(
                MotionState(raw) if raw in MotionState._value2member_map_ else None,
                "ready",
            )
        with self._lock:
            gate, reason = self._gate, self._gate_reason
        return {
            "positionMm": None if frame.position_mm is None else round(frame.position_mm, 3),
            "forceN": round(frame.force_n, 3),
            "torqueNm": round(frame.torque_nm, 5),
            "velocityMmS": round(frame.velocity_mm_s, 3),
            "enabled": enabled,
            "state": state,
            "errorCode": int(frame.error_code),
            "temps": {"mosTemp": int(frame.temperature_mos),
                      "coilTemp": int(frame.temperature_coil)},
            "fresh": bool(enabled and frame.stale_ms <= constants.LINK_STALE_MS),
            "gate": gate.value if gate is not None else None,
            "gateReason": reason,
        }

    # ------------------------------------------------------------------ 命令
    def execute(self, m: str, p: Optional[dict] = None) -> Any:
        """Run one ``gripper.*`` command.  Never blocks on a motion.

        Admission mirrors the arm's: the method must be in the whitelist, and
        commands that need a live session must have one.  Everything that moves
        the jaws is *queued* and answered immediately — the loop drains the queue
        at the top of its next tick, and the outcome arrives as state frames.

        ⚠ The admission check runs under the lock, the handler does **not**: a
        handler may rebuild the loop (``gripper.connect`` on a new channel) and
        joins the tick thread, which takes this same lock on every frame it
        publishes.  Holding it across the handler would deadlock the session
        against its own tick.
        """
        method = str(m)
        params = dict(p or {})
        with self._lock:
            if self._closed:
                raise GripperNotConnectedError("夹爪会话已关闭")
            if method not in GRIPPER_COMMANDS:
                raise UnknownCommandError(method, sorted(GRIPPER_COMMANDS))
            if method in _NEEDS_CONNECTION and self._status != "connected":
                raise GripperNotConnectedError(
                    f"夹爪未连接, 拒绝 {method} (status={self._status})")
            if method in _MOTION_REQUESTS and self._loop is not None and self._loop.estopped:
                raise GripperEstoppedError(
                    "急停已触发; 请先排除原因并按复位急停")
        handler = getattr(self, "_cmd_" + method.split(".", 1)[1])
        return handler(params)

    # ── 连接 ────────────────────────────────────────────────────────────────
    def _cmd_connect(self, p: dict) -> dict:
        """Apply the requested device identity, then queue a connect.

        A change of channel or CAN id has to rebuild the backend: the SDK object
        is bound to one interface and one CAN id at construction.  That is only
        legal while nothing is connected — reconfiguring a live link is exactly
        the silent adoption the arm's session also refuses.
        """
        changes = self._identity_changes(p)
        if changes:
            if self.status == "connected":
                raise ValueError("请先断开夹爪, 再修改通道/ID")
            self._reconfigure(changes)
        loop = self.loop
        if self._status == "connected":
            return {"started": False}
        if self._status == "connecting":
            return {"started": False}
        with self._lock:
            self._status = "connecting"
            self._last_error = None
        self._broadcast({"t": "gripper_conn", **self.conn_info()})
        loop.submit(cmd.Connect())
        return {"started": True}

    def _identity_changes(self, p: dict) -> Dict[str, Any]:
        changes: Dict[str, Any] = {}
        if p.get("channel") is not None:
            channel = str(p["channel"]).strip()
            if not channel:
                raise ValueError("channel 不能为空")
            if channel != self._config.channel:
                changes["channel"] = channel
        for key, field in (("canId", "can_id"), ("mstId", "mst_id")):
            if key not in p or p[key] is None:
                continue
            value = p[key]
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"{key} 需整数")
            if value < 0 or value > 0x7FF:
                raise ValueError(f"{key} 需在 0..0x7FF 之间")
            if value != getattr(self._config, field):
                changes[field] = int(value)
        if p.get("mount") is not None:
            mount = p["mount"]
            if mount not in ("normal", "reverse"):
                raise ValueError("mount 需为 normal 或 reverse")
            if mount != self._config.mount:
                changes["mount"] = mount
        return changes

    def _reconfigure(self, changes: Dict[str, Any]) -> None:
        """Persist the changes and rebuild the backend/loop for them.

        A channel change *adopts that channel's own record* rather than copying
        this one onto it: two grippers on one machine have different travels,
        mounts and CAN ids, and moving the session to ``can1`` must pick up what
        the operator configured for ``can1``.  Only the fields the caller named
        override it.
        """
        old = self._config.channel
        new = str(changes.pop("channel", old))
        base = self._config if new == old else self._store.get(new)
        record = replace(base, channel=new, **changes)
        # The old loop owns the old backend, and its thread is the only thing
        # allowed to touch it — so it is stopped and joined before the new one
        # is built, and a new thread is started for it.
        self._stop_thread()
        with self._lock:
            config = self._store.put(record)
            self._config = config
            self._gate = None
            self._gate_reason = ""
            self._last_frame = None
        self._build_loop(config)
        with self._lock:
            closed = self._closed
        if not closed:
            self._start_thread()

    def _cmd_disconnect(self, p: dict) -> dict:
        del p
        if self._status == "disconnected":
            return {"stopped": False}
        self.loop.submit(cmd.Disconnect())
        return {"stopped": True}

    def _cmd_list_channels(self, p: dict) -> List[str]:
        del p
        from .can_link import list_channels

        return list_channels()

    # ── 电源 ────────────────────────────────────────────────────────────────
    def _cmd_enable(self, p: dict) -> dict:
        del p
        self.loop.submit(cmd.Enable())
        return {"enabled": True}

    def _cmd_disable(self, p: dict) -> None:
        del p
        self.loop.submit(cmd.Disable())

    def _cmd_clear_fault(self, p: dict) -> None:
        del p
        self.loop.submit(cmd.ClearFault())

    # ── 运动 ────────────────────────────────────────────────────────────────
    def _require_gate(self, method: str) -> None:
        """Refuse a motion the calibration does not allow, before it is queued.

        The loop re-checks the gate on every tick — that is the authority — but a
        refusal that never leaves the WebSocket thread is the difference between
        an operator reading a reason and an operator watching a button do
        nothing.

        The one nuance is the nominal template (§5.3): it allows 张开/闭合/零重力
        and refuses every millimetre target, because its geometry describes a
        120 mm unit and every target computed from it would be wrong by about
        40 %.
        """
        with self._lock:
            gate, reason = self._gate, self._gate_reason
        if gate is GateState.READY:
            return
        if gate is GateState.TEMPLATE and method not in _GEOMETRY_COMMANDS:
            return
        raise GripperCalibrationError(reason or f"标定未就绪, 拒绝 {method}")

    def _cmd_open(self, p: dict) -> dict:
        del p
        self._require_gate("gripper.open")
        self.loop.submit(cmd.Open())
        return {"ok": True}

    def _cmd_close(self, p: dict) -> dict:
        del p
        self._require_gate("gripper.close")
        self.loop.submit(cmd.Close())
        return {"ok": True}

    def _cmd_grasp(self, p: dict) -> dict:
        force = _optional_float(p, "forceN")
        if force is not None:
            _check_range(force, 0.0, constants.FORCE_MAX_N, "forceN")
        hold = _optional_float(p, "holdS")
        if hold is not None:
            _check_range(hold, 0.0, 3600.0, "holdS")
        self._require_gate("gripper.grasp")
        self.loop.submit(cmd.Grasp(force_n=force))
        with self._lock:
            self._release_at = None if not hold else time.monotonic() + hold
        return {"ok": True}

    def _cmd_move_to(self, p: dict) -> dict:
        target = _required_float(p, "targetMm")
        travel = self.config.travel_mm
        _check_range(target, 0.0, travel, "targetMm")
        speed = _optional_float(p, "speedMmS")
        if speed is not None:
            _check_range(speed, constants.SPEED_MIN_MM_S, constants.SPEED_MAX_MM_S,
                         "speedMmS")
        self._require_gate("gripper.move_to")
        if speed is not None:
            self.loop.submit(cmd.SetSpeed(speed))
        self.loop.submit(cmd.MoveToMm(target, source="move_to"))
        return {"ok": True}

    def _cmd_release(self, p: dict) -> None:
        del p
        self.loop.submit(cmd.Release())

    def _cmd_stop(self, p: dict) -> None:
        del p
        self.estop("上位机急停")

    def _cmd_reset_stop(self, p: dict) -> None:
        del p
        self.loop.submit(cmd.ResetEStop())

    def _cmd_set_motion(self, p: dict) -> dict:
        """Set the speed and/or force, and answer with what will be in effect.

        The answer is computed here rather than read back a tick later: the
        command is queued, so ``MotionFSM.params`` still holds the old values
        when this returns.  The two clamps below are the FSM's own
        (``Limits.clamp_speed`` / ``units.clamp_force``), so the numbers in the
        ``res`` frame are the numbers the next tick applies — not an optimistic
        echo of what was asked for.
        """
        speed = _optional_float(p, "speedMmS")
        if speed is not None:
            _check_range(speed, constants.SPEED_MIN_MM_S, constants.SPEED_MAX_MM_S,
                         "speedMmS")
            self.loop.submit(cmd.SetSpeed(speed))
        force = _optional_float(p, "forceN")
        if force is not None:
            _check_range(force, 0.0, constants.FORCE_MAX_N, "forceN")
            self.loop.submit(cmd.SetForce(force))
        params = self.loop.motion.params
        return {
            "speedMmS": self.loop.motion.limits.clamp_speed(
                speed if speed is not None else params.speed_mm_s),
            "forceN": clamp_force(force if force is not None else params.force_n),
        }

    # ── 标定 (§5.3) ─────────────────────────────────────────────────────────
    def _cmd_load_template(self, p: dict) -> dict:
        """Declare the mounting direction by loading an SDK template by name."""
        mount = p.get("mount")
        if mount not in ("normal", "reverse"):
            raise ValueError("mount 需为 normal 或 reverse")
        self._persist(mount=mount)
        # The declaration reaches the backend *before* the load.  They are two
        # commands only because the queue is FIFO, which is what makes the order
        # hold: resolution row 5 answers with a template only when the backend
        # already knows a mount has been declared.
        self.loop.submit(cmd.SetMount(mount))
        self.loop.submit(cmd.LoadTemplate(mount))
        info = self._await_calibration(
            lambda i: i.template == mount,
            f"模板 {mount} 未在 {constants.CALIBRATION_LOAD_TIMEOUT_S:.0f}s 内生效")
        return {"mount": mount, "source": info.wire_source}

    def _cmd_list_calibrations(self, p: dict) -> List[dict]:
        """Every calibration this channel could use, with provenance and validity.

        A filesystem question, answered without a connection: the settings page
        asks it before it connects, which is when the operator is deciding which
        file to use.
        """
        del p
        config = self.config
        return calibration.list_candidates(
            config.channel,
            pinned=config.calibration_path,
            mount=config.mount,
            travel_mm=config.travel_mm,
        )

    def _cmd_import_calibration(self, p: dict) -> dict:
        """Pin and apply a calibration file the operator chose."""
        path = p.get("path")
        if not isinstance(path, str) or not path.strip():
            raise ValueError("path 是必需的 (控制机上的文件路径)")
        target = Path(path).expanduser()
        if not target.is_file():
            raise ValueError(f"标定文件不存在: {target}")
        # Validate before the SDK sees it: the SDK indexes the keys unguarded,
        # so a malformed file would surface as a KeyError from inside it.
        preview = calibration.inspect_file(target, self.config.travel_mm)
        if preview.problems:
            raise GripperCalibrationError("；".join(preview.problems))
        self._persist(calibration_path=str(target))
        # The backend must know the pin before it is asked to resolve again: the
        # next connect re-resolves this channel's calibration, and it has to end
        # at the file the operator pinned rather than at the channel default.
        self.loop.submit(cmd.SetCalibrationPath(str(target)))
        self.loop.submit(cmd.LoadCalibration(str(target)))
        info = self._await_calibration(
            lambda i: i.path == str(target),
            f"{target} 未在 {constants.CALIBRATION_LOAD_TIMEOUT_S:.0f}s 内生效")
        if not info.usable:
            raise GripperCalibrationError("；".join(info.problems) or "标定不可用")
        return {"path": str(target), "source": info.wire_source}

    def _cmd_zero(self, p: dict) -> dict:
        """Measure both travel limits, save the result, and answer with it.

        The only long-blocking gripper command: the probe runs on the tick (one
        step per tick, so an E-stop interrupts it), while this thread waits for
        it to finish and answers with the calibration that came out.  The client
        must not subject it to the ordinary 60 s command timeout (§4.2).
        """
        travel = _required_float(p, "travelMm")
        _check_range(travel, constants.STROKE_MIN_MM, constants.STROKE_MAX_MM,
                     "travelMm")
        loop = self.loop
        if loop.estopped:
            raise GripperEstoppedError("急停已触发; 请先排除原因并按复位急停")
        if not loop.connected:
            raise GripperNotConnectedError("夹爪未连接")
        if loop.probe is not None:
            raise GripperBusyError("已有标定正在进行")
        if not loop.enabled:
            # The probe drives into the stops and steers by the encoder, so it
            # needs a motor that answers.  Said here rather than left to the
            # tick, because a probe refused on the tick looks like nothing.
            raise ValueError("标定需要电机使能；请先使能再运行零位标定")

        # The travel is the numerator of every millimetre the calibration will
        # produce, so it is recorded before the probe uses it.
        self._persist(travel_mm=travel)
        loop.submit(cmd.SetTravelMm(travel))
        loop.submit(cmd.StartGuidedCalibration(
            reversed_mount=(self.config.mount == "reverse")))
        if not self._wait_until(lambda: self.loop.probe is not None, 5.0):
            raise GripperCalibrationError("标定未能开始（检查使能、急停与连接状态）")
        # ⚠ Wait for the *result*, not merely for the probe object to be dropped:
        # ``_finish_probe`` clears it first and adopts, validates and saves the
        # calibration afterwards, so a waiter that stopped at the first half
        # would answer with the in-memory (unsaved) numbers — and the page would
        # show a result that is not yet on disk.
        if not self._wait_until(
                lambda: self.loop.probe is None
                and self.loop.info is not None
                and self.loop.info.provenance != calibration.PROVENANCE_MEMORY,
                constants.ZERO_PROBE_TIMEOUT_S):
            self.loop.submit(cmd.CancelCalibration())
            raise GripperCalibrationError(
                f"标定超过 {constants.ZERO_PROBE_TIMEOUT_S:.0f}s 未结束，已取消")
        info = self.loop.info
        if info is None or info.limits is None:
            reason = "；".join(info.problems) if info is not None else "没有标定结果"
            raise GripperCalibrationError(reason or "标定未产生可用的结果")
        return {
            "closedRad": info.limits.closed_rad,
            "openRad": info.limits.open_rad,
            "radToMm": info.limits.rad_to_mm,
            "source": info.wire_source,
            "warnings": list(info.warnings),
        }

    def _cmd_set_allow_factory(self, p: dict) -> dict:
        """Persist the operator's acknowledgement of the factory calibration.

        A decision, not a state, so it is written to the per-channel record: the
        gate reads it on the next tick, and a restart does not silently withdraw
        an acknowledgement the operator made.
        """
        allow = p.get("allow")
        if not isinstance(allow, bool):
            raise ValueError("allow 需布尔值")
        self._persist(allow_factory=allow)
        self.loop.set_allow_factory(allow)
        return {"allowFactory": allow}

    # ── 标定辅助 ────────────────────────────────────────────────────────────
    def _persist(self, **changes: Any) -> None:
        """Write fields into the channel record and adopt the result."""
        with self._lock:
            record = replace(self._config, **changes)
            self._config = self._store.put(record)

    def _wait_until(self, predicate: Callable[[], bool], timeout_s: float) -> bool:
        deadline = time.monotonic() + float(timeout_s)
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return bool(predicate())

    def _await_calibration(self, predicate: Callable[[Any], bool],
                           failure: str) -> Any:
        """Wait for the loop to report the calibration a load command asked for."""
        if not self._wait_until(
                lambda: self.loop.info is not None and predicate(self.loop.info),
                constants.CALIBRATION_LOAD_TIMEOUT_S):
            raise GripperCalibrationError(failure)
        return self.loop.info

    # ── 急停 ────────────────────────────────────────────────────────────────
    def estop(self, reason: str = "上位机急停") -> None:
        """Trip the latch.  Callable from any thread; takes effect within a tick."""
        loop = self._loop
        if loop is not None:
            loop.estop(reason)

    def estopped(self) -> bool:
        loop = self._loop
        return bool(loop is not None and loop.estopped)

    def heartbeat(self) -> None:
        """Tell the loop an operator's client is still there.

        The daemon's equivalent of the console's 500 ms heartbeat: the server
        stamps it whenever a client is connected, so the loop's watchdog stops
        the motion within ``GUI_WATCHDOG_S`` of the last client going away — and,
        unlike the console's, never ends the session over it.
        """
        loop = self._loop
        if loop is not None and not self._closed:
            loop.submit(cmd.Heartbeat())

    def _loop_submit(self, command: Any) -> int:
        return self.loop.submit(command)


# ---------------------------------------------------------------------- 参数
def _required_float(p: dict, key: str) -> float:
    if key not in p or p[key] is None:
        raise ValueError(f"{key} 是必需的")
    value = p[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{key} 需数值")
    return float(value)


def _optional_float(p: dict, key: str) -> Optional[float]:
    if key not in p or p[key] is None:
        return None
    value = p[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{key} 需数值")
    return float(value)


def _check_range(value: float, low: float, high: float, key: str) -> None:
    if not (low <= value <= high):
        raise ValueError(f"{key} 需在 {low}..{high} 之间 (收到 {value})")
