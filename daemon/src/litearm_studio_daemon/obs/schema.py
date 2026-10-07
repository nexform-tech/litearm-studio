"""The one record shape every daemon log line, WS `log` frame and page row uses.

Who reads this: anyone emitting or consuming a daemon log record, and anyone
wiring the JSONL file into a log platform.

Why a schema module instead of free-form ``logging.info("...")`` calls:

* the same record is written to the JSONL file, broadcast over the WebSocket and
  later read back by the page, so its field names must not drift between the two
  sides of the wire;
* the field names follow **OpenTelemetry's log data model** (``time_unix_nano``,
  ``observed_time_unix_nano``, ``severity_text``, ``severity_number``,
  ``body``, ``trace_id``, ``span_id``) rather than this project's own taste.
  That is the whole point of the standard: a record dropped into Loki, an
  Elastic pipeline, a Fluent Bit forwarder or an OTel Collector keeps working
  without a translation layer. Anyone reading this file who knows OTLP already
  knows the record.

Deliberately **not** in the record:

* local wall-clock offsets. Time is UTC in both forms below, so a file from a
  machine in another timezone needs no interpretation.
* free-form keys. Everything command-specific lives under ``fields``, whose
  contents are produced by :mod:`litearm_studio_daemon.obs.redact`, so a
  credential cannot reach a log line by accident.

The Python names below are snake_case (``severity_number``) and the JSON keeps
them; the firmware-facing WS frames use camelCase, but those are a different
contract (``REFACTOR_PLAN`` §3.1) and are not affected by this one.
"""
from __future__ import annotations

from typing import Any, Dict, Final, Mapping, Tuple

#: ``service.name`` — the OTLP resource attribute. One value per process.
SERVICE_NAME: Final[str] = "litearm-studio-daemon"

# --------------------------------------------------------------------------- levels

#: OTLP's six severity buckets, most severe last. The *names* are OTLP's
#: (`WARN`, not Python's `WARNING` and not JavaScript's `warning`), so a record
#: carries one spelling whichever side produced it.
SEVERITY_NAMES: Final[Tuple[str, ...]] = ("TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL")

#: OTLP assigns each bucket a number; consumers sort and filter on this rather
#: than parsing the text. Each bucket actually spans four values (INFO is 9-12),
#: and the canonical value for "unqualified INFO" is the bucket's base.
SEVERITY_NUMBERS: Final[Mapping[str, int]] = {
    "TRACE": 1,
    "DEBUG": 5,
    "INFO": 9,
    "WARN": 13,
    "ERROR": 17,
    "FATAL": 21,
}

#: Spellings that mean the same bucket. Python logging says `WARNING`, structlog
#: accepts both, and JavaScript says `warning`; normalising here is what lets the
#: frontend treat a daemon record and a browser-side record identically.
SEVERITY_ALIASES: Final[Mapping[str, str]] = {
    "TRACE": "TRACE",
    "DEBUG": "DEBUG",
    "INFO": "INFO",
    "NOTICE": "INFO",
    "WARN": "WARN",
    "WARNING": "WARN",
    "ERROR": "ERROR",
    "ERR": "ERROR",
    "CRITICAL": "FATAL",
    "FATAL": "FATAL",
}

#: Python ``logging`` level → schema severity. The one mapping the daemon needs,
#: because the file handler is a stdlib handler.
LOGGING_LEVEL_TO_SEVERITY: Final[Mapping[int, str]] = {
    1: "DEBUG",       # logging.DEBUG is 10; 1 catches finer-grained custom levels
    5: "DEBUG",
    10: "DEBUG",
    20: "INFO",
    30: "WARN",
    40: "ERROR",
    50: "FATAL",
}

#: Schema severity → Python ``logging`` level, for the reverse direction.
SEVERITY_TO_LOGGING_LEVEL: Final[Mapping[str, int]] = {
    "TRACE": 5,
    "DEBUG": 10,
    "INFO": 20,
    "WARN": 30,
    "ERROR": 40,
    "FATAL": 50,
}

