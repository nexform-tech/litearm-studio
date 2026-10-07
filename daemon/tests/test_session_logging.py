"""End-to-end checks that the daemon *writes* the records the design promises.

Why this file exists next to `test_obs.py`: `test_obs.py` proves the logging layer
behaves; this one proves the **call sites** actually reach it, and that the
promises an operator depends on survive the whole path from a fake session to a
JSONL line.

The two promises that matter most here:

* a command leaves a record naming the method, its arguments and the outcome, so
  "what did the daemon ask the SDK, and what came back" is answerable after the
  fact (issue #79);
* **the activation request and the firmware image never reach the file** — the
  activation path carries the operator's registration form and the device UID,
  and the firmware path carries a whole image. That is checked by searching the
  raw file text for the exact values, not by inspecting the fields dict, because
  the leak that matters is the one in the bytes on disk.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from litearm_studio_daemon import obs
from litearm_studio_daemon.obs import handlers
from litearm_studio_daemon.session import Session

#: Values that must never be findable in the log file, whatever the command.
SECRET_UID = "aabbccddeeff001122334455"
SECRET_NAME = "Zhang San"
SECRET_PHONE = "13800000000"
SECRET_EMAIL = "zhangsan@example.com"


def _wait(pred, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def logging_daemon(tmp_path: Path):
    """A connected fake session whose records land in a throwaway directory."""
    obs.configure(log_dir=tmp_path, version="9.9.9-test", level="DEBUG")
    session = Session(fake=True, poll_period=0.02, state_push_interval=0.05)
    assert session.connect(trace="trace-for-test") is True
    assert _wait(lambda: session.connected)
    try:
        yield session, tmp_path
    finally:
        session.close()
        obs.flush()
        obs.shutdown()


def records(tmp_path: Path) -> list[dict]:
    obs.flush()
    path = tmp_path / handlers.LOG_FILE_NAME
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def find(rows: list[dict], event: str) -> list[dict]:
    return [row for row in rows if row["event"] == event]


def wait_for_record(tmp_path: Path, event: str, timeout: float = 5.0) -> list[dict]:
    """Poll the file until `event` appears, then return every record.

    ⚠ 不能只等状态位: `_connect_failed` 先改状态**再**写记录, 所以
    `arm_info()["status"] == "error"` 成立时记录可能还没落盘。断言"某条记录存在"
    就必须以文件为准, 否则这条用例会随机红。
    """
    deadline = time.monotonic() + timeout
    while True:
        rows = records(tmp_path)
        found = find(rows, event)
        if found or time.monotonic() > deadline:
            return rows
        time.sleep(0.02)


# --------------------------------------------------------------------------- lifecycle

def test_connect_writes_started_and_succeeded(logging_daemon) -> None:
    session, tmp_path = logging_daemon
    rows = records(tmp_path)
    started = find(rows, obs.CONNECT_STARTED)
    succeeded = find(rows, obs.CONNECT_SUCCEEDED)
    assert started and succeeded
    assert started[0]["trace_id"] == "trace-for-test"
    assert succeeded[0]["fields"]["n"] == 7
    assert succeeded[0]["fields"]["fake"] is True
    # 顺序即语义: "先开始、后成功" 是操作员读日志时的因果链。
    assert rows.index(started[0]) < rows.index(succeeded[0])


def test_disconnect_and_close_leave_a_reason(tmp_path: Path) -> None:
    obs.configure(log_dir=tmp_path, version="t", level="DEBUG")
    session = Session(fake=True, poll_period=0.02)
    try:
        assert session.connect() is True
        assert _wait(lambda: session.connected)
        # ⚠ 收尾那条记录由 `close()` 发出。先关会话再停日志, 否则它写不出去。
        session.close()
        obs.flush()
        rows = records(tmp_path)
    finally:
        obs.shutdown()
    assert find(rows, obs.SESSION_CLOSED)
    # 退出前失能是一条**产品策略**, 事后必须能回答"退的时候机械臂带没带使能"。
    assert find(rows, obs.DEENERGIZED)


def test_disconnect_records_the_port_it_dropped(tmp_path: Path) -> None:
    obs.configure(log_dir=tmp_path, version="t", level="DEBUG")
    session = Session(fake=True, poll_period=0.02)
    try:
        assert session.connect() is True
        assert _wait(lambda: session.connected)
        session.disconnect()
        obs.flush()
        rows = find(records(tmp_path), obs.DISCONNECTED)
    finally:
        session.close()
        obs.shutdown()
    assert rows
    assert rows[0]["fields"]["had_link"] is True
    assert rows[0]["fields"]["port"] == "fake"


def test_an_arm_held_across_close_is_reported_as_kept_enabled(tmp_path: Path) -> None:
    """`--keep-enabled` 是操作员的明确选择; 文件里要留下"是它选的", 不是沉默."""
    obs.configure(log_dir=tmp_path, version="t", level="DEBUG")
    session = Session(fake=True, poll_period=0.02, disable_on_exit=False)
    try:
        assert session.connect() is True
        assert _wait(lambda: session.connected)
        session.close()
        obs.flush()
        rows = records(tmp_path)
    finally:
        obs.shutdown()
    assert find(rows, obs.DEENERGIZE_SKIPPED)
    assert not find(rows, obs.DEENERGIZED)


def test_failed_connect_records_the_reason(tmp_path: Path) -> None:
    obs.configure(log_dir=tmp_path, version="t", level="DEBUG")
    session = Session(port_finder=lambda: None)
    try:
        assert session.connect() is True
        assert _wait(lambda: session.arm_info()["status"] == "error", timeout=5.0), \
            session.arm_info()
        # ⚠ 读记录要在 `close()` **之前**: 那之后写的记录落到哪里取决于收尾顺序,
        # 而这条用例关心的是握手失败这一条。
        rows = wait_for_record(tmp_path, obs.CONNECT_FAILED)
    finally:
        session.close()
        obs.shutdown()
    failed = find(rows, obs.CONNECT_FAILED)
    assert failed, [row["event"] for row in rows]
    assert "未发现 STM32 CDC" in failed[0]["body"]
    assert failed[0]["fields"]["error_kind"] == "TransportError"


# --------------------------------------------------------------------------- commands

def test_a_command_records_method_arguments_and_outcome(logging_daemon) -> None:
    session, tmp_path = logging_daemon
    session.execute("set_speed", {"percent": 40})
    rows = find(records(tmp_path), obs.COMMAND_SUCCEEDED)
    entry = next(row for row in rows if row["fields"]["method"] == "set_speed")
    assert entry["fields"]["args"] == {"percent": 40}
    assert entry["fields"]["outcome"] == "ok"
    assert entry["fields"]["result"] == 40
    assert entry["fields"]["duration_ms"] >= 0
    assert entry["span_id"]


def test_a_failed_command_is_an_error_record(logging_daemon) -> None:
    session, tmp_path = logging_daemon
    with pytest.raises(Exception):
        session.execute("set_speed", {"percent": 500})
    failed = find(records(tmp_path), obs.COMMAND_FAILED)
    assert failed
    assert failed[0]["fields"]["method"] == "set_speed"
    assert "error_kind" in failed[0]["fields"]
    assert failed[0]["fields"]["exception"]["message"]


def test_state_polling_does_not_flood_the_file(logging_daemon) -> None:
    """50Hz 轮询读的是缓存帧 —— 它不该变成 50Hz 的日志行 (issue #79 第 7 点)."""
    session, tmp_path = logging_daemon
    time.sleep(2.0)
    rows = records(tmp_path)
    command_rows = [row for row in rows if row["event"].startswith("arm.")]
    # 2s 的真实状态推送有 100 条上下; 文件里出现的是命令与生命周期, 不是每一拍。
    assert len(command_rows) == 0, [row["event"] for row in command_rows][:5]
    assert len(rows) < 20, f"日志被状态轮询灌满: {len(rows)} 行"


def test_debug_commands_are_filtered_at_info_level(tmp_path: Path) -> None:
    """读类命令在 INFO 下不该落盘; 同一批在 DEBUG 下必须能看见 (可诊断性)."""
    obs.configure(log_dir=tmp_path, version="t", level="INFO")
    session = Session(fake=True)
    try:
        assert session.connect() is True
        assert _wait(lambda: session.connected)
        session.execute("set_speed", {"percent": 30})       # 读类/设置类 → DEBUG
        session.execute("enable")                            # NOTABLE → INFO
        obs.flush()
        info_events = [row["event"] for row in records(tmp_path)]
    finally:
        session.close()
        obs.shutdown()

    obs.configure(log_dir=tmp_path, version="t", level="DEBUG")
    session2 = Session(fake=True)
    try:
        assert session2.connect() is True
        assert _wait(lambda: session2.connected)
        session2.execute("set_speed", {"percent": 30})
        obs.flush()
        debug_methods = [row["fields"].get("method") for row in records(tmp_path)
                         if row["event"] == obs.COMMAND_SUCCEEDED]
    finally:
        session2.close()
        obs.shutdown()

    assert obs.COMMAND_SUCCEEDED in info_events
    assert "set_speed" in debug_methods


# --------------------------------------------------------------------------- redaction, for real

def test_activation_request_never_reaches_the_file(logging_daemon) -> None:
    """这是本功能最要紧的一条: 个人信息与设备 UID 不许落盘。"""
    session, tmp_path = logging_daemon
    request = {
        "uid": SECRET_UID,
        "contact": {"name": SECRET_NAME, "phone": SECRET_PHONE,
                    "email": SECRET_EMAIL, "region": "CN",
                    "organization": "Acme", "wechatId": "wx-1",
                    "industry": "research", "purpose": "bench"},
        "consent": {"granted": True},
        "diagnostics": {"studio": "9.9.9-test", "sdk": "2.1.0", "firmware": "1.9.0"},
    }
    with pytest.raises(Exception):
        # 激活服务不可达 ⇒ 这条命令注定失败, 但"失败"也要留下记录。
        session.execute("activate", request, trace="trace-activate")
    obs.flush()
    blob = (tmp_path / handlers.LOG_FILE_NAME).read_text(encoding="utf-8")
    for secret in (SECRET_UID, SECRET_NAME, SECRET_PHONE, SECRET_EMAIL, "wx-1"):
        assert secret not in blob, f"日志文件泄露了 {secret!r}"
    rows = records(tmp_path)
    failed = [row for row in rows if row["event"] == obs.ACTIVATE_FAILED]
    assert failed, "失败也要有记录"
    assert failed[0]["fields"]["reason"] == "uid_mismatch"
    # 命令台账里只留**字段名**: 能确认"表单填过了", 拿不到填了什么。
    ledger = [row for row in rows
              if row["event"] == obs.COMMAND_FAILED
              and row["fields"].get("method") == "activate"]
    assert ledger
    assert ledger[0]["fields"]["args"]["contact_fields"]
    assert ledger[0]["fields"]["args"]["consent"] == {"granted": True}
    assert ledger[0]["trace_id"] == "trace-activate"


def test_firmware_image_bytes_never_reach_the_file(logging_daemon) -> None:
    session, tmp_path = logging_daemon
    image_text = "A" * 4096
    with pytest.raises(Exception):
        session.execute("firmware_inspect", {"name": "fw.hex", "data": image_text})
    obs.flush()
    blob = (tmp_path / handlers.LOG_FILE_NAME).read_text(encoding="utf-8")
    assert "A" * 64 not in blob
    failed = [row for row in records(tmp_path) if row["event"] == obs.COMMAND_FAILED]
    assert failed
    assert "chars" in json.dumps(failed[0]["fields"]["args"], ensure_ascii=False)


# --------------------------------------------------------------------------- the file as an artifact

def test_every_line_is_a_parseable_json_object(logging_daemon) -> None:
    """整份文件必须能被 `jq` 逐行吃下 —— 这是标准格式的全部意义。"""
    session, tmp_path = logging_daemon
    for method in ("set_speed", "enable", "get_tcp", "home"):
        try:
            session.execute(method, {"percent": 20} if method == "set_speed" else {})
        except Exception:  # noqa: BLE001 - 参数不被接受的命令也算一次尝试
            pass
    obs.flush()
    path = tmp_path / handlers.LOG_FILE_NAME
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines
    for line in lines:
        row = json.loads(line)
        assert row["service"] == "litearm-studio-daemon"
        assert row["ts"].endswith("Z")
        assert isinstance(row["severity_number"], int)
        assert row["event"]
