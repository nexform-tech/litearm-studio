"""Unit tests for the structured logging layer (`litearm_studio_daemon.obs`).

What these pin, and why each one matters:

* the **record shape** — field names are a wire contract between the file, the
  WebSocket frame and the page, so they get asserted, not just used;
* **redaction** — the activation payload and firmware image must not reach the
  file, and a forgotten `fields=` entry must fail loudly here rather than
  quietly on a user's disk;
* **level filtering** — DEBUG detail must be droppable without touching a call
  site, which is the whole reason the threshold lives in one place;
* **JSONL validity under concurrency** — a torn line makes the file unreadable
  for every consumer, and the daemon writes from the poll, executor and DFU
  threads at once.
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

import pytest

from litearm_studio_daemon import obs
from litearm_studio_daemon.obs import handlers, redact, schema


@pytest.fixture
def log_dir(tmp_path: Path) -> Path:
    """A configured daemon logger writing into a throwaway directory."""
    obs.configure(log_dir=tmp_path, version="9.9.9-test", level="DEBUG")
    yield tmp_path
    obs.shutdown()


def read_lines(directory: Path) -> list[dict]:
    obs.flush()
    path = directory / handlers.LOG_FILE_NAME
    text = path.read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


# --------------------------------------------------------------------------- schema

def test_severity_normalises_every_spelling() -> None:
    """Python says WARNING, JavaScript says warning, OTLP says WARN — one bucket."""
    assert schema.normalize_severity("warning") == "WARN"
    assert schema.normalize_severity("WARNING") == "WARN"
    assert schema.normalize_severity("warn") == "WARN"
    assert schema.normalize_severity(logging.WARNING) == "WARN"
    assert schema.normalize_severity(logging.ERROR) == "ERROR"
    assert schema.normalize_severity("critical") == "FATAL"
    assert schema.normalize_severity(None) == "INFO"
    assert schema.normalize_severity("nonsense") == "INFO"


def test_severity_numbers_follow_otlp() -> None:
    """OTLP's six buckets have fixed numbers; consumers sort on them."""
    assert schema.severity_number("TRACE") == 1
    assert schema.severity_number("DEBUG") == 5
    assert schema.severity_number("INFO") == 9
    assert schema.severity_number("WARN") == 13
    assert schema.severity_number("ERROR") == 17
    assert schema.severity_number("FATAL") == 21
    assert schema.is_severity_at_least("ERROR", "WARN")
    assert not schema.is_severity_at_least("DEBUG", "INFO")


def test_every_catalog_event_declares_a_known_kind_and_severity() -> None:
    """The catalogue is the page's filter list; a malformed row breaks it."""
    names = [name for name, _, _, _ in schema.EVENTS]
    assert len(names) == len(set(names)), "event names must be unique"
    for name, kind, severity, summary in schema.EVENTS:
        assert kind in schema.KINDS, name
        assert severity in schema.SEVERITY_NAMES, name
        assert summary.strip(), name
        assert "." in name, f"{name} should be namespaced"


def test_catalog_constants_match_the_table() -> None:
    """A constant that is not in the table would emit an event nothing can label."""
    for name in (obs.CONNECT_STARTED, obs.CONNECT_SUCCEEDED, obs.CONNECT_FAILED,
                 obs.COMMAND_SUCCEEDED, obs.COMMAND_FAILED, obs.LINK_LOST,
                 obs.LINK_RECOVERED, obs.UPGRADE_STARTED, obs.GRIPPER_ALERT,
                 obs.WS_REJECTED, obs.LOG_DROPPED, obs.DAEMON_STARTED):
        assert name in schema.EVENT_KINDS
        assert name in schema.EVENT_SEVERITIES


def test_event_catalog_is_json_ready_for_the_page() -> None:
    """`/api/logs/events` serves this: it must survive json.dumps."""
    catalog = schema.event_catalog()
    text = json.dumps(catalog, ensure_ascii=False)
    assert "arm.command.failed" in text
    assert catalog["severities"] == list(schema.SEVERITY_NAMES)
    assert any(row["event"] == schema.COMMAND_FAILED for row in catalog["events"])


def test_notable_commands_are_real_whitelist_entries() -> None:
    """The INFO-level command set must not name a command that does not exist."""
    from litearm_studio_daemon.session import COMMANDS

    assert schema.NOTABLE_COMMANDS <= set(COMMANDS)


# --------------------------------------------------------------------------- redaction