#: Field order of a rendered record. Fixed so the JSONL file is diffable by eye
#: and so a human reading one line finds the same things in the same place; a
#: JSON object does not need an order, but readers do appreciate one.
RECORD_KEYS: Final[Tuple[str, ...]] = (
    "ts",
    "ts_ns",
    "observed_ts_ns",
    "severity",
    "severity_number",
    "event",
    "body",
    "trace_id",
    "span_id",
    "service",
    "version",
    "host",
    "pid",
    "thread",
    "source",
    "fields",
)


def normalize_severity(value: object, *, default: str = "INFO") -> str:
    """Any level spelling → one of :data:`SEVERITY_NAMES`.

    Unknown input returns ``default`` rather than raising: an unrecognised level
    on a log record must never be the reason the daemon falls over.
    """
    if isinstance(value, str):
        name = SEVERITY_ALIASES.get(value.strip().upper())
        if name is not None:
            return name
    if isinstance(value, int):
        return LOGGING_LEVEL_TO_SEVERITY.get(value, default)
    return default


def severity_number(severity: str) -> int:
    """OTLP numeric value for a schema severity (already-normalised input)."""
    return SEVERITY_NUMBERS.get(normalize_severity(severity), SEVERITY_NUMBERS["INFO"])


def is_severity_at_least(severity: str, minimum: str) -> bool:
    """Is ``severity`` at least ``minimum``? Used by the level filter."""
    return severity_number(severity) >= severity_number(minimum)


# --------------------------------------------------------------------------- events

#: ``kind`` groups events that answer one operator question. The page uses it
#: for its top-level filter; `event` remains the precise identity.
KIND_SESSION: Final[str] = "session"
KIND_COMMAND: Final[str] = "command"
KIND_GRIPPER: Final[str] = "gripper"
KIND_FIRMWARE: Final[str] = "firmware"
KIND_SYSTEM: Final[str] = "system"

KINDS: Final[Tuple[str, ...]] = (
    KIND_SESSION, KIND_COMMAND, KIND_GRIPPER, KIND_FIRMWARE, KIND_SYSTEM,
)

