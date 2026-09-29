"""标定解析 / 来源 / 闸门单测 —— §5.3 的七行顺序与 §4.3 的拒绝理由。

全部在临时目录里造文件, 不碰真机的标定, 也不需要 CAN。
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, Optional

import pytest

from litearm_studio_daemon.errors import GripperCalibrationError
from litearm_studio_daemon.gripper import calibration
from litearm_studio_daemon.gripper.config import ChannelStore
from litearm_studio_daemon.gripper.core import commands as cmd
from litearm_studio_daemon.gripper.core.worker import (
    GateState,
    WorkerLoop,
    evaluate_gate,
)
from litearm_studio_daemon.gripper.session import GripperSession
from litearm_studio_daemon.gripper.units import Limits

CHANNEL = "can0"

#: A valid measured calibration for a 85 mm unit, normal mount.
VALID = {
    "channel": CHANNEL,
    "can_id": 8,
    "zero_position_rad": 1.775959,
    "max_position_rad": -0.064279,
    "travel_range_rad": 1.840238,
    "rad_to_mm": 46.73,
}

REVERSE_FILE = dict(VALID, zero_position_rad=-0.064279, max_position_rad=1.775959)


def write(path: Path, data: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A private ``$HOME``, so nothing here can read or write the bench file."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv(calibration.CALIB_ENV, raising=False)
    monkeypatch.setenv("LITEGRIP_FACTORY_CALIB", str(tmp_path / "no-factory.json"))
    return tmp_path / "home"


# ------------------------------------------------------------------ 解析顺序

def test_row_1_the_pinned_path_wins(home: Path, tmp_path: Path) -> None:
    pinned = write(tmp_path / "pinned.json", VALID)
    own = write(home / ".litegrip" / f"{CHANNEL}_calibration.json", REVERSE_FILE)
    info = calibration.resolve(CHANNEL, path=str(pinned), travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_USER
    assert info.wire_source == "measured"
    assert Path(info.path) == pinned
    assert info.limits is not None and info.limits.closed_rad == pytest.approx(1.775959)
    assert own.exists()          # the channel file is there, and still not chosen


def test_row_1_a_missing_pinned_path_is_reported_not_skipped(home: Path,
                                                             tmp_path: Path) -> None:
    write(home / ".litegrip" / f"{CHANNEL}_calibration.json", REVERSE_FILE)
    info = calibration.resolve(CHANNEL, path=str(tmp_path / "gone.json"),
                               travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_MISSING
    assert "不存在" in "；".join(info.problems)


def test_row_2_the_channels_own_file(home: Path) -> None:
    own = write(home / ".litegrip" / f"{CHANNEL}_calibration.json", VALID)
    info = calibration.resolve(CHANNEL, travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_USER
    assert Path(info.path) == own


def test_row_3_the_environment_override_is_flagged(home: Path, tmp_path: Path,
                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    override = write(tmp_path / "from-env.json", VALID)
    monkeypatch.setenv(calibration.CALIB_ENV, str(override))
    info = calibration.resolve(CHANNEL, travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_USER
    assert Path(info.path) == override
    assert any("环境变量" in w for w in info.warnings), info.warnings


def test_row_4_the_legacy_single_file_is_flagged(home: Path) -> None:
    legacy = write(home / ".litegrip" / "litegrip_calibration.json", VALID)
    info = calibration.resolve(CHANNEL, travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_USER
    assert Path(info.path) == legacy
    assert any("旧版" in w for w in info.warnings), info.warnings


def test_row_5_a_declared_mount_loads_the_template(home: Path) -> None:
    info = calibration.resolve(CHANNEL, mount="reverse", travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_TEMPLATE
    assert info.template == "reverse"
    assert info.wire_source == "template"
    assert info.limits is not None and info.limits.reversed_mount
    # ⚠ D4: nothing is copied into the user directory.
    assert not (home / ".litegrip").exists()
    assert any("从未在本机实测" in w for w in info.warnings)


def test_row_5_a_measured_file_beats_a_declared_mount(home: Path) -> None:
    write(home / ".litegrip" / f"{CHANNEL}_calibration.json", VALID)
    info = calibration.resolve(CHANNEL, mount="reverse", travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_USER


def test_row_6_the_factory_file_is_reported_as_factory(home: Path, tmp_path: Path,
                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    factory = write(tmp_path / "factory.json", VALID)
    monkeypatch.setenv("LITEGRIP_FACTORY_CALIB", str(factory))
    info = calibration.resolve(CHANNEL, travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_FACTORY
    assert info.wire_source == "factory"
    assert info.limits is not None


def test_row_7_nothing_is_missing_not_factory(home: Path) -> None:
    info = calibration.resolve(CHANNEL, travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_MISSING
    assert info.wire_source == "missing"
    assert info.limits is None
    assert info.problems


def test_the_default_mount_is_normal_so_a_fresh_install_lands_on_the_template(
        home: Path, tmp_path: Path) -> None:
    """默认装配方向是正装：没有实测文件时落到第 5 行，而不是第 6/7 行。

    这是操作员能感到的差别：正装模板允许张开/闭合，出厂回退和"什么都没有"什么都不
    允许。第 6/7 行仍然可达 —— 显式把方向写成别的、或模板文件缺失 —— 但默认不再走
    那里。
    """
    store = ChannelStore(tmp_path / "gripper.json")
    assert store.get(CHANNEL).mount == "normal"

    session = _session(tmp_path)
    try:
        _connect(session)
        info = session.loop.info
        assert info is not None
        assert info.provenance == calibration.PROVENANCE_TEMPLATE
        assert info.template == "normal"
        assert session.gate() is GateState.TEMPLATE
    finally:
        session.close()


# ------------------------------------------------------------------ 拒绝的形状

def test_a_file_naming_another_channel_is_never_adopted(home: Path) -> None:
    """通道是同一总线上两台夹爪唯一的身份键 (§5.3)。"""
    write(home / ".litegrip" / f"{CHANNEL}_calibration.json",
          dict(VALID, channel="can1"))
    info = calibration.resolve(CHANNEL, travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_INVALID
    assert info.limits is None
    assert any("channel=can1" in p for p in info.problems), info.problems


def test_a_malformed_file_is_invalid_with_a_reason(home: Path) -> None:
    path = home / ".litegrip" / f"{CHANNEL}_calibration.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json", encoding="utf-8")
    info = calibration.resolve(CHANNEL, travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_INVALID
    assert any("JSON" in p for p in info.problems), info.problems


def test_a_missing_required_key_is_a_problem_not_a_traceback(home: Path) -> None:
    data = dict(VALID)
    del data["rad_to_mm"]
    write(home / ".litegrip" / f"{CHANNEL}_calibration.json", data)
    info = calibration.resolve(CHANNEL, travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_INVALID
    assert any("rad_to_mm" in p for p in info.problems), info.problems


def test_a_zero_travel_is_a_problem(home: Path) -> None:
    write(home / ".litegrip" / f"{CHANNEL}_calibration.json",
          dict(VALID, max_position_rad=VALID["zero_position_rad"]))
    info = calibration.resolve(CHANNEL, travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_INVALID
    assert any("行程" in p for p in info.problems), info.problems


def test_an_implausible_scale_is_a_problem(home: Path) -> None:
    """行程设定与文件的角度不属于同一台夹爪时, 推导出的 mm/rad 会跳出合理带。"""
    write(home / ".litegrip" / f"{CHANNEL}_calibration.json", VALID)
    info = calibration.resolve(CHANNEL, travel_mm=10.0)
    assert info.provenance == calibration.PROVENANCE_INVALID
    assert any("rad_to_mm" in p for p in info.problems), info.problems


def test_a_template_path_is_labelled_a_template_wherever_it_came_from(
        home: Path) -> None:
    from litearm_studio_daemon.gripper.calibration import template_path

    info = calibration.resolve(CHANNEL, path=str(template_path("normal")),
                               travel_mm=85.0)
    assert info.provenance == calibration.PROVENANCE_TEMPLATE
    assert info.template == "normal"


# ------------------------------------------------------------------ 交叉核对

def test_cross_check_catches_a_file_the_sdk_did_not_apply() -> None:
    raw = {"zero_position_rad": 1.0, "max_position_rad": -0.5, "rad_to_mm": 50.0}
    limits = calibration.limits_from_raw(raw, 85.0)
    info = calibration.CalibrationInfo(
        provenance=calibration.PROVENANCE_USER, limits=limits, path="/x.json",
        raw=raw, max_stroke_mm=85.0)
    # The SDK applied what the file said: angles and the file's own scale.
    applied = Limits(closed_rad=1.0, open_rad=-0.5, rad_to_mm=50.0,
                     max_stroke_mm=120.0)
    assert calibration.cross_check(info, applied) == []
    # ... and here it applied something else entirely.
    mismatch = calibration.cross_check(
        info, Limits(closed_rad=1.2, open_rad=-0.5, rad_to_mm=50.0,
                     max_stroke_mm=120.0))
    assert mismatch and "交叉核对" in mismatch[0], mismatch


def test_cross_check_refuses_a_load_that_reported_nothing() -> None:
    raw = {"zero_position_rad": 1.0, "max_position_rad": -0.5, "rad_to_mm": 50.0}
    info = calibration.CalibrationInfo(
        provenance=calibration.PROVENANCE_USER,
        limits=calibration.limits_from_raw(raw, 85.0), path="/x.json", raw=raw)
    assert calibration.cross_check(info, None)


# ------------------------------------------------------------------ sdk_source

def test_sdk_source_never_asks_for_a_silent_default() -> None:
    raw = {"zero_position_rad": 1.0, "max_position_rad": -0.5, "rad_to_mm": 50.0}
    limits = calibration.limits_from_raw(raw, 85.0)
    measured = calibration.CalibrationInfo(
        provenance=calibration.PROVENANCE_USER, limits=limits, path="/x.json", raw=raw)
    assert calibration.sdk_source(measured) == ("path", "/x.json")
    named = calibration.CalibrationInfo(
        provenance=calibration.PROVENANCE_TEMPLATE, limits=limits,
        path="/t.json", template="reverse")
    assert calibration.sdk_source(named) == ("template", "reverse")
    unsaved = calibration.CalibrationInfo(
        provenance=calibration.PROVENANCE_MEMORY, limits=limits)
    assert calibration.sdk_source(unsaved) is None
    assert calibration.sdk_source(
        calibration.CalibrationInfo(calibration.PROVENANCE_MISSING, None)) is None


# ------------------------------------------------------------------ 闸门

def test_gate_allows_measured_and_blocks_missing() -> None:
    raw = {"zero_position_rad": 1.0, "max_position_rad": -0.5, "rad_to_mm": 50.0}
    limits = calibration.limits_from_raw(raw, 85.0)
    measured = calibration.CalibrationInfo(
        provenance=calibration.PROVENANCE_USER, limits=limits, path="/x.json", raw=raw)
    assert evaluate_gate(measured)[0] is GateState.READY
    missing = calibration.CalibrationInfo(calibration.PROVENANCE_MISSING, None)
    assert evaluate_gate(missing)[0] is GateState.BLOCKED


def test_factory_needs_the_operators_acknowledgement() -> None:
    raw = {"zero_position_rad": 1.0, "max_position_rad": -0.5, "rad_to_mm": 50.0}
    factory = calibration.CalibrationInfo(
        provenance=calibration.PROVENANCE_FACTORY,
        limits=calibration.limits_from_raw(raw, 85.0), path="/f.json", raw=raw)
    state, reason = evaluate_gate(factory, allow_factory=False)
    assert state is GateState.FACTORY
    assert "确认" in reason or "允许" in reason
    assert evaluate_gate(factory, allow_factory=True)[0] is GateState.READY


def test_an_in_memory_probe_result_is_not_yet_motion() -> None:
    info = calibration.in_memory(1.0, -0.5, 50.0, 85.0)
    state, reason = evaluate_gate(info)
    assert state is GateState.BLOCKED
    assert "保存" in reason


def test_a_template_is_surmountable_for_direction_only() -> None:
    info = calibration.resolve(CHANNEL, mount="normal", travel_mm=85.0,
                               env={"LITEGRIP_FACTORY_CALIB": "/nonexistent"})
    state, reason = evaluate_gate(info)
    assert state is GateState.TEMPLATE
    assert "从未在本机实测" in reason


def test_the_worker_refuses_a_millimetre_target_under_a_template() -> None:
    """§5.3: 模板只允许 open/close/release; 毫米目标按 120mm 几何算是错的。"""
    from litearm_studio_daemon.gripper.backend.sim import SimBackend

    class Recorder:
        def __init__(self) -> None:
            self.alerts = []
            for name in ("telemetry", "motion_state", "conn_state", "fault",
                         "gate_state", "calib_info", "calib_progress", "log",
                         "alert", "busy"):
                setattr(self, name, _Chan(name, self))

    class _Chan:
        def __init__(self, name: str, owner: Recorder) -> None:
            self._name, self._owner = name, owner

        def emit(self, *values: Any) -> None:
            if self._name == "alert":
                self._owner.alerts.append(values)

    # ⚠ The simulator's clock is injected as well as the loop's: SimBackend
    # integrates against its own clock, so leaving it on wall time makes the
    # status frames depend on how long the interpreter took per tick — which is
    # what made this test pass alone and fail in a full run.
    now = [0.0]
    backend = SimBackend(clock=lambda: now[0])
    signals = Recorder()
    loop = WorkerLoop(backend, signals, clock=lambda: now[0],
                      sleep=lambda _s: None, watchdog_s=None)
    loop.submit(cmd.Connect())
    loop.tick_once(0.005)
    loop.submit(cmd.Enable())
    loop.tick_once(0.005)
    loop.submit(cmd.LoadTemplate("normal"))
    for _ in range(5):
        now[0] += 0.005
        loop.tick_once(0.005)
    assert loop.gate is GateState.TEMPLATE

    loop.submit(cmd.MoveToMm(20.0, source="test"))
    now[0] += 0.005
    loop.tick_once(0.005)
    refusals = [e for e in signals.alerts if "被拒绝" in e[1]]
    assert refusals, signals.alerts
    # ⚠ 被 tick 拒掉的指令没有 `res` 可回，kind 是浏览器唯一能翻译的字段。
    assert refusals[0][2] == "GripperCalibrationError", refusals
    assert loop.motion.state.value != "SERVO"

    loop.submit(cmd.Open(source="test"))
    now[0] += 0.005
    loop.tick_once(0.005)
    assert loop.motion.state.value in ("SERVO", "HOLD", "HOLD_RAD"), loop.motion.state


# ------------------------------------------------------------------ 会话命令

def _session(tmp_path: Path, **kwargs: Any) -> GripperSession:
    return GripperSession(fake=True, store=ChannelStore(tmp_path / "gripper.json"),
                          **kwargs)


def _connect(session: GripperSession, **params: Any) -> None:
    session.execute("gripper.connect", params)
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline and not session.connected():
        session.heartbeat()
        time.sleep(0.01)
    assert session.connected()


def _heartbeat_in_background(session: GripperSession) -> threading.Event:
    """Keep the watchdog fed while the calling thread blocks on a long command.

    A real probe takes tens of seconds and the daemon's own heartbeat loop feeds
    it only while a browser is connected; a test that calls ``zero()`` on the
    calling thread has to do the same, or the watchdog (§5.1) aborts the probe
    out from under it.  Set the returned event to stop.
    """
    stop = threading.Event()

    def beat() -> None:
        while not stop.is_set():
            session.heartbeat()
            time.sleep(0.2)

    threading.Thread(target=beat, name="test-heartbeat", daemon=True).start()
    return stop


def test_load_template_persists_the_mount_and_reports_provenance(tmp_path: Path) -> None:
    session = _session(tmp_path)
    try:
        _connect(session)
        assert session.execute("gripper.load_template", {"mount": "reverse"}) == {
            "mount": "reverse", "source": "template"}
        assert session.config.mount == "reverse"
        # 读回的是设备实际在跑的方向, 不是记录里那一行声明。
        assert session.conn_info()["mount"] == "reverse"
        assert session.conn_info()["template"] == "reverse"
        assert session.gate() is GateState.TEMPLATE
        session.heartbeat()
        session.close()
        again = _session(tmp_path)
        try:
            assert again.config.mount == "reverse"      # 重启后仍然记得
        finally:
            again.close()
    finally:
        session.close()


def test_move_to_is_refused_under_a_template_but_open_is_not(tmp_path: Path) -> None:
    session = _session(tmp_path)
    try:
        _connect(session, mount="reverse")
        assert session.execute("gripper.enable", {}) == {"enabled": True}
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not (
                session.state() and session.state()["enabled"]):
            time.sleep(0.01)
        with pytest.raises(GripperCalibrationError):
            session.execute("gripper.move_to", {"targetMm": 30.0})
        with pytest.raises(GripperCalibrationError):
            session.execute("gripper.grasp", {"forceN": 10.0})
        assert session.execute("gripper.open", {}) == {"ok": True}
        assert session.execute("gripper.release", {}) is None
    finally:
        session.close()


def test_list_calibrations_answers_without_a_connection(tmp_path: Path) -> None:
    session = _session(tmp_path)
    try:
        items = session.execute("gripper.list_calibrations", {})
        assert isinstance(items, list) and items
        for item in items:
            assert set(item) >= {"path", "source", "valid", "problems", "warnings",
                                 "closedRad", "openRad", "fileRadToMm", "template"}
    finally:
        session.close()


def test_import_calibration_pins_and_applies_the_file(tmp_path: Path) -> None:
    source = write(tmp_path / "imported.json", VALID)
    session = _session(tmp_path)
    try:
        _connect(session)
        result = session.execute("gripper.import_calibration", {"path": str(source)})
        assert result == {"path": str(source), "source": "measured"}
        assert session.config.calibration_path == str(source)
        assert session.gate() is GateState.READY
        # 重连之后仍然走这份文件 (§5.6: 记录要活过重启)。
        session.execute("gripper.disconnect", {})
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and session.status != "disconnected":
            time.sleep(0.01)
        _connect(session)
        assert session.loop.info is not None
        assert Path(session.loop.info.path) == source
    finally:
        session.close()


def test_import_refuses_a_malformed_file_before_the_sdk_sees_it(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("{}", encoding="utf-8")
    session = _session(tmp_path)
    try:
        _connect(session)
        with pytest.raises(GripperCalibrationError):
            session.execute("gripper.import_calibration", {"path": str(bad)})
        with pytest.raises(ValueError):
            session.execute("gripper.import_calibration", {"path": str(tmp_path / "no.json")})
        with pytest.raises(ValueError):
            session.execute("gripper.import_calibration", {})
    finally:
        session.close()


def test_set_allow_factory_is_persisted(tmp_path: Path) -> None:
    session = _session(tmp_path)
    try:
        assert session.execute("gripper.set_allow_factory", {"allow": True}) == {
            "allowFactory": True}
        assert session.config.allow_factory is True
        with pytest.raises(ValueError):
            session.execute("gripper.set_allow_factory", {"allow": "yes"})
    finally:
        session.close()
    assert _session(tmp_path).config.allow_factory is True


def test_list_calibrations_marks_the_one_in_effect_and_includes_it(
        tmp_path: Path, home: Path) -> None:
    """生效的那一份必须出现在列表里 —— 即使它不是解析顺序里的候选。

    仿真后端保存到自己的文件（绝不碰台架那份），所以只有候选列表的页面会在一次成功的
    zero() 之后显示"什么都没测到"。

    ⚠ 探测期间必须一直喂心跳。看门狗 (3s) 会中止没有心跳的探测，而中止的探测现在会
    **如实报错**（见 ``test_an_aborted_probe_is_never_reported_as_measured``）。心跳一
    停这条用例就失败 —— 那正是它要钉住的行为：只有真的测完才会得到 ``measured``。
    """
    session = _session(tmp_path)
    try:
        _connect(session)
        before = session.execute("gripper.list_calibrations", {})
        # 生效的那一份**总是**在列表里，即使它不是解析顺序里的候选（仿真默认就在这里）。
        assert sum(1 for item in before if item.get("inUse")) == 1, before

        assert session.execute("gripper.enable", {}) == {"enabled": True}
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not (session.state() and session.state()["enabled"]):
            session.heartbeat()
            time.sleep(0.01)
        beats = _heartbeat_in_background(session)
        try:
            result = session.execute("gripper.zero", {"travelMm": 85.0})
        finally:
            beats.set()
        assert result["source"] == "measured"
        # 一次真的实测：结果必须已经落盘，而不是内存里那一份（内存的那份不算数）。
        info = session.loop.info
        assert info is not None and info.path is not None
        assert Path(info.path).is_file(), info.path

        after = session.execute("gripper.list_calibrations", {})
        active = [item for item in after if item.get("inUse")]
        assert len(active) == 1, after
        assert active[0]["path"] == session.loop.info.path
        assert active[0]["source"] == "measured"
        assert active[0]["closedRad"] is not None
    finally:
        session.close()


def test_an_aborted_probe_is_never_reported_as_measured(tmp_path: Path, home: Path) -> None:
    """被中止的探测不能拿"上一份标定"冒充结果。

    中止路径（看门狗 / 急停 / 断开 / 位置帧发不出去）都会清掉 ``probe`` 而把 ``info``
    留在**上一份**标定上。以前的等待谓词只看"probe 没了、info 还在且不是内存标定"，
    于是立刻满足，``zero()`` 把那份旧标定当成刚测出来的结果回给页面，还标着
    ``source: "measured"``，同时一个文件都没写。
    """
    session = _session(tmp_path)
    try:
        _connect(session)
        assert session.execute("gripper.enable", {}) == {"enabled": True}
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not (session.state() and session.state()["enabled"]):
            session.heartbeat()
            time.sleep(0.01)

        # 位置帧发不出去 ⇒ 探测自己在 0.5s 内中止（真机上的同类触发是链路掉了）。
        session.loop.backend.tx_fail = True
        with pytest.raises(GripperCalibrationError):
            session.execute("gripper.zero", {"travelMm": 85.0})

        outcome = session.loop.probe_outcome
        assert outcome is not None and outcome[1] is False, outcome
        # 报告失败之后，闸门仍然是关的：没有任何"刚测好的标定"被采用。
        assert session.loop.backend.calibration_info().provenance != "measured"
    finally:
        session.close()

