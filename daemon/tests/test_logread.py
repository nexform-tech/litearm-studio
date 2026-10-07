"""Reading the daemon's log history back (issue #79 point 5, issue #80).

`test_obs.py` proves the daemon *writes* good records; this file proves the page can
*read them back* after a reload, a reconnect or a gap. That is the half of the
feature that fixes #80: the browser's own store moves with the page origin, the
file does not, so the page has to be able to walk the file.

The reader has three properties worth pinning, and each one is a real failure mode:

* rotation ordering — `daemon.jsonl.10` must not sort next to `daemon.jsonl.1`;
* cursor stability — a page that fetched 20 records must be able to ask for the 20
  before them without duplicates or gaps, even while the daemon appends;
* a torn line at the end of the live file (the daemon is mid-write) must not hide
  the records before it.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from litearm_studio_daemon import logread
from litearm_studio_daemon.obs import handlers, schema


def write_lines(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


#: 写进每条测试记录的 `_seq`。真实的 daemon 由 `obs` 逐条递增; 测试数据也一样要有,
#: 因为**同一纳秒里的两条记录**正是分页最难的一处 (见 `Cursor` 的说明), 少了它那些
#: 用例就退化成"时间戳恰好都不同"的巧合。
_next_seq = 0


def record(event: str, *, severity: str = "INFO", kind: str = "command",
           body: str = "", method: str | None = None, ts_ns: int = 1_000_000,
           seq: int | None = None) -> dict:
    global _next_seq
    _next_seq += 1
    fields = {"method": method} if method else {}
    return {
        "ts": "2026-05-07T13:53:02.123456Z", "ts_ns": ts_ns,
        "_seq": _next_seq if seq is None else seq,
        "observed_ts_ns": ts_ns, "severity": severity,
        "severity_number": schema.severity_number(severity),
        "event": event, "body": body or event, "kind": kind,
        "trace_id": None, "span_id": None, "service": schema.SERVICE_NAME,
        "version": "t", "host": "h", "pid": 1, "thread": "t",
        "source": "litearm_studio_daemon.session", "fields": fields,
    }


@pytest.fixture
def log_dir(tmp_path: Path) -> Path:
    return tmp_path


def test_reads_the_newest_records_first(log_dir: Path) -> None:
    write_lines(log_dir / handlers.LOG_FILE_NAME,
                [record("a", ts_ns=1_000_000), record("b", ts_ns=2_000_000),
                 record("c", ts_ns=3_000_000)])
    reader = logread.LogReader(log_dir)
    page = reader.history(limit=10)
    assert [r["event"] for r in page["records"]] == ["c", "b", "a"]
    # 读到了最旧的文件尽头 ⇒ 没有更早的了, 游标也就没有了。
    assert page["more"] is False
    assert page["cursor"] is None


def test_pages_backwards_without_gaps_or_duplicates(log_dir: Path) -> None:
    write_lines(log_dir / handlers.LOG_FILE_NAME,
                [record(f"e{n}", ts_ns=n * 1_000_000) for n in range(1, 26)])
    reader = logread.LogReader(log_dir)
    first = reader.history(limit=10)
    assert [r["event"] for r in first["records"]] == [f"e{n}" for n in range(25, 15, -1)]
    assert first["more"] is True

    second = reader.history(limit=10, before=logread.Cursor.parse(first["cursor"]))
    assert [r["event"] for r in second["records"]] == [f"e{n}" for n in range(15, 5, -1)]

    third = reader.history(limit=10, before=logread.Cursor.parse(second["cursor"]))
    assert [r["event"] for r in third["records"]] == [f"e{n}" for n in range(5, 0, -1)]
    assert third["more"] is False

    seen = [r["event"] for page in (first, second, third) for r in page["records"]]
    assert len(seen) == len(set(seen)) == 25


def test_keeps_paging_into_the_rotated_files(log_dir: Path) -> None:
    """轮转之后历史必须接着读 —— 否则"更早的记录"会在文件切换处凭空消失."""
    # `.2` 最旧、`.1` 次之、无后缀最新 (RotatingFileHandler 的命名).
    write_lines(log_dir / f"{handlers.LOG_FILE_NAME}.2", [record("oldest", ts_ns=1_000_000)])
    write_lines(log_dir / f"{handlers.LOG_FILE_NAME}.1", [record("middle", ts_ns=2_000_000)])
    write_lines(log_dir / handlers.LOG_FILE_NAME, [record("newest", ts_ns=3_000_000)])

    reader = logread.LogReader(log_dir)
    assert [p.name for p in logread.log_files(log_dir)] == [
        f"{handlers.LOG_FILE_NAME}.2", f"{handlers.LOG_FILE_NAME}.1", handlers.LOG_FILE_NAME]

    first = reader.history(limit=2)
    assert [r["event"] for r in first["records"]] == ["newest", "middle"]
    assert first["more"] is True
    second = reader.history(limit=2, before=logread.Cursor.parse(first["cursor"]))
    assert [r["event"] for r in second["records"]] == ["oldest"]


def test_orders_double_digit_rotation_suffixes_numerically(log_dir: Path) -> None:
    """`.10` 比 `.1` 旧 —— 按字符串排序会把它排到 `.1` 旁边, 历史就乱序了."""
    write_lines(log_dir / f"{handlers.LOG_FILE_NAME}.10", [record("oldest", ts_ns=1_000_000)])
    write_lines(log_dir / f"{handlers.LOG_FILE_NAME}.2", [record("newer", ts_ns=2)])
    write_lines(log_dir / handlers.LOG_FILE_NAME, [record("newest", ts_ns=3_000_000)])
    names = [p.name for p in logread.log_files(log_dir)]
    assert names.index(f"{handlers.LOG_FILE_NAME}.10") < names.index(
        f"{handlers.LOG_FILE_NAME}.2")


def test_a_torn_last_line_does_not_hide_the_records_before_it(log_dir: Path) -> None:
    """daemon 正在写的那一刻读到半行是正常的 —— 它不能让整份历史变成不可读."""
    path = log_dir / handlers.LOG_FILE_NAME
    write_lines(path, [record("good-1", ts_ns=1_000_000), record("good-2", ts_ns=2_000_000)])
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"event": "torn", "body": "没有结尾')      # 半行

    page = logread.LogReader(log_dir).history(limit=10)
    assert [r["event"] for r in page["records"]] == ["good-2", "good-1"]


def test_records_appended_after_the_read_are_not_returned_twice(log_dir: Path) -> None:
    """读取期间 daemon 又追加了一条: 游标必须仍然指向"更早", 而不是把新记录再给一遍."""
    path = log_dir / handlers.LOG_FILE_NAME
    write_lines(path, [record(f"e{n}", ts_ns=n * 1_000_000) for n in range(1, 11)])
    reader = logread.LogReader(log_dir)
    first = reader.history(limit=5)
    write_lines(path, [record("brand-new", ts_ns=99_000_000)])
    second = reader.history(limit=5, before=logread.Cursor.parse(first["cursor"]))
    assert "brand-new" not in [r["event"] for r in second["records"]]
    assert [r["event"] for r in second["records"]] == [f"e{n}" for n in range(5, 0, -1)]


def test_filters_narrow_the_walk(log_dir: Path) -> None:
    write_lines(log_dir / handlers.LOG_FILE_NAME, [
        record("arm.command.failed", severity="ERROR", method="movej"),
        record("arm.command.succeeded", severity="INFO", method="enable"),
        record("session.link.lost", severity="WARN", kind="session"),
    ])
    reader = logread.LogReader(log_dir)

    only_errors = reader.history(limit=10, keep=logread.severity_filter("ERROR"))
    assert [r["event"] for r in only_errors["records"]] == ["arm.command.failed"]

    only_session = reader.history(limit=10, keep=logread.kind_filter("session"))
    assert [r["event"] for r in only_session["records"]] == ["session.link.lost"]

    only_event = reader.history(limit=10, keep=logread.event_filter("session.link.lost"))
    assert len(only_event["records"]) == 1

    # 文本搜索要能找到**方法名** —— "哪条命令失败了"是最高频的问题。
    by_method = reader.history(limit=10, keep=logread.query_filter("movej"))
    assert [r["event"] for r in by_method["records"]] == ["arm.command.failed"]

    combined = reader.history(limit=10, keep=logread.combine(
        logread.severity_filter("WARN"), logread.kind_filter("command")))
    assert [r["event"] for r in combined["records"]] == ["arm.command.failed"]


def test_warn_level_also_returns_errors(log_dir: Path) -> None:
    """级别过滤是"至少这么严重", 不是"正好等于" —— 否则筛 WARN 会把 ERROR 藏起来."""
    write_lines(log_dir / handlers.LOG_FILE_NAME, [
        record("debug-ish", severity="DEBUG"),
        record("warn-ish", severity="WARN"),
        record("error-ish", severity="ERROR"),
    ])
    page = logread.LogReader(log_dir).history(limit=10, keep=logread.severity_filter("WARN"))
    assert [r["event"] for r in page["records"]] == ["error-ish", "warn-ish"]


def test_a_sparse_filter_still_advances_the_cursor(log_dir: Path) -> None:
    """过滤条件很挑时, 一页可能一条都不匹配 —— 游标必须照样往前走。

    ⚠ 这是翻页最容易踩的一处: 若游标只跟着"返回的条数"走, 稀疏条件下这一页返回 0 条、
    游标原地不动, 页面就会永远卡在同一段, "加载更早"变成无限循环。
    """
    # 60 条 INFO, 唯一那条 ERROR **插在中间** (第 31 条) —— 上面与下面都有 INFO。
    # ⚠ 必须真的插在中间: 追加到末尾的话它就成了最新那条, 第一页自然命中, 这条用例
    # 也就测不到"稀疏"了。
    rows = [record("arm.command.succeeded", severity="INFO", ts_ns=n * 1_000_000) for n in range(1, 61)]
    rows.insert(30, record("needle.found", severity="ERROR", ts_ns=30_500_000))
    write_lines(log_dir / handlers.LOG_FILE_NAME, rows)

    reader = logread.LogReader(log_dir)
    # 第一页候选只有 5 条 (最上面的 INFO) ⇒ 一条都不匹配。**关键是游标照样前进**:
    # 若它只跟着匹配数走, 这一页返回 0 条、游标原地不动, 翻页就永远卡在同一段。
    first = reader.history(limit=5, keep=logread.severity_filter("ERROR"))
    assert first["records"] == [], "前 5 条都是 INFO, 不该匹配"
    assert first["cursor"] is not None, "没有匹配也必须把游标交回去"
    assert first["more"] is True

    seen: list[str] = []
    page = first
    cursor = logread.Cursor.parse(first["cursor"])
    for _ in range(100):
        page = reader.history(limit=5, keep=logread.severity_filter("ERROR"),
                              before=cursor)
        seen.extend(r["event"] for r in page["records"])
        if not page["more"] or page["cursor"] is None:
            break
        cursor = logread.Cursor.parse(page["cursor"])
    assert seen == ["needle.found"], seen

    # 反过来的稀疏情形: 最新那条就匹配 ⇒ 第一页直接返回它, 且**不该**把后面的
    # INFO 当成"还有更多匹配"继续翻。
    rows.append(record("second-needle.found", severity="ERROR", ts_ns=99_000_000))
    write_lines(log_dir / handlers.LOG_FILE_NAME, rows[-1:])
    page = reader.history(limit=5, keep=logread.severity_filter("ERROR"))
    assert [r["event"] for r in page["records"]] == ["second-needle.found"]


def test_two_records_in_the_same_nanosecond_are_both_returned(log_dir: Path) -> None:
    """同一纳秒里的两条记录必须都能取到 —— 游标的第二段 (指纹) 就是为它存在的.

    ⚠ 只用 `ts_ns` 当游标时这两种错必居其一: 要么把边界那条重复返回 (翻页永远停不
    下来), 要么把另一条跳过 (历史里出现一个谁都解释不了的洞)。真实运行里同一纳秒
    写两条是可能的 (一次命令同时落"成功"与"状态"两条), 所以这条判据不能靠"现实里不
    会撞"来绕过。
    """
    # ⚠ 顺序与 daemon 写文件的方式一致: **更早的在前**。`_seq` 与 `ts_ns` 在生产里同向
    # 递增 (写记录时才取时间戳), 而这条用例要造的正是"时间戳相同"这个唯一含糊的情形,
    # 不能顺手把时间戳也倒过来 —— 那测的就不是分页而是"文件本身乱序"了。
    same_ns = 1_778_152_382_123_456_000
    write_lines(log_dir / handlers.LOG_FILE_NAME, [
        record("older", body="更早的一条", ts_ns=same_ns - 1_000_000),
        record("arm.command.succeeded", body="第一件", ts_ns=same_ns),
        record("session.link.lost", severity="WARN", body="第二件", ts_ns=same_ns),
    ])
    reader = logread.LogReader(log_dir)

    seen: list[str] = []
    cursor = None
    for _ in range(10):
        page = reader.history(limit=1, before=cursor)
        seen.extend(r["event"] for r in page["records"])
        if not page["more"] or page["cursor"] is None:
            break
        cursor = logread.Cursor.parse(page["cursor"])
    # 三条各出现一次: 不重复、不遗漏。
    assert sorted(seen) == ["arm.command.succeeded", "older", "session.link.lost"]


def test_missing_directory_is_an_empty_history_not_an_error(tmp_path: Path) -> None:
    """日志目录还不存在 (刚装上、或 --log-dir 指向别处) 是正常状态, 不是故障."""
    reader = logread.LogReader(tmp_path / "nope")
    assert reader.available() is False
    page = reader.history()
    assert page == {"records": [], "cursor": None, "more": False, "fileCount": 0}


def test_cursor_encoding_is_opaque_and_forgiving() -> None:
    cursor = logread.Cursor(1_778_152_382_123_456_000, 4211)
    assert logread.Cursor.parse(cursor.encode()) == cursor
    assert logread.Cursor.parse("") is None
    assert logread.Cursor.parse(None) is None
    assert logread.Cursor.parse("not-a-number") is None
    assert logread.Cursor.parse("42-not-a-number") is None
    # 只有 ts 没有 tie 也要认 —— 手写游标或旧版本的游标会是这样。
    assert logread.Cursor.parse("42") == logread.Cursor(42, 0)


def test_event_catalog_reports_what_has_actually_happened(log_dir: Path) -> None:
    """页面用这份目录做标签与筛选; observed 让它能说"这台机器上从来没发生过"."""
    write_lines(log_dir / handlers.LOG_FILE_NAME, [
        record("arm.command.failed", severity="ERROR"),
        record("arm.command.failed", severity="ERROR"),
        record("session.link.lost", severity="WARN", kind="session"),
    ])
    catalog = logread.LogReader(log_dir).events()
    assert catalog["observed"]["arm.command.failed"] == 2
    assert catalog["observed"]["session.link.lost"] == 1
    assert any(row["event"] == "arm.command.failed" for row in catalog["events"])
    # 目录本身来自 schema, 与 daemon 的发射端同源。
    assert catalog["severities"] == list(schema.SEVERITY_NAMES)
    assert catalog["observed"].get("never.happened") is None


def test_endpoints_serve_the_file_over_http(log_dir: Path, monkeypatch) -> None:
    """端到端的一条: 页面拿到的就是文件里那几行, 逐字相同 (不重新编排)."""
    from fastapi.testclient import TestClient

    from litearm_studio_daemon import obs
    from litearm_studio_daemon.server import create_app
    from litearm_studio_daemon.session import Session

    obs.configure(log_dir=log_dir, version="9.9.9-test", level="DEBUG")
    session = Session(fake=True)
    app = create_app(session, version="9.9.9-test", repo_dist=Path("/nonexistent-ui"))
    try:
        session.connect()
        for _ in range(200):
            if session.connected:
                break
            import time
            time.sleep(0.02)
        session.execute("set_speed", {"percent": 25})
        obs.flush()
        with TestClient(app) as client:
            body = client.get("/api/logs", params={"limit": 10}).json()
            assert body["dir"] == str(log_dir)
            assert body["fileCount"] >= 1
            events = [r["event"] for r in body["records"]]
            assert obs.COMMAND_SUCCEEDED in events
            matched = [r for r in body["records"]
                       if r["event"] == obs.COMMAND_SUCCEEDED]
            assert matched[0]["fields"]["method"] == "set_speed"

            filtered = client.get("/api/logs", params={"level": "ERROR"}).json()
            assert all(r["severity"] in ("ERROR", "FATAL") for r in filtered["records"])

            catalog = client.get("/api/logs/events").json()
            assert catalog["observed"].get(obs.COMMAND_SUCCEEDED, 0) >= 1
    finally:
        session.close()
        obs.flush()
        obs.shutdown()


def test_sample_records_are_written_at_one_hertz(tmp_path: Path) -> None:
    """采样与事件同一套 schema, 且按 1Hz 抽稀 —— 50Hz 的轮询不是日志 (issue #79 第 7 点)."""
    import time

    from litearm_studio_daemon import obs
    from litearm_studio_daemon.session import SAMPLE_RECORD_INTERVAL_S, Session

    obs.configure(log_dir=tmp_path, version="t", level="DEBUG")
    session = Session(fake=True, poll_period=0.02, state_push_interval=0.02)
    try:
        assert session.connect() is True
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline and not session.connected:
            time.sleep(0.02)
        time.sleep(3.5)
        obs.flush()
    finally:
        session.close()
        obs.shutdown()

    rows = [json.loads(line) for line in
            (tmp_path / handlers.LOG_FILE_NAME).read_text(encoding="utf-8").splitlines()
            if line.strip()]
    samples = [row for row in rows if row["event"] == obs.STATE_SAMPLE]
    # 3.5s 的窗口在 1Hz 下是 3–4 条; 50Hz 会是 175 条 —— 判据是**量级**, 不是精确值。
    assert 2 <= len(samples) <= 6, f"采样条数不像 1Hz: {len(samples)}"
    assert all(row["kind"] == "sample" for row in samples)
    assert all(row["severity"] == "DEBUG" for row in samples)
    fields = samples[0]["fields"]
    # 采样是**数值**记录: 页面要拿它画趋势、算最大值。
    for key in ("q", "dq", "tau", "temps", "errs", "state", "enabled"):
        assert key in fields, key
    assert SAMPLE_RECORD_INTERVAL_S == 1.0
