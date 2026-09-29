"""The per-channel gripper device record, and where it is persisted.

One gripper per CAN channel, one record per channel.  The record carries the
things the daemon must remember across a restart and that the SDK's calibration
schema has no field for — above all the measured travel, which is the numerator
of every millimetre the UI shows (see ``docs/GRIPPER_INTEGRATION.md`` §5.6).

The file lives next to the daemon's other settings, under
``$XDG_CONFIG_HOME/litearm-studio/gripper.json`` (``~/.config`` by default), and
is overridable with ``LITEARM_STUDIO_GRIPPER_CONFIG`` for tests and for operators
who keep their configuration somewhere else.

Reading never raises on a malformed or foreign file: a record that cannot be
understood is reported as "no record", and the session then falls back to the
defaults below rather than refusing to start.  Writing is atomic — a daemon that
is killed mid-save must not leave a half-written file that reads back as
garbage.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from dataclasses import asdict, dataclass, fields, replace
from pathlib import Path
from typing import Dict, Optional

from . import constants

log = logging.getLogger("litearm_studio_daemon.gripper.config")

#: Environment override for the record file's location.
CONFIG_ENV = "LITEARM_STUDIO_GRIPPER_CONFIG"


def default_config_path() -> Path:
    """``$XDG_CONFIG_HOME/litearm-studio/gripper.json``, expanded."""
    override = os.environ.get(CONFIG_ENV)
    if override:
        return Path(override).expanduser()
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base).expanduser() if base else Path.home() / ".config"
    return root / "litearm-studio" / "gripper.json"


@dataclass(frozen=True)
class ChannelConfig:
    """Everything the daemon remembers about the gripper on one CAN channel."""

    channel: str = constants.CAN_CHANNEL
    can_id: int = 0x08
    mst_id: Optional[int] = None
    #: ``"normal"`` or ``"reverse"`` (an SDK template name), always declared.
    #: The reference hardware is assembled normal, so that is the default: an
    #: undeclared mount is not a state the operator can be left in.  The
    #: consequence is deliberate — with no measured file for the channel,
    #: ``calibration.resolve`` then loads the ``normal`` template, which is a
    #: direction and a nominal geometry, never a measurement.
    mount: str = "normal"
    #: A calibration file the operator pinned for this channel.  Takes priority
    #: over the channel's own default path (see ``calibration.resolve``).
    calibration_path: Optional[str] = None
    #: The measured travel of this unit, in millimetres.  Per channel, because
    #: two grippers on one machine can differ, and it must survive a restart:
    #: the SDK does not store it (see ``docs/GRIPPER_INTEGRATION.md`` D5).
    travel_mm: float = constants.DEFAULT_TRAVEL_MM
    #: The operator's explicit acknowledgement of the SDK's bundled factory
    #: calibration.  Persisted, because it is a decision rather than a state.
    allow_factory: bool = False

    @property
    def mounted(self) -> bool:
        return self.mount in ("normal", "reverse")

    def to_wire(self) -> dict:
        """The subset the ``gripper_conn`` frame carries."""
        return {
            "channel": self.channel,
            "canId": int(self.can_id),
            "mount": self.mount,
            "path": self.calibration_path,
            "travelMm": float(self.travel_mm),
            "allowFactory": bool(self.allow_factory),
        }


def _coerce(data: dict, fallback: ChannelConfig, channel: str) -> ChannelConfig:
    """One JSON object → a record, ignoring anything that cannot be read.

    Deliberately lenient about individual fields and strict about the shape: a
    bad ``travel_mm`` should cost the travel and not the whole record, while a
    record whose top level is not an object is not a record at all.
    """
    if not isinstance(data, dict):
        return replace(fallback, channel=channel)
    out = fallback
    try:
        out = replace(out, channel=str(data.get("channel") or channel))
    except (TypeError, ValueError):
        pass
    for key, cast in (("can_id", int), ("mst_id", int)):
        if key in data and data[key] is not None:
            try:
                out = replace(out, **{key: cast(data[key])})
            except (TypeError, ValueError):
                log.warning("夹爪配置字段 %s 无法解析, 已忽略: %r", key, data[key])
    # A record written before the mount had a default may carry ``null``, and a
    # hand-edited one may carry anything else.  Neither is a direction the
    # daemon can use; both fall back to the default rather than travelling on as
    # ``None`` and re-opening the undeclared state.
    declared_mount = data.get("mount")
    if declared_mount in ("normal", "reverse"):
        out = replace(out, mount=declared_mount)
    elif declared_mount is not None:
        log.warning("夹爪配置 mount 无效, 按 %s 处理: %r", out.mount, declared_mount)
    if isinstance(data.get("calibration_path"), (str, type(None))):
        out = replace(out, calibration_path=data.get("calibration_path"))
    if data.get("travel_mm") is not None:
        try:
            travel = float(data["travel_mm"])
        except (TypeError, ValueError):
            travel = -1.0
        if travel > 0.0:
            out = replace(out, travel_mm=travel)
        else:
            log.warning("夹爪配置 travel_mm 无效, 已忽略: %r", data.get("travel_mm"))
    if isinstance(data.get("allow_factory"), bool):
        out = replace(out, allow_factory=data["allow_factory"])
    return out


class ChannelStore:
    """The record file: load once, mutate under a lock, write atomically."""

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path) if path is not None else default_config_path()
        self._lock = threading.RLock()
        self._records: Dict[str, ChannelConfig] = {}
        #: The channel the operator last configured or connected, so a restart
        #: comes back to that gripper rather than to ``can0``.
        self._last: Optional[str] = None
        self._loaded = False

    # ---------------------------------------------------------------- reading
    def load(self) -> Dict[str, ChannelConfig]:
        """Read the file (once) and return a copy of the records."""
        with self._lock:
            if not self._loaded:
                self._records, self._last = self._read()
                self._loaded = True
            return dict(self._records)

    def last_channel(self) -> Optional[str]:
        self.load()
        with self._lock:
            return self._last

    def _read(self) -> tuple[Dict[str, ChannelConfig], Optional[str]]:
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}, None
        except OSError as exc:
            log.warning("无法读取夹爪配置 %s: %s", self.path, exc)
            return {}, None
        try:
            data = json.loads(text)
        except ValueError as exc:
            log.warning("夹爪配置 %s 不是合法 JSON (%s); 按无配置处理", self.path, exc)
            return {}, None
        raw = data.get("channels") if isinstance(data, dict) else None
        if not isinstance(raw, dict):
            log.warning("夹爪配置 %s 缺少 channels 对象; 按无配置处理", self.path)
            return {}, None
        out: Dict[str, ChannelConfig] = {}
        for channel, item in raw.items():
            name = str(channel)
            out[name] = _coerce(item, ChannelConfig(channel=name), name)
        last = data.get("lastChannel")
        return out, (str(last) if last in out else None)

    def get(self, channel: str) -> ChannelConfig:
        """The record for ``channel``, or a default record for it."""
        return self.load().get(channel, ChannelConfig(channel=channel))

    def all(self) -> Dict[str, ChannelConfig]:
        return self.load()

    # ---------------------------------------------------------------- writing
    def put(self, record: ChannelConfig) -> ChannelConfig:
        """Store ``record`` and return what is now persisted for its channel."""
        with self._lock:
            self.load()
            self._records[record.channel] = record
            self._last = record.channel
            self._write()
            return self._records[record.channel]

    def update(self, channel: str, **changes) -> ChannelConfig:
        """Apply the given fields to ``channel``'s record and persist it.

        Only real dataclass fields are accepted, so a typo in a caller is a
        ``TypeError`` here rather than a silently dropped setting.
        """
        known = {f.name for f in fields(ChannelConfig)}
        unknown = set(changes) - known
        if unknown:
            raise TypeError(f"未知的夹爪配置字段: {', '.join(sorted(unknown))}")
        with self._lock:
            current = self.get(channel)
            return self.put(replace(current, **changes))

    def forget(self, channel: str) -> bool:
        with self._lock:
            self.load()
            existed = self._records.pop(channel, None) is not None
            if existed:
                self._write()
            return existed

    def _write(self) -> None:
        payload = {
            "channels": {
                name: asdict(record) for name, record in sorted(self._records.items())
            },
            "lastChannel": self._last,
        }
        text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # Atomic: a reader (or a crash) never sees a partial file.
            fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), prefix=".gripper-",
                                       suffix=".json")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(text)
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError as exc:
            # A record that cannot be written is not a reason to stop driving
            # the gripper: the operator is told, and the in-memory record — which
            # is what this session is actually using — stays correct.
            log.warning("无法写入夹爪配置 %s: %s", self.path, exc)
