"""Where a structured record goes: a rotating JSONL file, and optionally stderr.

Who reads this: anyone changing the daemon's log destination, rotation or
startup flags.

The file is the **authoritative history**. The page can lose its IndexedDB
store when the daemon's port moves and the page's origin with it (issue #80);
a file in the daemon's state directory does not care which port was free that
morning. So the file is written first and always, and everything the browser
shows is either broadcast live or read back from these files.

Format: one JSON object per line, UTF-8, no pretty-printing — **JSON Lines**
(https://jsonlines.org), which is what `jq`, `loki`'s `json` stage, Fluent Bit's
`parser json`, Vector and Filebeat all consume without configuration.

Rotation is the standard library's :class:`~logging.handlers.RotatingFileHandler`
rather than a hand-rolled one. Do not replace it with a custom writer: it already
holds the lock across the rollover and the write, which is the only thing keeping
a concurrent record from landing in the wrong file or splitting a line.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import traceback
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Mapping, Optional

from . import schema

#: Default size cap per file and number of rolled files kept. 5 MB × 5 keeps the
#: last ~25 MB, which is days of ordinary operation and still small enough to
#: email. Rotation is by size, not by day, because the daemon runs for weeks on a
#: bench and a daily file could grow without bound in a busy session.
DEFAULT_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_BACKUPS = 5

#: File name inside the log directory. `.jsonl` is the extension log platforms
#: and editors recognise; there is no `.log` in the name on purpose.
LOG_FILE_NAME = "daemon.jsonl"

#: Environment override for the log directory. XDG on Linux; see
#: :func:`default_log_dir`.
LOG_DIR_ENV = "LITEARM_STUDIO_LOG_DIR"

#: The variable pytest sets while a test is running. Present only under pytest.
_PYTEST_ENV = "PYTEST_CURRENT_TEST"


def log_dir_choice(platform: str, os_name: str) -> tuple:
    """``(base env var, base fallback parts, trailing parts)`` for a platform.

    Split out from :func:`default_log_dir` so the table is testable without
    monkeypatching the *running* platform's ``Path`` flavour — ``pathlib`` binds
    Posix/Windows at import, so a Windows expectation cannot be built on Linux.

    The base and the trailing parts are separate because the env var *replaces*
    the base: with ``XDG_STATE_HOME=/x`` the directory is ``/x/litearm-studio``,
    and on macOS (no env var) it is ``~/Library/Logs/litearm-studio``.
    """
    if platform == "darwin":
        return (None, ("Library", "Logs"), ("litearm-studio",))
    if os_name == "nt":
        return ("LOCALAPPDATA", ("AppData", "Local"), ("litearm-studio", "Logs"))
    return ("XDG_STATE_HOME", (".local", "state"), ("litearm-studio",))


def default_log_dir() -> Path:
    """Where logs live when ``--log-dir`` is not given.

    Follows each platform's own convention, because "where would a user look for
    this program's logs" has a different answer on each:

    * ``$LITEARM_STUDIO_LOG_DIR`` when set — the escape hatch for a container or
      a test, and the only thing that overrides the platform default;
    * Linux/other POSIX: ``$XDG_STATE_HOME/litearm-studio`` or
      ``~/.local/state/litearm-studio``. State, not cache and not data: the file
      is meant to survive, and it is not a document the user manages;
    * macOS: ``~/Library/Logs/litearm-studio``, the directory Console.app and
      every Mac user already looks in;
    * Windows: ``%LOCALAPPDATA%\\litearm-studio\\Logs``, per-user and not
      roaming, so a roaming profile does not carry one machine's logs to another.
    """
    override = os.environ.get(LOG_DIR_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    if os.environ.get(_PYTEST_ENV):
        # ⚠ A test that runs `main()` or `serve()` must not append to the log file
        # of whoever is running the suite, and must not fail because their home
        # directory is read-only. `default_log_dir` is the only place that
        # resolves the path, so the guard belongs here rather than in each test.
        import tempfile

        return Path(tempfile.gettempdir()) / "litearm-studio-tests"
    home = Path.home()
    env_name, fallback, trailing = log_dir_choice(sys.platform, os.name)
    if env_name:
        base = os.environ.get(env_name, "").strip()
        if base:
            return Path(base).expanduser().joinpath(*trailing)
    return home.joinpath(*fallback).joinpath(*trailing)


def read_log_dir() -> Optional[Path]:
    """The directory a *running* daemon was configured with, or ``None``.

    Written by :func:`configure` and read by the HTTP layer so
    ``/api/logs/...`` serves the same file the process is writing, instead of
    re-deriving the path and disagreeing with it when a flag was passed.
    """
    return _ACTIVE_DIR


#: Set by :func:`configure`. Module-private; use :func:`read_log_dir`.
_ACTIVE_DIR: Optional[Path] = None


class ObsJsonlFormatter(logging.Formatter):
    """Renders one log record as a single JSONL line in the schema's shape.

    It reads ``record.obs_record`` (built by :mod:`litearm_studio_daemon.obs`)
    and re-emits it in :data:`schema.RECORD_KEYS` order. Records without that
    attribute — a stray library logger, a test — are rendered from the stdlib
    record itself, so one badly-behaved logger cannot produce a malformed line.

    ⚠ This formatter never raises into the logger. A record that cannot be
    serialised (a field the emitter failed to sanitise) is written as a
    ``daemon.log.serialization_failed`` line naming the original event: losing
    the payload is acceptable, losing the line is not.
    """

    def format(self, record: logging.LogRecord) -> str:  # noqa: A003 - stdlib name
        payload = getattr(record, "obs_record", None)
        if not isinstance(payload, Mapping):
            payload = self._from_stdlib(record)
        ordered: dict = {}
        for key in schema.RECORD_KEYS:
            if key in payload:
                ordered[key] = payload[key]
        for key, value in payload.items():          # anything extra stays visible
            ordered.setdefault(key, value)
        try:
            return json.dumps(ordered, ensure_ascii=False, allow_nan=False,
                              separators=(",", ":"), default=str)
        except (TypeError, ValueError):
            return json.dumps({
                "ts": payload.get("ts") or self.formatTime(record),
                "severity": "ERROR",
                "severity_number": schema.SEVERITY_NUMBERS["ERROR"],
                "event": "daemon.log.serialization_failed",
                "body": f"无法序列化 {payload.get('event')!r} 这条日志记录",
                "service": schema.SERVICE_NAME,
                "source": record.name,
                "fields": {"original_event": str(payload.get("event"))},
            }, ensure_ascii=False)

    def _from_stdlib(self, record: logging.LogRecord) -> dict:
        severity = schema.normalize_severity(record.levelno)
        return {
            "severity": severity,
            "severity_number": schema.severity_number(severity),
            "event": "daemon.log",
            "body": record.getMessage(),
            "source": record.name,
            "thread": record.threadName,
            "fields": {},
        }


class JsonlFileHandler(RotatingFileHandler):
    """Rotating handler that always writes the JSONL shape.

    Kept as a named class so the file's formatter cannot be swapped out by a
    later ``basicConfig`` or by code that configures the root logger: callers get
    the format by construction.
    """

    def __init__(self, path: Path, *, max_bytes: int = DEFAULT_MAX_BYTES,
                 backups: int = DEFAULT_BACKUPS) -> None:
        super().__init__(str(path), maxBytes=int(max_bytes),
                         backupCount=int(backups), encoding="utf-8", delay=False)
        self.setFormatter(ObsJsonlFormatter())


def build_file_handler(path: Path, *, max_bytes: int = DEFAULT_MAX_BYTES,
                       backups: int = DEFAULT_BACKUPS) -> JsonlFileHandler:
    """Create the JSONL handler, making the directory if it does not exist.

    The mode on a newly created directory is the platform default masked by the
    umask, which is what a per-user state directory wants. The log file's own
    contents are already filtered by :mod:`redact`; this is defence in depth, not
    the control.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    return JsonlFileHandler(path, max_bytes=max_bytes, backups=backups)


