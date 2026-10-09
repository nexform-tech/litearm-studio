"""Structured logging for the daemon — one record shape, one file, one API.

Who reads this: anyone emitting an event from the daemon, and anyone wondering
why a log line looks the way it does.

The contract, in one paragraph: call :func:`emit` (or a level helper) with an
event name from :mod:`litearm_studio_daemon.obs.schema` and a ``fields`` dict;
it becomes one JSONL line in the daemon's log file and, once the server is
attached, one `log` frame on the WebSocket. Fields are redacted on the way in,
so a call site cannot leak a credential by being careless. The event name is the
stable identity (`arm.command.failed`); ``body`` is the human sentence and is the
only part that is not machine-parseable.

Example — a command that returned:

```python
obs.emit(obs.COMMAND_FAILED, body=f"命令 {method} 失败: {kind}: {text}",
         fields={"method": method, "outcome": "error"},
         level=logging.WARNING, exception=error)
```

Do not call the stdlib `logging` directly for daemon events. Two reasons: it
would produce a record without an event name, and it would bypass redaction —
the one gate that keeps the activation payload out of the file.

The implementation is the standard library: `logging` plus one `Formatter`
(`handlers.ObsJsonlFormatter`) for the record shape, `contextvars` for trace and
span context, and `logging.handlers.RotatingFileHandler` for the file. That last
one is the reason not to hand-roll any of this — writing a whole line atomically
while the file rotates under a concurrent writer is the hard part, and the stdlib
handler already holds its lock across both the rollover and the write.

`RECORD_KEYS` in `schema.py` is what the formatter renders, so the record shape
lives in one place rather than in a chain of processors assembled at startup.
"""
from __future__ import annotations

import contextvars
import logging
import socket
import threading
from contextlib import contextmanager
from pathlib import Path
from time import time_ns
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional

from . import redact, schema
from .handlers import (
    DEFAULT_BACKUPS,
    DEFAULT_MAX_BYTES,
    JsonlFileHandler,
    build_file_handler,
    build_stream_handler,
    default_log_dir,
)
from .schema import (  # re-exported: emitters use `obs.CONNECT_STARTED`
    ACTIVATE_FAILED,
    ACTIVATE_SUCCEEDED,
    COMMAND_FAILED,
    COMMAND_SUCCEEDED,
    COMMAND_TIMEOUT,
    CONNECT_DISCARDED,
    CONNECT_FAILED,
    CONNECT_STARTED,
    CONNECT_SUCCEEDED,
    DAEMON_STARTED,
    DAEMON_WINDOW_CLOSED,
    DEENERGIZED,
    DEENERGIZE_FAILED,
    DEENERGIZE_SKIPPED,
    DISCONNECTED,
    ENTERED_BOOTLOADER,
    EVENT_KINDS,
    EVENT_SEVERITIES,
    FIRMWARE_LINK_RESTORED,
    GRIPPER_ALERT,
    GRIPPER_BUSY,
    GRIPPER_CONNECTED,
    GRIPPER_CONNECTING,
    GRIPPER_CONNECT_FAILED,
    GRIPPER_DISCONNECTED,
    GRIPPER_FAULT,
    GRIPPER_LOG,
    IMAGE_INSPECTED,
    KINDS,
    LINK_LOST,
    LINK_RECOVERED,
    LOG_DROPPED,
    NOTABLE_COMMANDS,
    RECOVER_ERROR,
    RECOVER_FAILED,
    RECOVER_GAVE_UP,
    KIND_SAMPLE,
    SERVICE_NAME,
    SESSION_CLOSED,
    STARTUP_REFUSED,
    STATE_SAMPLE,
    UPGRADE_CRASHED,
    UPGRADE_FINISHED,
    UPGRADE_STARTED,
    UPSTREAM_INVALID,
    WS_CONNECTED,
    WS_DISCONNECTED,
    WS_REJECTED,
    event_catalog,
)