def test_sanitize_redacts_sensitive_keys_at_any_depth() -> None:
    clean = redact.sanitize({
        "port": "/dev/ttyACM0",
        "device": {"uid": "aabbccddeeff001122334455", "n": 7},
        "items": [{"token": "secret-token"}, {"value": 1}],
    })
    assert clean["port"] == "/dev/ttyACM0"
    assert clean["device"]["uid"] == redact.REDACTED
    assert clean["device"]["n"] == 7
    assert clean["items"][0]["token"] == redact.REDACTED
    assert clean["items"][1]["value"] == 1


def test_sanitize_shortens_without_dropping_the_line() -> None:
    long_text = "x" * (redact.MAX_STRING_CHARS + 50)
    assert redact.MAX_STRING_CHARS < len(redact.sanitize(long_text))
    assert "chars" in redact.sanitize(long_text)
    # A non-JSON leaf becomes a string rather than raising: losing the object
    # must not lose the record.
    assert isinstance(redact.sanitize(object()), str)


def test_ordinary_command_parameters_survive_redaction() -> None:
    """`data`/`value` are NOT globally sensitive: redacting them would gut the log."""
    fields = redact.command_arguments("movej", {"q": [0.1, 0.2], "speed": 40})
    assert fields == {"q": [0.1, 0.2], "speed": 40}


def test_firmware_image_bytes_never_reach_the_fields() -> None:
    fields = redact.command_arguments(
        "firmware_inspect", {"name": "fw.hex", "data": "A" * 5000})
    assert "A" * 100 not in json.dumps(fields)
    assert field_note(fields, "data").startswith("<5000 chars")
    assert fields["name"] == "fw.hex"


def test_upgrade_request_keeps_only_the_safety_gate() -> None:
    fields = redact.command_arguments(
        "firmware_upgrade", {"token": "tok-123456", "confirm": True})
    assert fields == {"confirm": True, "token": redact.REDACTED}


def test_activation_request_never_carries_the_registration_form() -> None:
    fields = redact.command_arguments("activate", {
        "uid": "aabbccddeeff001122334455",
        "contact": {"name": "Zhang San", "phone": "13800000000",
                    "email": "z@example.com", "region": "CN"},
        "consent": {"granted": True},
        "diagnostics": {"studio": "1.4.2", "sdk": "2.1.0", "firmware": "1.9.0"},
    })
    blob = json.dumps(fields, ensure_ascii=False)
    for secret in ("aabbccddeeff001122334455", "Zhang San", "13800000000",
                   "z@example.com", "CN"):
        assert secret not in blob, secret
    # ...but it still says what was submitted and that consent was given.
    assert fields["consent"] == {"granted": True}
    assert fields["diagnostics"]["studio"] == "1.4.2"
    assert fields["contact_fields"] == ["email", "name", "phone", "region"]


def test_assert_clean_catches_a_forgotten_redaction() -> None:
    """The tripwire must actually trip; a check that cannot fail is decoration."""
    with pytest.raises(AssertionError):
        redact.assert_clean({"nested": {"uid": "real-value"}})
    with pytest.raises(AssertionError):
        redact.assert_clean({"port": "/dev/ttyACM0"}, forbidden=("/dev/ttyACM0",))
    redact.assert_clean({"nested": {"uid": redact.REDACTED}})


def field_note(fields: dict, key: str) -> str:
    return str(fields[key])


# --------------------------------------------------------------------------- record shape

def test_record_carries_the_full_schema(log_dir: Path) -> None:
    obs.emit(obs.CONNECT_SUCCEEDED, body="已连接: port=/dev/ttyACM0",
             fields={"port": "/dev/ttyACM0", "firmware": "1.9.0", "n": 7})
    line, = read_lines(log_dir)
    for key in schema.RECORD_KEYS:
        assert key in line, key
    assert line["event"] == "session.connect.succeeded"
    assert line["kind"] == "session"
    assert line["severity"] == "INFO"
    assert line["severity_number"] == 9
    assert line["service"] == schema.SERVICE_NAME
    assert line["version"] == "9.9.9-test"
    assert line["fields"]["port"] == "/dev/ttyACM0"
    # RFC 3339 UTC; every log platform parses this form.
    assert line["ts"].endswith("Z")
    assert line["ts_ns"] > 0 and isinstance(line["ts_ns"], int)