def build_stream_handler(stream: Any = None) -> logging.StreamHandler:
    """A stderr JSONL handler, for running in the foreground or under a shipper.

    Off by default: the packaged app has no terminal and writes to the file. It
    exists for ``--log-stdout``, which is how the daemon feeds Fluent Bit, a
    container runtime or ``jq`` without touching the file.
    """
    handler = logging.StreamHandler(stream if stream is not None else sys.stderr)
    handler.setFormatter(ObsJsonlFormatter())
    return handler


def resolve_exception(exc: BaseException) -> dict:
    """The ``exception`` field for a failed operation.

    OTLP puts an exception on the record as ``exception.type``,
    ``exception.message`` and ``exception.stacktrace``; keeping those three names
    means a collector's exception handling works on these lines too.
    """
    return {
        "type": type(exc).__name__,
        "message": str(exc),
        "stacktrace": "".join(
            traceback.format_exception(type(exc), exc, exc.__traceback__)
        ).rstrip("\n"),
    }


__all__ = [
    "DEFAULT_BACKUPS",
    "DEFAULT_MAX_BYTES",
    "LOG_DIR_ENV",
    "LOG_FILE_NAME",
    "JsonlFileHandler",
    "ObsJsonlFormatter",
    "build_file_handler",
    "build_stream_handler",
    "default_log_dir",
    "read_log_dir",
    "resolve_exception",
]