#: The logger every structured record goes through. Named under our own
#: namespace so `litearm.obs` can be configured, filtered and (in tests)
#: inspected without touching uvicorn's loggers or the root logger.
LOGGER_NAME = "litearm.obs"

#: A record shorter than this is never worth a line: timestamps, source and
#: identifiers alone. Used to keep the file honest when `fields` is empty.
_BODY_MAX_CHARS = 2000

_logger = logging.getLogger(LOGGER_NAME)

#: Trace context. `trace_id` identifies one browser connection, `span_id` one
#: command within it — the same split as W3C Trace Context, so the values are
#: usable by an OpenTelemetry collector without renaming anything.
_trace_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "litearm_trace_id", default=None)
_span_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "litearm_span_id", default=None)

#: Where every emitted record is also offered, besides the file. The transport
#: layer (`server.Daemon`) registers a sink that turns records into `log` frames.
#:
#: ⚠ A **sink**, not a `logging.Handler`, on purpose: the websocket fan-out must
#: not be able to make the file write fail, and a sink that raises is contained
#: in one place (`_notify_sink`). There is at most one.
_sink: Optional["Sink"] = None

#: A sink is a plain callable; `server.Daemon` passes a bound method.
Sink = Callable[[Dict[str, Any]], None]

#: Process-wide constants, resolved once.
_service: str = SERVICE_NAME
_version: str = ""
_hostname: str = ""
_pid: int = 0
_configured = False
_lock = threading.Lock()

#: 每条记录的写入序号 (见 `schema.RECORD_KEYS` 里 `_seq` 的说明)。进程内单调递增,
#: **跨进程重启会重新计数** —— 它只用来给同一纳秒里的记录定序, 不做跨进程比较。
_record_seq = 0
_seq_lock = threading.Lock()


def _resolve_hostname() -> str:
    """The machine's name, best-effort. A log line never fails over a hostname."""
    try:
        return socket.gethostname() or "unknown"
    except Exception:  # noqa: BLE001 - never let logging break the caller
        return "unknown"


def configure(*, log_dir: Optional[Path] = None, version: str = "",
              level: str = "INFO", max_bytes: int = DEFAULT_MAX_BYTES,
              backups: int = DEFAULT_BACKUPS, stderr: bool = False,
              console_level: Optional[str] = None) -> Optional[JsonlFileHandler]:
    """Attach the JSONL file handler (and optionally a stderr one) and return it.

    Called once from the daemon's entry point. Safe to call again in tests: the
    previous handler is removed first, so a test can point the daemon at a
    temporary directory and assert on the file without leaking a handler into
    the next test.

    ``level`` is the **file** threshold and defaults to INFO: DEBUG is for
    diagnosing the daemon itself, and a file that fills with per-frame detail is
    not the artifact an operator can attach to a bug report. ``console_level``
    sets the human-readable stderr stream independently (`--verbose`), so a
    terminal can be noisy without making the file noisy.

    Returns the file handler so the caller (or a test) can flush or close it, or
    ``None`` when the file could not be opened and output went to stderr instead.
    """
    global _service, _version, _hostname, _pid, _configured
    import sys

    directory = Path(log_dir) if log_dir is not None else default_log_dir()
    directory = directory.expanduser()
    path = directory / handlers.LOG_FILE_NAME

    with _lock:
        for handler in list(_logger.handlers):
            _logger.removeHandler(handler)
            try:
                handler.close()
            except Exception:  # noqa: BLE001 - closing is best-effort
                pass
        _logger.propagate = False
        _service = SERVICE_NAME
        _version = version or ""
        _hostname = _resolve_hostname()
        _pid = _current_pid()
        # ⚠ 打不开日志文件**不是**启动失败的理由。真实场景: 状态目录只读 (容器里以
        # 只读 home 运行、磁盘满、权限被改过)。这时降级成"只有 stderr", 并在 stderr
        # 上说清为什么 —— 一个因为写不了日志而起不来的守护进程, 比没有日志更糟。
        try:
            file_handler = build_file_handler(path, max_bytes=max_bytes, backups=backups)
        except OSError as e:
            file_handler = None
            print(f"[litearm-studio-daemon] 无法写入日志文件 {path}: {e}；"
                  f"本次只输出到 stderr", file=sys.stderr)
        if file_handler is not None:
            _logger.addHandler(file_handler)
        if stderr or file_handler is None:
            stream = build_stream_handler()
            stream.setLevel(_logging_level(console_level or level))
            _logger.addHandler(stream)
        # The logger's own threshold is the file's: everything below it is
        # dropped before a record object is even built.
        _logger.setLevel(_logging_level(level))
        _configured = True
        handlers._ACTIVE_DIR = directory if file_handler is not None else None
    return file_handler