#: Every event the daemon can emit, as (name, kind, default severity, summary).
#:
#: This table is the **single source** for three consumers: the emitter (whose
#: call sites use the constants below), the page (which fetches it from
#: ``/api/logs/events`` to build labels and filters) and the docs. An event name
#: that is not in here is a bug, not an extension point — that is what keeps the
#: page's filter list and the daemon's vocabulary from drifting apart.
EVENTS: Final[Tuple[Tuple[str, str, str, str], ...]] = (
    # -- arm session lifecycle
    ("session.connect.started", KIND_SESSION, "INFO",
     "连接开始"),
    ("session.connect.succeeded", KIND_SESSION, "INFO",
     "连接成功"),
    ("session.connect.failed", KIND_SESSION, "ERROR",
     "连接失败"),
    ("session.connect.discarded", KIND_SESSION, "INFO",
     "连接收尾时已被断开/关闭, 链路被丢弃"),
    ("session.disconnected", KIND_SESSION, "INFO",
     "断开"),
    ("session.closed", KIND_SESSION, "INFO",
     "守护进程收尾, 会话关闭"),
    ("session.link.lost", KIND_SESSION, "WARN",
     "链路断开"),
    ("session.link.recovered", KIND_SESSION, "INFO",
     "链路已恢复"),
    ("session.link.recover_failed", KIND_SESSION, "INFO",
     "自愈的一次尝试失败 (窗口内还会再试)"),
    ("session.link.recover_gave_up", KIND_SESSION, "ERROR",
     "自愈窗口用尽"),
    ("session.link.recover_error", KIND_SESSION, "ERROR",
     "自愈异常结束"),
    ("session.deenergized", KIND_SESSION, "INFO",
     "退出前已失能 (降能量)"),
    ("session.deenergize_failed", KIND_SESSION, "WARN",
     "退出前失能失败"),
    ("session.deenergize_skipped", KIND_SESSION, "INFO",
     "退出前按配置保持使能"),

    # -- commands (the SDK traffic an operator needs to reconstruct)
    ("arm.command.succeeded", KIND_COMMAND, "INFO",
     "命令成功"),
    ("arm.command.failed", KIND_COMMAND, "ERROR",
     "命令失败"),

    # -- activation
    ("arm.activate.succeeded", KIND_COMMAND, "INFO",
     "在线激活成功"),
    ("arm.activate.failed", KIND_COMMAND, "ERROR",
     "在线激活失败"),

    # -- firmware upgrade
    ("arm.firmware.image_inspected", KIND_FIRMWARE, "INFO",
     "固件镜像已校验"),
    ("arm.firmware.upgrade_started", KIND_FIRMWARE, "INFO",
     "固件升级开始"),
    ("arm.firmware.upgrade_finished", KIND_FIRMWARE, "INFO",
     "固件升级结束"),
    ("arm.firmware.upgrade_crashed", KIND_FIRMWARE, "ERROR",
     "固件升级线程异常结束"),
    ("arm.firmware.entered_bootloader", KIND_FIRMWARE, "INFO",
     "设备已交棒进 ROM bootloader"),
    ("arm.firmware.link_restored", KIND_FIRMWARE, "INFO",
     "升级后链路已恢复"),

    # -- gripper (the worker's own `_log`/`_alert` channels)
    ("gripper.conn.connecting", KIND_GRIPPER, "INFO",
     "夹爪连接中"),
    ("gripper.conn.connected", KIND_GRIPPER, "INFO",
     "夹爪已连接"),
    ("gripper.conn.disconnected", KIND_GRIPPER, "INFO",
     "夹爪已断开"),
    ("gripper.conn.failed", KIND_GRIPPER, "ERROR",
     "夹爪连接失败"),
    ("gripper.log", KIND_GRIPPER, "DEBUG",
     "夹爪运行日志"),
    ("gripper.alert", KIND_GRIPPER, "INFO",
     "夹爪提示"),
    ("gripper.fault", KIND_GRIPPER, "ERROR",
     "夹爪驱动故障"),
    ("gripper.busy", KIND_GRIPPER, "DEBUG",
     "夹爪忙碌状态变化"),

    # -- daemon/transport
    ("daemon.ws.connected", KIND_SYSTEM, "DEBUG",
     "浏览器客户端已接入"),
    ("daemon.ws.rejected", KIND_SYSTEM, "WARN",
     "拒绝跨源 WebSocket"),
    ("daemon.ws.disconnected", KIND_SYSTEM, "DEBUG",
     "浏览器客户端已离开"),
    ("daemon.upstream.invalid", KIND_SYSTEM, "WARN",
     "上行帧格式非法"),
    ("daemon.command.timeout", KIND_SYSTEM, "ERROR",
     "命令超过等待上限"),
    ("daemon.log.dropped", KIND_SYSTEM, "WARN",
     "慢客户端导致 log 帧被丢弃"),
    ("daemon.started", KIND_SYSTEM, "INFO",
     "守护进程已启动"),
    ("daemon.startup_refused", KIND_SYSTEM, "ERROR",
     "启动参数非法, 进程拒绝启动"),
)

#: ``event`` → ``kind``. Built once; the table above is the only input.
EVENT_KINDS: Final[Mapping[str, str]] = {name: kind for name, kind, _, _ in EVENTS}

#: ``event`` → default severity when the emitter has no opinion of its own.
EVENT_SEVERITIES: Final[Mapping[str, str]] = {name: sev for name, _, sev, _ in EVENTS}

#: ``event`` → one-line summary. Docs and the page's filter list use it.
EVENT_SUMMARIES: Final[Mapping[str, str]] = {name: text for name, _, _, text in EVENTS}


# --------------------------------------------------------------------------- names
#
# The emitter uses these constants, never a string literal: a typo then fails at
# import instead of silently creating a second, unmatched vocabulary. The names
# are still spelled out above so the catalogue is readable in one place.

