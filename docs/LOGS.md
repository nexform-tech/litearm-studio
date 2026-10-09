# Logs

This document is for anyone who has to answer "what happened?" after a LiteArm
Studio session — an operator reporting a fault, a developer reading a bug report,
or anyone wiring the daemon's logs into a log platform. It describes the record
shape, where the records live, and how to read them.

## 1. What a record is

One JSON object per line (**JSON Lines**, <https://jsonlines.org>). The same
object is written to the daemon's file, broadcast on the WebSocket as a `log`
frame, and stored by the page, so the three views cannot disagree about field
names.

Field names follow **OpenTelemetry's log data model**. That is the point: the
line drops into Loki, an Elastic pipeline, Fluent Bit or an OTel Collector
without a translation layer, and someone who knows OTLP already knows the record.

```json
{
  "ts": "2026-05-07T13:53:02.123456Z",
  "ts_ns": 1778152382123456000,
  "_seq": 412,
  "observed_ts_ns": 1778152382123456000,
  "severity": "ERROR",
  "severity_number": 17,
  "event": "arm.command.failed",
  "body": "命令 movej 失败: MotionBusyError: 机械臂正在运动",
  "trace_id": "b7c1f0e2a4d94e51b7c1f0e2a4d94e51",
  "span_id": "9f3a21c4d8e74b02",
  "service": "litearm-studio-daemon",
  "version": "1.4.2",
  "host": "bench-01",
  "pid": 41233,
  "thread": "litearm-cmd",
  "source": "litearm_studio_daemon.session",
  "kind": "command",
  "fields": { "method": "movej", "outcome": "error", "duration_ms": 12.4 }
}
```

| Field | Meaning |
| --- | --- |
| `ts` | RFC 3339, UTC, microseconds. The form every log platform parses. |
| `ts_ns` | OTLP `time_unix_nano`. Exact, and what pagination orders on. |
| `_seq` | Monotonic write counter, per daemon run. Breaks ties inside one nanosecond. |
| `observed_ts_ns` | OTLP `observed_time_unix_nano` — when the daemon saw it. |
| `severity` | One of `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`. |
| `severity_number` | OTLP's number for that bucket: 1, 5, 9, 13, 17, 21. |
| `event` | The stable, machine-readable name. **Filter on this**, not on the text. |
| `body` | The human sentence. Diagnostic detail, not a stable API. |
| `trace_id` | One browser connection (32 hex digits, W3C width). |
| `span_id` | One command within it (16 hex digits). |
| `kind` | `session`, `command`, `gripper`, `firmware`, `system`, or `sample`. |
| `fields` | The whitelisted detail bag: `method`, `outcome`, `args`, `exception`, … |

`body` is deliberately not translated: the page translates `event` and shows
`body` as the daemon's own diagnostic text. A log reader needs the original
words, and a test that asserts on a translated string breaks the moment the
translation improves.

## 2. Where the records live

The daemon owns the history. It writes to a rotating JSONL file in the
platform's state directory:

| Platform | File |
| --- | --- |
| Linux | `$XDG_STATE_HOME/litearm-studio/daemon.jsonl` (default `~/.local/state/litearm-studio/`) |
| macOS | `~/Library/Logs/litearm-studio/daemon.jsonl` |
| Windows | `%LOCALAPPDATA%\litearm-studio\Logs\daemon.jsonl` |

`--log-dir DIR` or `LITEARM_STUDIO_LOG_DIR` overrides it. Rotation is by size
(`--log-max-bytes`, default 5 MB; `--log-backups`, default 5), so the total stays
bounded at roughly 25 MB.

The page keeps its own copy in IndexedDB as a cache — for the first paint and for
offline reading. **That cache is not the history.** It is scoped to the page's
origin, and the daemon's port can change between launches, which moves the origin
and the store with it (issue #80). The file does not care which port was free
that morning, which is why `/api/logs` reads the file rather than the cache.

### Exporting what the page is showing

**Logs → Export JSONL** writes the records the page currently shows (the filters
apply) in the same JSONL shape as the file above — one wire object per line, so
the export drops into `jq`, Loki, or back into LiteArm Studio.

Where it goes is the operator's choice. The page hands the bytes to the daemon
(`POST /api/export`); the daemon opens the native save dialog with
`litearm-logs-<timestamp>.jsonl` offered as the name and the platform's Downloads
directory as the starting point; then it writes the file itself and answers with
the path, which the page shows. Cancelling writes nothing and says nothing.

⚠ The page cannot do this alone. It runs inside the window host (pywebview), where
`<a download>` neither picks a location nor reports an outcome — the platform
backend decides: GTK writes silently into the Downloads directory, and WebView2
cancels the download outright (issue #104). The same bridge carries the Telemetry
page's **Export CSV**.

Without a window (`--no-open`) the daemon answers `no-window` and the page falls
back to an ordinary browser download, which is what the bench and server cases
want.

## 3. Reading it

```bash
# what just happened
tail -n 20 ~/.local/state/litearm-studio/daemon.jsonl | jq -c '{ts,severity,event,body}'

# every failed command, with its method and error class
jq -c 'select(.event=="arm.command.failed")
       | {ts, method:.fields.method, error:.fields.exception.type}' \
  ~/.local/state/litearm-studio/daemon.jsonl

# one browser session, start to finish (the page's trace id is in every record)
jq -c 'select(.trace_id=="b7c1f0e2a4d94e51b7c1f0e2a4d94e51") | {ts,event,body}' \
  ~/.local/state/litearm-studio/daemon.jsonl

# feed a collector
litearm-studio-daemon --log-stdout | fluent-bit -i stdin -p parser=json
```

Over HTTP, while the daemon is running:

```bash
curl -s 'localhost:8765/api/logs?limit=20' | jq '.records[] | {ts,severity,event}'
curl -s 'localhost:8765/api/logs?level=ERROR&limit=20'
curl -s 'localhost:8765/api/logs?q=movej'          # event, message or command method
curl -s 'localhost:8765/api/logs?kind=session'
curl -s 'localhost:8765/api/logs/events' | jq '.observed'   # what has happened here
```

`/api/logs` pages backwards with an opaque `cursor` from the previous response;
pass it as `before=` to get the records before that page. `cursor: null` means
you have reached the oldest record.

⚠ The cursor is the record's `(ts_ns, _seq)`, not a file position. A record can
move from `daemon.jsonl` to `daemon.jsonl.1` between two requests, and a position
would then point at different bytes.

## 4. What is never in the file

`daemon/src/litearm_studio_daemon/obs/redact.py` enforces this, so it is not a
matter of remembering:

- the activation request's contact form (name, phone, email, region) and the
  device UID — the record keeps only the *names* of the submitted fields;
- the licence blob returned by the activation service;
- firmware image bytes (the record keeps the size and the file name);
- any field named `token`, `password`, `secret`, `signature`, …

⚠ Do not build a record by hand. `obs.emit` is the only path that runs
redaction, so a value that bypasses it is unvetted. The tests
(`daemon/tests/test_session_logging.py`) assert on the *file text* — a leaked UID
fails the suite, which is stronger than "we remembered to redact".

## 5. Emitting a new event

1. Add `(name, kind, default_severity, summary)` to `schema.EVENTS` and a
   constant beside the others. The catalogue is the single source for the
   page's labels and `GET /api/logs/events`, so a name that is not in it is a
   bug rather than an extension point.
2. Emit it from an existing decision point; do not add a parallel check whose
   only job is to log.
3. Put machine-readable detail in `fields` (snake_case, values already
   computed: `outcome`, `duration_ms`) and a sentence in `body`.
4. If the record's parameters are sensitive, add the command to
   `redact.command_arguments` rather than filtering at the call site.

## 6. Volume

A log that records every state frame is a packet capture, not a log. Two rules
keep the file useful:

- state polling is recorded at **1 Hz** (`session.SAMPLE_RECORD_INTERVAL_S`),
  not at the 50 Hz poll rate, and as `kind: "sample"` records;
- a successful read-only command (`get_tcp`, `get_joint_params`, …) is `DEBUG`;
  only commands that change the machine, and every failure, are `INFO` or worse.

The default level is `INFO`, so the file holds the operator's timeline. Use
`--log-level DEBUG` when diagnosing; the page's level filter does the same over
what it has received.
