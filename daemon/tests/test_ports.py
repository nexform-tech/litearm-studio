"""设备选择 —— 端口枚举、`list_ports` 命令, 以及"这次连哪个口"的判据。

全部用例都不碰真硬件: 串口枚举由 `ports._pyserial_devices` / `ports._glob_devices`
两处注入, 连接由 `Session._dial` 拦下来记录。

⚠ 这个文件盯的是一条**界面上看不见的纪律**: 操作员在下拉里指了哪个口, daemon 就只连
那个口。偷偷换成发现到的另一个设备, 会让界面上"我以为连的是这台"变成谎话 —— 那是这
个功能最坏的失败形状, 比连不上严重得多。
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import List, Optional

import litearm
import pytest

from litearm_studio_daemon import ports
from litearm_studio_daemon.ports import LastPortStore
from litearm_studio_daemon.session import COMMANDS, SESSION_FREE_COMMANDS, Session

DUMMY = "/dev/ttyACM9"


def _wait(pred, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


# ---------------------------------------------------------------- 端口枚举

def _fake_enumeration(monkeypatch: pytest.MonkeyPatch, *,
                      pyserial: List[tuple], globs: Optional[List[str]] = None) -> None:
    monkeypatch.setattr(ports, "_pyserial_devices", lambda: list(pyserial))
    monkeypatch.setattr(ports, "_glob_devices", lambda platform: list(globs or []))


def test_stm32_cdc_comes_first_in_the_list(monkeypatch: pytest.MonkeyPatch) -> None:
    """同名的两块 CDC 在下拉里分不出来 —— 带 VID:PID 的那台必须排最前。

    界面把第一条当默认选择, 所以顺序是功能的一部分, 不是装饰。
    """
    _fake_enumeration(monkeypatch, pyserial=[
        ("/dev/ttyUSB0", (0x1234, 0x5678)),
        ("/dev/ttyACM0", ports.STM32_VID_PID),
    ])
    assert ports.list_serial_ports() == ["/dev/ttyACM0", "/dev/ttyUSB0"]


def test_ports_that_cannot_be_the_arm_are_left_out(monkeypatch: pytest.MonkeyPatch) -> None:
    """板载口与虚拟口不进下拉 —— 它们永远连不上这台臂, 只会让人在噪声里找设备。"""
    _fake_enumeration(monkeypatch, pyserial=[
        ("/dev/ttyS0", None),          # 主板串口
        ("/dev/pts/3", None),          # 伪终端
        ("/dev/ttyACM1", None),        # 真设备, 只是拿不到 VID:PID
    ])
    assert ports.list_serial_ports() == ["/dev/ttyACM1"]


def test_glob_fallback_still_lists_devices_without_pyserial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """pyserial 不在/枚举失败时按平台名 glob —— 只是排序变差, 不该变成空列表。"""
    _fake_enumeration(monkeypatch, pyserial=[], globs=["/dev/ttyUSB1", "/dev/ttyACM0"])
    assert ports.list_serial_ports() == ["/dev/ttyACM0", "/dev/ttyUSB1"]


def test_a_device_seen_twice_is_listed_once(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_enumeration(monkeypatch, pyserial=[("/dev/ttyACM0", None)],
                      globs=["/dev/ttyACM0"])
    assert ports.list_serial_ports() == ["/dev/ttyACM0"]


# ---------------------------------------------------------------- 上次连上的口

def test_the_store_round_trips_the_last_port(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "arm.json"
    LastPortStore(path).remember("/dev/ttyACM1")
    # 另一个实例读同一份文件 —— 这就是"重启守护进程之后还记得"那条要求。
    assert LastPortStore(path).last_port() == "/dev/ttyACM1"
    assert json.loads(path.read_text(encoding="utf-8"))["lastPort"] == "/dev/ttyACM1"


def test_the_store_reads_an_unreadable_file_as_no_record(tmp_path: Path) -> None:
    """读不懂就当作没记住 —— 一个坏文件不该让守护进程连不上设备。"""
    path = tmp_path / "arm.json"
    path.write_text("{ 这不是 JSON", encoding="utf-8")
    store = LastPortStore(path)
    assert store.last_port() is None
    store.remember("/dev/ttyACM2")            # 还能照常写回去
    assert LastPortStore(path).last_port() == "/dev/ttyACM2"


def test_an_empty_port_does_not_forget_the_record(tmp_path: Path) -> None:
    store = LastPortStore(tmp_path / "arm.json")
    store.remember("/dev/ttyACM0")
    store.remember(None)
    store.remember("   ")
    assert store.last_port() == "/dev/ttyACM0"


def test_the_record_follows_xdg_config_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ports.CONFIG_ENV, raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "cfg"))
    assert ports.default_config_path() == tmp_path / "cfg" / "litearm-studio" / "arm.json"


# ------------------------------------------------------- 这次连哪个口 (会话层)

def _recording_session(monkeypatch: pytest.MonkeyPatch, *,
                       dials: List[str],
                       port: Optional[str] = None,
                       found: Optional[str] = None,
                       store: Optional[LastPortStore] = None) -> Session:
    """一个把 `_dial` 换成记录器的会话 —— `_dial` 一定抛, 于是连接落到 `error` 态。

    抛异常是刻意的: 这里唯一要钉的是"**试了哪些口**、按什么顺序", 而不是握手本身
    (那条路由 `--fake` 那套全流程用例覆盖)。
    """
    session = Session(port=port, port_finder=lambda: found, port_store=store)

    def fake_dial(target: str):
        dials.append(target)
        raise litearm.TransportError(f"打不开 {target} (测试桩)")

    monkeypatch.setattr(session, "_dial", fake_dial)
    return session


def test_an_explicit_port_is_the_only_one_tried(monkeypatch: pytest.MonkeyPatch) -> None:
    """界面指了一个口 ⇒ 只连它, 哪怕自动发现能找到一个"更好的"。"""
    dials: List[str] = []
    s = _recording_session(monkeypatch, dials=dials, found="/dev/ttyACM0")
    try:
        assert s.connect(DUMMY) is True
        assert _wait(lambda: s.arm_info()["status"] == "error")
        assert dials == [DUMMY], "指定了口却退让给了自动发现"
        error = s.arm_info()["error"] or ""
        assert DUMMY in error and "/dev/ttyACM0" not in error
    finally:
        s.close()


def test_dash_port_is_still_the_only_one_tried(monkeypatch: pytest.MonkeyPatch) -> None:
    """`--port` 的老语义原样保留: 明确指定, 指定错了响亮失败。"""
    dials: List[str] = []
    s = _recording_session(monkeypatch, dials=dials, port="/dev/ttyACM3",
                           found="/dev/ttyACM0")
    try:
        assert s.connect() is True
        assert _wait(lambda: s.arm_info()["status"] == "error")
        assert dials == ["/dev/ttyACM3"]
    finally:
        s.close()


def test_the_chosen_port_is_used_once_then_the_soft_path_returns(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """界面选的口是**一次性**的: 之后客户端自动发的无参 `connect` 不该被它锁死。"""
    dials: List[str] = []
    s = _recording_session(monkeypatch, dials=dials, found="/dev/ttyACM0",
                           store=LastPortStore(tmp_path / "arm.json"))
    try:
        assert s.connect(DUMMY) is True
        assert _wait(lambda: dials == [DUMMY])
        assert s.connect() is True                       # 第二次: 不带口
        assert _wait(lambda: len(dials) == 2)
        assert dials == [DUMMY, "/dev/ttyACM0"], "用完即清这条没生效"
    finally:
        s.close()


def test_the_last_port_is_a_hint_then_discovery(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """上次连上的口在前, 但**允许退回发现** —— 设备重枚举之后节点名会变。"""
    dials: List[str] = []
    store = LastPortStore(tmp_path / "arm.json")
    store.remember("/dev/ttyACM5")
    s = _recording_session(monkeypatch, dials=dials, found="/dev/ttyACM0", store=store)
    try:
        assert s.connect() is True
        assert _wait(lambda: len(dials) == 2)
        assert dials == ["/dev/ttyACM5", "/dev/ttyACM0"]
    finally:
        s.close()


def test_without_any_hint_only_discovery_is_tried(monkeypatch: pytest.MonkeyPatch) -> None:
    dials: List[str] = []
    s = _recording_session(monkeypatch, dials=dials, found="/dev/ttyACM0")
    try:
        assert s.connect() is True
        assert _wait(lambda: dials == ["/dev/ttyACM0"])
    finally:
        s.close()


def test_no_candidate_at_all_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    """一个候选都没有时, 报的是"没发现设备", 不是某条打不开的路径。"""
    dials: List[str] = []
    s = _recording_session(monkeypatch, dials=dials, found=None)
    try:
        assert s.connect() is True
        assert _wait(lambda: s.arm_info()["status"] == "error")
        assert dials == []
        assert "未发现 STM32 CDC" in (s.arm_info()["error"] or "")
    finally:
        s.close()


def test_a_successful_connect_remembers_the_port(tmp_path: Path) -> None:
    """连上了才记 —— 记一个连不通的口, 会让下次的默认选择和"上次能用"无关。"""
    path = tmp_path / "arm.json"
    s = Session(fake=True, port_store=LastPortStore(path))
    try:
        assert s.connect("/dev/ttyACM7") is True
        assert _wait(lambda: s.connected), s.arm_info()
        assert s.arm_info()["port"] == "/dev/ttyACM7"
        assert LastPortStore(path).last_port() == "/dev/ttyACM7"
    finally:
        s.close()


# ---------------------------------------------------------------- list_ports

def test_list_ports_answers_without_a_session() -> None:
    """选端口发生在**连接之前** —— 这条命令不能要求"先连上设备"。"""
    s = Session(port_finder=lambda: None,
                port_lister=lambda: ["/dev/ttyACM0", "/dev/ttyUSB0"])
    try:
        assert s.connected is False
        assert "list_ports" in COMMANDS
        assert "list_ports" in SESSION_FREE_COMMANDS
        assert s.execute("list_ports") == ["/dev/ttyACM0", "/dev/ttyUSB0"]
    finally:
        s.close()