def test_source_names_the_emitting_module(log_dir: Path) -> None:
    """`source` is how a reader finds the call site; it must not be `obs`."""
    obs.emit(obs.CONNECT_STARTED)
    line, = read_lines(log_dir)
    assert line["source"].endswith("test_obs")


def test_trace_and_span_context_reach_the_line(log_dir: Path) -> None:
    with obs.trace("b7c1f0e2a4d94e51"):
        with obs.span("9f3a21c4d8e74b02"):
            obs.emit(obs.COMMAND_SUCCEEDED, fields={"method": "enable"})
        obs.emit(obs.COMMAND_SUCCEEDED, fields={"method": "movej"})
    obs.emit(obs.COMMAND_SUCCEEDED, fields={"method": "home"})
    first, second, third = read_lines(log_dir)
    assert first["trace_id"] == "b7c1f0e2a4d94e51"
    assert first["span_id"] == "9f3a21c4d8e74b02"
    assert second["span_id"] is None, "span must not leak past its block"
    assert third["trace_id"] is None, "trace must not leak past its block"


def test_exception_is_recorded_with_otlp_names(log_dir: Path) -> None:
    try:
        raise ValueError("bad joint index")
    except ValueError as exc:
        obs.emit(obs.COMMAND_FAILED, body="命令 set_joint_param 失败",
                 fields={"method": "set_joint_param"}, level="ERROR",
                 exception=exc)
    line, = read_lines(log_dir)
    assert line["severity"] == "ERROR"
    assert line["fields"]["exception"]["type"] == "ValueError"
    assert line["fields"]["exception"]["message"] == "bad joint index"
    assert "ValueError: bad joint index" in line["fields"]["exception"]["stacktrace"]


def test_build_record_is_pure_and_needs_no_configuration() -> None:
    record = obs.build_record(obs.COMMAND_FAILED, body="x", severity="ERROR")
    assert record["severity_number"] == 17
    assert record["fields"] == {}
    assert record["kind"] == "command"


# --------------------------------------------------------------------------- level filter

def test_debug_records_are_droppable_without_touching_call_sites(tmp_path: Path) -> None:
    """The volume control for per-frame detail lives in one place, not at call sites."""
    obs.configure(log_dir=tmp_path, version="t", level="INFO")
    try:
        assert obs.debug(obs.GRIPPER_LOG, body="tick") is None
        assert obs.emit(obs.GRIPPER_LOG, body="tick") is None
        assert obs.info(obs.COMMAND_SUCCEEDED, fields={"method": "enable"}) is not None
    finally:
        obs.shutdown()

    obs.configure(log_dir=tmp_path, version="t", level="DEBUG")
    try:
        assert obs.debug(obs.GRIPPER_LOG, body="tick") is not None
    finally:
        obs.shutdown()


def test_reconfiguring_replaces_handlers_instead_of_stacking_them(tmp_path: Path) -> None:
    """A second configure must not double every line (tests configure repeatedly)."""
    obs.configure(log_dir=tmp_path, version="t", level="INFO")
    obs.configure(log_dir=tmp_path, version="t", level="INFO")
    try:
        assert len(obs.handlers_attached()) == 1
        obs.info(obs.COMMAND_SUCCEEDED, fields={"method": "enable"})
        assert len(read_lines(tmp_path)) == 1
    finally:
        obs.shutdown()


def test_a_stray_stdlib_record_still_renders_as_jsonl(tmp_path: Path) -> None:
    """Nothing in the file may be a non-JSON line, whatever logger produced it."""
    fresh = logging.getLogger("litearm.obs.stray")
    fresh.propagate = False
    handler = handlers.ObsJsonlFormatter()
    record = logging.LogRecord("litearm.obs.stray", logging.INFO, __file__, 1,
                              "plain message", None, None)
    assert json.loads(handler.format(record))["body"] == "plain message"


def test_unserialisable_record_degrades_to_a_named_line() -> None:
    """Losing the payload is acceptable; losing the line is not."""
    formatter = handlers.ObsJsonlFormatter()
    record = logging.LogRecord("litearm.obs", logging.INFO, __file__, 1, "x", None, None)
    record.obs_record = {"event": "arm.command.failed",
                         "body": "x", "fields": {"bad": float("nan")}}
    payload = json.loads(formatter.format(record))
    assert payload["event"] == "daemon.log.serialization_failed"
    assert payload["fields"]["original_event"] == "arm.command.failed"
    assert payload["severity"] == "ERROR"