CONNECT_STARTED: Final[str] = "session.connect.started"
CONNECT_SUCCEEDED: Final[str] = "session.connect.succeeded"
CONNECT_FAILED: Final[str] = "session.connect.failed"
CONNECT_DISCARDED: Final[str] = "session.connect.discarded"
DISCONNECTED: Final[str] = "session.disconnected"
SESSION_CLOSED: Final[str] = "session.closed"
LINK_LOST: Final[str] = "session.link.lost"
LINK_RECOVERED: Final[str] = "session.link.recovered"
RECOVER_FAILED: Final[str] = "session.link.recover_failed"
RECOVER_GAVE_UP: Final[str] = "session.link.recover_gave_up"
RECOVER_ERROR: Final[str] = "session.link.recover_error"
DEENERGIZED: Final[str] = "session.deenergized"
DEENERGIZE_FAILED: Final[str] = "session.deenergize_failed"
DEENERGIZE_SKIPPED: Final[str] = "session.deenergize_skipped"

COMMAND_SUCCEEDED: Final[str] = "arm.command.succeeded"
COMMAND_FAILED: Final[str] = "arm.command.failed"

ACTIVATE_SUCCEEDED: Final[str] = "arm.activate.succeeded"
ACTIVATE_FAILED: Final[str] = "arm.activate.failed"

IMAGE_INSPECTED: Final[str] = "arm.firmware.image_inspected"
UPGRADE_STARTED: Final[str] = "arm.firmware.upgrade_started"
UPGRADE_FINISHED: Final[str] = "arm.firmware.upgrade_finished"
UPGRADE_CRASHED: Final[str] = "arm.firmware.upgrade_crashed"
ENTERED_BOOTLOADER: Final[str] = "arm.firmware.entered_bootloader"
FIRMWARE_LINK_RESTORED: Final[str] = "arm.firmware.link_restored"

GRIPPER_CONNECTING: Final[str] = "gripper.conn.connecting"
GRIPPER_CONNECTED: Final[str] = "gripper.conn.connected"
GRIPPER_DISCONNECTED: Final[str] = "gripper.conn.disconnected"
GRIPPER_CONNECT_FAILED: Final[str] = "gripper.conn.failed"
GRIPPER_LOG: Final[str] = "gripper.log"
GRIPPER_ALERT: Final[str] = "gripper.alert"
GRIPPER_FAULT: Final[str] = "gripper.fault"
GRIPPER_BUSY: Final[str] = "gripper.busy"

WS_CONNECTED: Final[str] = "daemon.ws.connected"
WS_REJECTED: Final[str] = "daemon.ws.rejected"
WS_DISCONNECTED: Final[str] = "daemon.ws.disconnected"
UPSTREAM_INVALID: Final[str] = "daemon.upstream.invalid"
COMMAND_TIMEOUT: Final[str] = "daemon.command.timeout"
LOG_DROPPED: Final[str] = "daemon.log.dropped"
DAEMON_STARTED: Final[str] = "daemon.started"
STARTUP_REFUSED: Final[str] = "daemon.startup_refused"

#: Commands whose *success* is worth an INFO record. Reads and settings changes
#: (`get_tcp`, `set_payload`, `get_joint_params`, …) stay at DEBUG: the page can
#: show them, but a JSONL file that records every 10 Hz read is not a log, it is
#: a packet capture. Failures are always INFO-or-worse, so nothing is lost.
NOTABLE_COMMANDS: Final[frozenset] = frozenset({
    "enable", "disable", "estop", "home", "movej", "movel", "reset",
    "clear_faults", "save_params", "reset_factory_params", "zero_g_start",
    "zero_g_stop", "activate", "firmware_upgrade", "firmware_cancel",
})


def event_catalog() -> Dict[str, Any]:
    """The event table as JSON, for ``GET /api/logs/events``.

    The page fetches this instead of keeping its own list of event names: one
    source, so a new event appears in the filter UI the moment the daemon
    restarts rather than the next time someone remembers to update the frontend.
    """
    return {
        "service": SERVICE_NAME,
        "severities": list(SEVERITY_NAMES),
        "severityNumbers": dict(SEVERITY_NUMBERS),
        "kinds": list(KINDS),
        "events": [
            {"event": name, "kind": kind, "severity": severity, "summary": summary}
            for name, kind, severity, summary in EVENTS
        ],
    }