def _current_pid() -> int:
    import os

    return os.getpid()


def _logging_level(name: str) -> int:
    """Schema level name (or a stdlib name) → a stdlib level number."""
    return schema.SEVERITY_TO_LOGGING_LEVEL.get(schema.normalize_severity(name, default="INFO"), logging.INFO)


def is_configured() -> bool:
    """Has :func:`configure` run? Tests use it to assert wiring, not behaviour."""
    return _configured


def log_path() -> Optional[Path]:
    """The file currently being written, or ``None`` before :func:`configure`."""
    directory = handlers.read_log_dir()
    return None if directory is None else directory / handlers.LOG_FILE_NAME


@contextmanager
def trace(trace_id: Optional[str]) -> Iterator[None]:
    """Bind a trace id for the duration of the block (one browser connection)."""
    token = _trace_id.set(trace_id or None)
    try:
        yield
    finally:
        _trace_id.reset(token)


@contextmanager
def span(span_id: Optional[str]) -> Iterator[None]:
    """Bind a span id for the duration of the block (one command)."""
    token = _span_id.set(span_id or None)
    try:
        yield
    finally:
        _span_id.reset(token)


def current_trace() -> Optional[str]:
    return _trace_id.get()


def current_span() -> Optional[str]:
    return _span_id.get()


def new_span_id() -> str:
    """A fresh 16-hex-digit span id (W3C Trace Context's width)."""
    import secrets

    return secrets.token_hex(8)


def new_trace_id() -> str:
    """A fresh 32-hex-digit trace id (W3C Trace Context's width)."""
    import secrets

    return secrets.token_hex(16)


def build_record(event: str, *, body: str = "", fields: Optional[Mapping[str, Any]] = None,
                 severity: Optional[str] = None, exception: Optional[BaseException] = None,
                 trace_id: Optional[str] = None, span_id: Optional[str] = None,
                 observed_ts_ns: Optional[int] = None) -> Dict[str, Any]:
    """Build a schema-shaped record without writing it.

    Exposed because the WebSocket layer needs the same record the file gets, and
    tests need to assert the shape without parsing a file. It is pure: no clock
    is read unless one is asked for, no handler is touched.
    """
    global _record_seq
    severity = schema.normalize_severity(
        severity if severity is not None else EVENT_SEVERITIES.get(event, "INFO"))
    now = observed_ts_ns if observed_ts_ns is not None else time_ns()
    with _seq_lock:
        _record_seq += 1
        seq = _record_seq
    safe_fields = redact.sanitize(dict(fields or {}))
    if exception is not None:
        safe_fields["exception"] = redact.sanitize(handlers.resolve_exception(exception))
    text = body if body else event
    if len(text) > _BODY_MAX_CHARS:
        text = f"{text[:_BODY_MAX_CHARS]}…"
    record: Dict[str, Any] = {
        "ts": _iso_utc(now),
        "ts_ns": now,
        "_seq": seq,
        "observed_ts_ns": now,
        "severity": severity,
        "severity_number": schema.severity_number(severity),
        "event": event,
        "body": text,
        "trace_id": trace_id if trace_id is not None else _trace_id.get(),
        "span_id": span_id if span_id is not None else _span_id.get(),
        "service": _service,
        "version": _version,
        "host": _hostname,
        "pid": _pid,
        "thread": threading.current_thread().name,
        "source": _source_of_caller(),
        "fields": safe_fields,
    }
    if event in EVENT_KINDS:
        record["kind"] = EVENT_KINDS[event]
    return record