# --------------------------------------------------------------------------- the file itself

def test_jsonl_lines_stay_whole_under_concurrent_writers(log_dir: Path) -> None:
    """Poll, executor and DFU threads write at once; a torn line breaks every reader."""
    def worker(index: int) -> None:
        for n in range(50):
            obs.emit(obs.GRIPPER_LOG, body=f"worker {index} line {n}",
                     fields={"worker": index, "n": n})

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    lines = read_lines(log_dir)
    assert len(lines) == 400
    assert sorted(line["fields"]["n"] for line in lines if line["fields"]["worker"] == 0) == list(range(50))


def test_rotation_keeps_the_file_bounded(tmp_path: Path) -> None:
    """Retention is by size, so a long bench session cannot fill the disk."""
    obs.configure(log_dir=tmp_path, version="t", level="INFO",
                  max_bytes=4096, backups=2)
    try:
        for n in range(400):
            obs.emit(obs.GRIPPER_LOG, body=f"line {n} " + "y" * 80, level="INFO")
        obs.flush()
    finally:
        obs.shutdown()
    files = sorted(path.name for path in tmp_path.iterdir())
    assert handlers.LOG_FILE_NAME in files
    assert len(files) <= 3, files
    for name in files:
        assert (tmp_path / name).stat().st_size <= 4096 + 1024


def test_default_log_dir_follows_platform_convention(tmp_path: Path,
                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    """One convention per platform; the env var is the only override."""
    # The pytest guard (see `default_log_dir`) is deliberately bypassed here: this
    # test is about the platform table, not about running under the suite.
    monkeypatch.delenv(handlers._PYTEST_ENV, raising=False)
    monkeypatch.setenv(handlers.LOG_DIR_ENV, str(tmp_path / "explicit"))
    assert handlers.default_log_dir() == tmp_path / "explicit"

    monkeypatch.delenv(handlers.LOG_DIR_ENV)
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    # ⚠ Only `sys.platform` is patched. Patching `os.name` to "nt" makes
    # `pathlib` on this (POSIX) interpreter raise as soon as any path is built;
    # the Windows branch is covered through `log_dir_choice` and the
    # LOCALAPPDATA-missing case below instead.
    monkeypatch.setattr(handlers.sys, "platform", "linux")
    assert handlers.default_log_dir() == tmp_path / "state" / "litearm-studio"

    monkeypatch.delenv("XDG_STATE_HOME")
    assert handlers.default_log_dir() == Path.home() / ".local" / "state" / "litearm-studio"


def test_log_dir_table_names_each_platforms_convention() -> None:
    """The per-platform table is the contract; see `log_dir_choice` for why it is split out."""
    assert handlers.log_dir_choice("darwin", "posix") == (
        None, ("Library", "Logs"), ("litearm-studio",))
    assert handlers.log_dir_choice("win32", "nt") == (
        "LOCALAPPDATA", ("AppData", "Local"), ("litearm-studio", "Logs"))
    assert handlers.log_dir_choice("linux", "posix") == (
        "XDG_STATE_HOME", (".local", "state"), ("litearm-studio",))


def test_windows_falls_back_when_localappdata_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """A service account has no LOCALAPPDATA; the fallback still names a directory."""
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    env_name, fallback, trailing = handlers.log_dir_choice("win32", "nt")
    assert env_name == "LOCALAPPDATA"
    assert fallback == ("AppData", "Local")
    assert trailing == ("litearm-studio", "Logs")


def test_pytest_run_never_touches_the_real_log_directory(monkeypatch: pytest.MonkeyPatch) -> None:
    """A test driving `main()` must not append to the log file of whoever ran it."""
    monkeypatch.delenv(handlers.LOG_DIR_ENV, raising=False)
    monkeypatch.setenv(handlers._PYTEST_ENV, "tests/test_obs.py::x")
    chosen = handlers.default_log_dir()
    assert ".local" not in chosen.parts
    assert chosen.name == "litearm-studio-tests"


def test_log_dir_is_discoverable_for_the_http_layer(tmp_path: Path) -> None:
    """`/api/logs` must serve what this process is writing, not a re-derived guess."""
    obs.shutdown()
    assert obs.log_path() is None
    obs.configure(log_dir=tmp_path, version="t")
    try:
        assert obs.log_path() == tmp_path / handlers.LOG_FILE_NAME
        assert handlers.read_log_dir() == tmp_path
    finally:
        obs.shutdown()
