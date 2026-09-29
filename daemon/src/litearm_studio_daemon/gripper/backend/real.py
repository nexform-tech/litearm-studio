"""The real backend: the LiteGrip SDK behind the same four primitives.

Only public SDK methods are used, and only four of them are on the control path
— ``send_mit_frame``, ``poll``, ``get_state(wait=False)`` and ``stop``.  Every
convenience method is deliberately unused, and the reasons are structural rather
than stylistic (they are listed at length in
:mod:`litearm_studio_daemon.gripper.backend`).  The one that matters most here:
``control_mit_stream`` has no abort hook (can_bus.py:342), so anything built on
it cannot be interrupted, which rules out ``open``, ``close``, ``grasp``,
``goto``, ``move_to`` and ``move_at_speed`` for a console whose E-stop has to
work inside one tick.

Two things this class is careful about, both about not lying:

*No blocking getters.*  ``get_position``, ``get_torque``, ``get_error`` and
friends each call ``update_state(timeout_s=0.05)`` internally — 50 ms, ten ticks
— so a status display built on them would stall the control loop.  Everything
comes from one ``get_state(wait=False)``.

*No mm from the SDK.*  ``get_state().position_mm`` is computed by the SDK from
its own ``GripperConfig``.  This class converts the raw rad with the validated
:class:`~litearm_studio_daemon.gripper.units.Limits` instead, so the number the FSM reads
back is derived by the same mapping it used to write the command.  Deriving it
twice is how a servo ends up with a steady-state error that does not exist.

The class accepts a pre-built ``gripper`` object, which is how the tests drive
every calibration path without a CAN interface.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from litegrip import GripperConfig, LiteGrip, LiteGripError, describe_error

from .. import calibration, constants
from ..can_link import link_failure
from ..calibration import CalibrationInfo
from ..telemetry import Telemetry
from ..units import Limits, force_from_torque
from . import (
    BackendError,
    ConnectFailed,
    EnableFailed,
    FaultActive,
    GripperBackend,
    LinkDown,
    NotReady,
)

log = logging.getLogger(__name__)


def _same_file(a: str | Path, b: str | Path) -> bool:
    """Whether two paths name the same file, spelling and symlinks aside.

    The two sides arrive from opposite directions — the save target is
    whatever string the console was launched with, the factory path is built
    from the package location — so a plain string comparison would miss
    ``~``, ``..`` and a symlinked package directory.  Neither file need exist
    for the answer to be useful, which is why this resolves rather than
    statistics.
    """
    try:
        return Path(a).resolve() == Path(b).resolve()
    except OSError:  # pragma: no cover - unresolvable path
        return str(a) == str(b)


class RealBackend(GripperBackend):
    """The gripper on the other end of the CAN bus."""

    def __init__(
        self,
        *,
        channel: str = "can0",
        can_id: int | None = None,
        mst_id: int | None = None,
        canfd_mode: bool | None = None,
        max_stroke_mm: float = constants.DEFAULT_TRAVEL_MM,
        calibration_path: str | None = None,
        gripper: Any | None = None,
    ) -> None:
        super().__init__()
        self._calibration_path = calibration_path
        self._info: CalibrationInfo | None = None
        self._last_refusal: str | None = None

        if gripper is not None:
            self._gripper = gripper
            return

        # Built through ``config`` rather than positional arguments: the SDK's
        # constructor substitutes ``config`` values for any argument left at its
        # default (gripper.py:101), so passing both means the config silently
        # wins for exactly the arguments that are hardest to notice.
        cfg = GripperConfig()
        cfg.can_channel = channel
        cfg.max_stroke_mm = float(max_stroke_mm)
        if can_id is not None:
            cfg.can_id = int(can_id)
        if mst_id is not None:
            cfg.mst_id = int(mst_id)
        if canfd_mode is not None:
            cfg.canfd_mode = bool(canfd_mode)
        self._gripper = LiteGrip(config=cfg)

    # ── lifecycle ───────────────────────────────────────────────────────────
    def connect(self) -> None:
        self._claim()
        try:
            opened = self._gripper.connect()
        except LiteGripError as exc:
            raise ConnectFailed(f"连接失败: {exc}") from exc
        except Exception as exc:  # pragma: no cover - transport-dependent
            raise ConnectFailed(f"连接失败: {exc}") from exc
        if not opened:
            raise ConnectFailed(f"连接失败: 无法打开 {self._gripper.channel}")

        # A calibration is deliberately NOT loaded here.  The SDK would fall
        # back to its factory file and report success either way, and the whole
        # point of :mod:`litearm_studio_daemon.gripper.calibration` is that the operator sees
        # which file is in effect before anything moves.  The worker loads one
        # explicitly, and the gate refuses motion until a usable one is in.

    def disconnect(self) -> None:
        self._claim()
        try:
            self._gripper.disconnect()
        except Exception as exc:
            # Nothing can be done about a failing teardown, and this is called
            # from a shutdown path where raising would mask the real reason the
            # session is ending.  The socket is going away regardless.
            log.warning("断开连接时出错（已忽略）: %s", exc)

    def enable(self) -> None:
        self._claim()
        self._require_connected()
        try:
            enabled = self._gripper.enable()
        except LiteGripError as exc:
            self._raise_enable(exc)
            return  # unreachable; keeps type checkers happy
        if not enabled:
            raise EnableFailed("使能失败: 驱动器未进入使能状态")

    def disable(self) -> None:
        self._claim()
        if not self._gripper.is_connected:
            return
        try:
            self._gripper.disable()
        except Exception as exc:  # pragma: no cover - transport-dependent
            log.warning("失能时出错: %s", exc)

    def clear_fault(self) -> None:
        self._claim()
        self._require_connected()
        try:
            cleared = self._gripper.clear_fault()
        except LiteGripError as exc:
            code = getattr(exc, "error_code", None)
            raise FaultActive(
                code if code is not None else 0, f"清除故障失败: {exc}"
            ) from exc
        if not cleared:
            raise FaultActive(self.read().error_code, "清除故障失败")

    # ── control-rate primitives ─────────────────────────────────────────────
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
        """Send one MIT frame, refusing anything that could not be meant.

        The last line of defence before hardware, and the only one that is not
        in :mod:`litearm_studio_daemon.gripper.core`: the FSM already clamps every command to
        the validated travel and the units layer already replaces non-finite
        values, so a command arriving here out of range means a bug in one of
        them.  Sending it anyway is how a motor gets a garbage frame; refusing
        turns the bug into a stopped gripper.  The clamp uses *our* limits, not
        the SDK config's, because a clamp derived from a config that may be
        reversed converts a wrong command into a wrong command that looks
        deliberate.

        ``ungated`` is for frames that carry no target this gate has anything to
        say about: the calibration probes, which look for the mechanical stops
        beyond the red lines and run before there is a calibration to check
        against; and 零重力 (``RELEASE``), the wizard's zero gravity
        (``ZERO_G``) and the hold a probe is left in, which command either no
        stiffness or the angle the encoder has just reported.  The
        three refusals below exist to stop a *position command derived from a
        calibration in doubt* from reaching the drive, and none of those frames
        is one.  The name describes the frame rather than its caller because a
        caller can be anything; it relaxes *only* those checks — a non-finite
        value or a negative gain is still refused, because those are wrong
        whatever the calibration says.
        """
        self._claim()
        if not self._gripper.is_enabled:
            return False

        values = (q_rad, kp, kd, dq_rad_s, tau_nm)
        if not all(math.isfinite(v) for v in values):
            return self._refuse(f"非有限值: q={q_rad!r} kp={kp!r} kd={kd!r}")
        if kp < 0.0 or kd < 0.0:
            return self._refuse(f"负增益: kp={kp!r} kd={kd!r}")

        info = self._info
        limits = info.limits if info is not None else None
        # One condition for all three refusals — none at all, failed validation,
        # and loaded-but-does-not-match-the-file — which is why the policy lives
        # on ``CalibrationInfo`` rather than being spelled out here.
        calibrated = info is not None and info.motion_allowed and limits is not None
        if not calibrated and not ungated:
            return self._refuse("标定未通过校验，拒绝发送位置帧")
        if calibrated and not ungated and abs(limits.clamp_rad(q_rad) - q_rad) > 1e-9:
            # An ungated frame skips this, and must: the mechanical stops a probe
            # is looking for are outside the travel by design, so this check
            # applied to a probe stops it one step short of the very limit it is
            # measuring — and a hold at the angle the encoder just reported is
            # outside a stale file's travel for the same reason the file is
            # stale.  It steers by bounded steps from the measurement instead.
            return self._refuse(
                f"目标 {q_rad:.6f} rad 超出标定行程 "
                f"[{limits.rad_low:.6f}, {limits.rad_high:.6f}]"
            )

        sent = bool(
            self._gripper.send_mit_frame(q=q_rad, kp=kp, kd=kd, dq=dq_rad_s, tau=tau_nm)
        )
        if sent:
            self._last_refusal = None
        return sent

    def poll(self) -> bool:
        """Poll for one status frame.  Never blocks."""
        self._claim()
        if not self._gripper.is_connected:
            return False
        try:
            # ``poll`` returns False when ``_can`` is None, so it is its own
            # guard; a status frame is emitted whether or not anyone transmits.
            return bool(self._gripper.poll(timeout_s=0.0))
        except LiteGripError as exc:  # pragma: no cover - transport-dependent
            log.warning("轮询出错: %s", exc)
            return False

    def read(self) -> Telemetry:
        """Snapshot of the cached state.  Never blocks.

        One call, because every other accessor on the SDK blocks for 50 ms.
        ``wait=False`` still polls non-blockingly inside the SDK, so this returns
        whatever the previous :meth:`poll` brought in.
        """
        self._claim()
        if not self._gripper.is_connected:
            return Telemetry(error_code=constants.ERROR_DISABLED, t=time.time())
        try:
            state = self._gripper.get_state(wait=False)
        except LiteGripError as exc:  # pragma: no cover - transport-dependent
            log.warning("读取状态出错: %s", exc)
            return Telemetry(error_code=constants.ERROR_DISABLED, t=time.time())

        limits = self._info.limits if self._info is not None else None
        return Telemetry(
            position_rad=state.position_rad,
            velocity_rad_s=state.velocity_rad_s,
            torque_nm=state.torque_nm,
            temperature_mos=int(state.temperature_mos),
            temperature_coil=int(state.temperature_coil),
            error_code=int(state.error_code),
            # Zero rather than the SDK's own conversion when there is no usable
            # calibration: millimetres are undefined until the travel is known,
            # and a number derived from a possibly-reversed config is worse than
            # no number.  Anything that needs the position while uncalibrated —
            # the probe — works in rad, which is always meaningful.
            position_mm=limits.to_mm(state.position_rad) if limits is not None else 0.0,
            # Well-defined without a calibration: it is a torque scaled by a
            # constant, and the operator needs it most during the probe.
            force_n=force_from_torque(state.torque_nm),
            t=time.time(),
        )

    def zero_torque(self) -> None:
        """Command zero torque, staying enabled and back-drivable.

        ``LiteGrip.stop()`` sends ``kp=kd=0`` and then waits up to 20 ms for a
        status frame, so this blocks for up to two ticks.  That is acceptable
        only because of where it is called from: the E-stop path, where 20 ms is
        the price of the guarantee that the motor is no longer pushing.  The
        ``q_target=0`` the SDK passes alongside the zero gains contributes
        nothing — it is multiplied by ``kp``.
        """
        self._claim()
        try:
            self._gripper.stop()
        except LiteGripError as exc:
            raise BackendError(f"零力矩指令失败: {exc}") from exc

    # ── calibration ─────────────────────────────────────────────────────────
    def load_calibration(self, path: str | None = None) -> bool:
        """Resolve, validate, apply, then verify what the SDK actually applied.

        Returns False for every reason motion must not proceed, including a
        successful load that does not match the file.  The stored
        :class:`CalibrationInfo` carries the reason, so the UI can show it.
        """
        self._claim()
        explicit = path if path is not None else self._calibration_path
        info = calibration.resolve(explicit, self._travel_mm())

        sdk_path = calibration.sdk_load_path(info)
        if sdk_path is None:
            # Unusable, or an unsaved probe result.  Nothing is handed to the
            # SDK: its fallback branch would find *some* file and return True.
            self._info = info
            return False

        try:
            loaded = bool(self._gripper.load_calibration(sdk_path))
        except LiteGripError as exc:
            self._info = replace(
                info, problems=info.problems + (f"SDK 拒绝载入 {sdk_path}: {exc}",)
            )
            return False

        if not loaded:
            # Only reachable if the file vanished between our read and this call.
            self._info = replace(
                info, problems=info.problems + (f"SDK 未能载入 {sdk_path}",)
            )
            return False

        # The one check that observes the outcome instead of constraining the
        # input.  ``load_calibration`` also overwrites kp, kd, can_id, mst_id,
        # channel and canfd_mode from the file (gripper.py:752-767), so a file
        # that disagrees with the running link shows up here too.
        applied = Limits.from_config(self._gripper.config)
        mismatch = calibration.cross_check(info, applied)
        if mismatch:
            # Recorded as problems rather than warnings so that ``motion_allowed``
            # goes false: the numbers may be perfectly self-consistent, but the
            # hardware is demonstrably not running on them.
            self._info = replace(info, problems=info.problems + tuple(mismatch))
            return False

        # The load is confirmed, so the config is now ours to correct: the file's
        # ``rad_to_mm`` is the nominal stroke of whichever unit wrote it, and the
        # scale in force is the one derived from the travel the operator
        # measured.  Deliberately after the cross-check — which is only evidence
        # of anything while the config still holds what the SDK read — and before
        # anything can be driven, saved or configured.
        if info.limits is not None:
            self._apply_to_config(info.limits)

        self._info = info
        return True

    def save_calibration(self, path: str | None = None) -> str:
        """Write the active calibration and re-read it from disk.

        The re-read is not a formality: it is what turns an in-memory probe
        result into a saved one, and it is the only thing that can promote the
        provenance to :data:`~litearm_studio_daemon.gripper.calibration.PROVENANCE_USER` and
        open the gate.
        """
        self._claim()
        info = self._info
        if info is None or info.limits is None:
            raise NotReady("没有可保存的标定")
        target = path or self._calibration_path or str(calibration.default_user_path())

        # The SDK's own file is data, not state: it ships with the package and
        # describes whichever unit it was taken on.  Overwriting it would
        # replace the fallback every later install of this console relies on,
        # and it is reachable without meaning to — the target is the stored
        # path, which is whatever the console was told to load at launch.  The
        # UI's own check is about the calibration in hand, not about where the
        # write is going, and a finished probe writes itself out now, so the
        # target needs a guard of its own.
        if _same_file(target, calibration.factory_path()):
            raise BackendError(
                f"拒绝覆盖出厂标定文件 {target}：那是 SDK 自带的数据，"
                "请把结果保存到用户标定路径"
            )

        # The SDK writes the file from its own config, so the config has to
        # carry our numbers first or we would save whatever was there before.
        self._apply_to_config(info.limits)
        try:
            written = self._gripper.save_calibration(str(target))
        except LiteGripError as exc:
            raise BackendError(f"保存标定失败: {exc}") from exc

        self.load_calibration(written)
        return written

    def set_calibration_memory(
        self,
        zero_rad: float,
        open_rad: float,
        rad_to_mm: float,
        max_stroke_mm: float | None = None,
    ) -> CalibrationInfo:
        """Adopt fresh probe results without saving them.

        Mirrors the simulator's signature so the calibration FSM is identical on
        both.  Still not usable for motion: nothing here survives a restart.
        """
        self._claim()
        stroke = max_stroke_mm if max_stroke_mm is not None else self._travel_mm()
        info = calibration.in_memory(zero_rad, open_rad, rad_to_mm, stroke)
        self._info = info
        if info.limits is not None:
            self._apply_to_config(info.limits)
        return info

    def calibration_info(self) -> CalibrationInfo | None:
        return self._info

    def limits(self) -> Limits:
        """The travel limits in effect.

        The file's numbers whenever the file produced any, because that is the
        calibration the operator vetted, and — via the cross-check — the one the
        SDK is known to agree with.  Only when the file yielded no limits at all
        (a reversed or malformed one) does this fall back to the config, which
        keeps the world describable while motion is refused.

        Deliberately not conditioned on ``motion_allowed``: an in-memory or
        disputed calibration still has the numbers the UI must display, and the
        refusal belongs in one place — :meth:`stream_frame`.
        """
        info = self._info
        if info is not None and info.limits is not None:
            return info.limits
        return Limits.from_config(self._gripper.config)

    def set_travel_mm(self, max_stroke_mm: float) -> None:
        """Set the measured travel, which the SDK's schema cannot carry.

        It is what the mm scale is derived from, the top of the commanded range,
        and the number a calibration file from another unit is caught disagreeing
        with, so it lives on our side of the boundary — on the SDK's
        ``max_stroke_mm`` field, which is the only place the config has to keep
        it, and which ``load_calibration`` leaves alone.
        """
        self._claim()
        self._gripper.config.max_stroke_mm = float(max_stroke_mm)

    def describe(self) -> str:
        cfg = self._gripper.config
        mst = "自动" if cfg.mst_id is None else f"0x{cfg.mst_id:02X}"
        label = self._info.label if self._info is not None else "未标定"
        return (
            f"实机 {self._gripper.channel} | can_id=0x{int(cfg.can_id):02X} "
            f"| mst_id={mst} | {label}"
        )

    # ── internals ───────────────────────────────────────────────────────────
    def _require_connected(self) -> None:
        if not self._gripper.is_connected:
            raise ConnectFailed("尚未连接")

    def _travel_mm(self) -> float:
        return float(getattr(self._gripper.config, "max_stroke_mm", constants.DEFAULT_TRAVEL_MM))

    def _apply_to_config(self, limits: Limits) -> None:
        """Make the SDK's config agree with the limits in force.

        Called after a load has been confirmed, before a save, and after a probe
        result — so the numbers the SDK holds are the numbers the console shows.
        The scale is the derived one either way, which is why this runs after the
        cross-check rather than instead of it.
        """
        cfg = self._gripper.config
        cfg.pos_closed_rad = limits.closed_rad
        cfg.pos_open_rad = limits.open_rad
        cfg.rad_to_mm = limits.rad_to_mm
        cfg.max_stroke_mm = limits.max_stroke_mm

    def _raise_enable(self, exc: Exception) -> None:
        """Turn an enable failure into the fault it actually is.

        The SDK's ``enable`` clears a latched fault first and re-raises from
        inside that, so a HardwareError here usually carries a real error code —
        which the operator needs, because "欠压" and "使能失败" call for
        completely different actions.

        A transport errno is checked first, and deliberately so.  Enable is the
        first operation that has to put a frame on the bus (``connect`` only
        opens a socket), so a down or bus-off interface surfaces here as
        ``[Errno 100] 网络已断开`` — which is neither a motor code nor anything
        the operator can act on as written.  It is the more trustworthy of the
        two signals as well: the errno describes *this* attempt, while a fault
        code could only have come from a frame that arrived before the link
        went down.
        """
        link = link_failure(exc, self._gripper.channel)
        if link is not None:
            raise LinkDown(link) from exc
        code = getattr(exc, "error_code", None)
        if code is not None and code not in constants.OK_ERROR_CODES:
            raise FaultActive(code, describe_error(code)) from exc
        raise EnableFailed(f"使能失败: {exc}") from exc

    def _refuse(self, reason: str) -> bool:
        """Refuse to transmit, logging once per distinct reason.

        Once per reason rather than once per call: this sits on a 200 Hz path,
        and a repeating fault would otherwise write 200 identical lines a second
        and bury the first one, which is the only one that matters.
        """
        if reason != self._last_refusal:
            self._last_refusal = reason
            log.error("拒绝发送 MIT 帧: %s", reason)
        return False