def _source_of_caller() -> str:
    """The module that emitted the event (`litearm_studio_daemon.session`).

    Taken from the call stack rather than passed in: an emitter that has to name
    its own module will eventually name it wrongly, and `source` is exactly the
    field that tells a reader where to look.
    """
    try:
        frame = _first_caller_outside_obs()
        module = frame.f_globals.get("__name__")
        return str(module) if module else LOGGER_NAME
    except Exception:  # noqa: BLE001
        return LOGGER_NAME


def _first_caller_outside_obs():
    import inspect

    frame = inspect.currentframe()
    # walk out of this module's own frames
    while frame is not None:
        module = frame.f_globals.get("__name__", "")
        if not str(module).startswith(__name__.rsplit(".", 1)[0] + ".obs"):
            return frame
        frame = frame.f_back
    raise RuntimeError("no caller frame")


def _iso_utc(ns: int) -> str:
    """RFC 3339 in UTC with microsecond precision — the form log tools parse.

    Python's `datetime.isoformat` alone produces `+00:00`; the `Z` form is what
    RFC 3339 itself uses for UTC and what every parser accepts, so it is spelled
    out here rather than left to chance.
    """
    from datetime import datetime, timezone

    dt = datetime.fromtimestamp(ns / 1e9, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def emit(event: str, *, body: str = "", fields: Optional[Mapping[str, Any]] = None,
         level: Optional[str] = None, severity: Optional[str] = None,
         exception: Optional[BaseException] = None,
         trace_id: Optional[str] = None, span_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Write one structured record. Returns it, or ``None`` if filtered out.

    ``level`` is the Python-facing name (`WARNING`, `ERROR`) and is the preferred
    argument; ``severity`` is the schema name and exists for the rare call site
    that wants to be explicit. Both are accepted because the daemon's existing
    call sites think in Python levels.

    Never raises. A logging call that can fail the operation it is describing is
    worse than no logging call at all, and this one runs on the state-poll
    thread, the command executor and the DFU thread.
    """
    try:
        wanted = severity if severity is not None else (
            schema.normalize_severity(level) if level is not None
            else EVENT_SEVERITIES.get(event, "INFO"))
        record = build_record(event, body=body, fields=fields, severity=wanted,
                             exception=exception, trace_id=trace_id, span_id=span_id)
        numeric = schema.severity_number(wanted)
        if numeric < schema.severity_number(schema.LOGGING_LEVEL_TO_SEVERITY.get(
                _logger.getEffectiveLevel(), "INFO")):
            return None
        # `logging` needs a message and, for `exc_info`, a tuple. Both are taken
        # from the record so the stdlib handler has something to fall back on.
        exc_info = None
        if exception is not None:
            exc_info = (type(exception), exception, exception.__traceback__)
        _logger.log(schema.SEVERITY_TO_LOGGING_LEVEL.get(wanted, logging.INFO),
                    record["body"], extra={"obs_record": record}, exc_info=exc_info)
        _notify_sink(record)
        return record
    except Exception:  # noqa: BLE001 - see docstring
        return None


def debug(event: str, **kwargs: Any) -> Optional[Dict[str, Any]]:
    kwargs.setdefault("level", "DEBUG")
    return emit(event, **kwargs)


def info(event: str, **kwargs: Any) -> Optional[Dict[str, Any]]:
    kwargs.setdefault("level", "INFO")
    return emit(event, **kwargs)


def warning(event: str, **kwargs: Any) -> Optional[Dict[str, Any]]:
    kwargs.setdefault("level", "WARNING")
    return emit(event, **kwargs)


def error(event: str, **kwargs: Any) -> Optional[Dict[str, Any]]:
    kwargs.setdefault("level", "ERROR")
    return emit(event, **kwargs)


def critical(event: str, **kwargs: Any) -> Optional[Dict[str, Any]]:
    kwargs.setdefault("level", "FATAL")
    return emit(event, **kwargs)


def log(level: Any, event: str, **kwargs: Any) -> Optional[Dict[str, Any]]:
    """Emit with a stdlib level number or name — the bridge for old call sites."""
    kwargs.setdefault("level", schema.normalize_severity(level))
    return emit(event, **kwargs)


def redact_command_arguments(method: str, params: Mapping[str, Any]) -> Dict[str, Any]:
    """Safe `fields["args"]` for one command (see `redact.command_arguments`)."""
    return redact.command_arguments(method, params)


def describe_value(value: Any) -> Any:
    """A short, JSON-safe description of a command's result.

    The command log wants to say *what came back*, not to embed it. A trajectory
    list, a joint-parameter array and an SDK envelope all get summarised by size
    and shape; small scalars pass through unchanged because those are the answers
    an operator actually reads (`set_speed` returning 40, `get_tcp` returning a
    6-vector).

    Without this, `fields` for a `get_joint_params` call would be 7 objects deep
    and the line would stop being readable in a terminal — which is the whole
    reason the file is JSONL and not a dump.
    """
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return redact.sanitize(value)
    if isinstance(value, Mapping):
        return {"kind": "object", "keys": sorted(str(k) for k in value)[:16]}
    if isinstance(value, (list, tuple)):
        scalars = [item for item in value
                   if item is None or isinstance(item, (bool, int, float))]
        summary: Dict[str, Any] = {"kind": "list", "length": len(value)}
        if len(scalars) == len(value) and len(value) <= 8:
            # A short all-scalar list is an answer (a pose, a vector of gains).
            summary["values"] = redact.sanitize(list(value))
        return summary
    return {"kind": type(value).__name__}


def set_sink(sink: Optional[Sink]) -> None:
    """Register (or clear) the one extra destination for emitted records.

    `create_app` calls this once; tests call it with `None`. A sink must be fast
    and must not raise — `_notify_sink` swallows anything it throws, because a
    dead websocket fan-out must never fail the operation being logged.
    """
    global _sink
    _sink = sink


def sink() -> Optional[Sink]:
    """The registered sink, if any. For tests and for the transport layer."""
    return _sink


def _notify_sink(record: Dict[str, Any]) -> None:
    sink_fn = _sink
    if sink_fn is None:
        return
    try:
        sink_fn(record)
    except Exception:  # noqa: BLE001 - a broken sink is not the caller's problem
        pass


def flush() -> None:
    """Flush every handler. Used by tests and by the daemon's shutdown path."""
    for handler in list(_logger.handlers):
        try:
            handler.flush()
        except Exception:  # noqa: BLE001
            pass


def shutdown() -> None:
    """Remove and close handlers. Safe to call more than once.

    Also clears the directory the HTTP layer reads, so a test that shuts the
    logger down really is back to "not configured" instead of pointing the next
    caller at a directory that no longer describes this process.
    """
    global _configured
    with _lock:
        for handler in list(_logger.handlers):
            _logger.removeHandler(handler)
            try:
                handler.close()
            except Exception:  # noqa: BLE001
                pass
        handlers._ACTIVE_DIR = None
        _configured = False


def handlers_attached() -> List[logging.Handler]:
    """The handlers currently attached — for tests, not for production logic."""
    return list(_logger.handlers)


def entrypoint_name() -> str:
    """The value `service` gets when the entry point has not configured yet."""
    return _service


def machine_name() -> str:
    return _hostname


def process_id() -> int:
    return _pid


# `handlers` is imported at the bottom so the module can reference it inside
# `configure` while `handlers` itself imports only `schema`.
from . import handlers  # noqa: E402  (see note above)
