"""CAN 链路单测 —— 枚举、探测、提权准备, 以及"错在哪儿"的措辞。

`ip`/`pkexec` 都是注入的假进程: 这里不碰真总线, 也不会弹出授权对话框。
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, List, Optional, Sequence, Tuple

import pytest

from litearm_studio_daemon.errors import GripperLinkError
from litearm_studio_daemon.gripper import can_link
from litearm_studio_daemon.gripper.can_link import (
    LINK_CONFIGURED,
    LINK_DENIED,
    LINK_FAILED,
    LINK_FD,
    LINK_MISSING,
    LINK_OK,
    CanLink,
    manual_hint,
    parse_link,
)
from litearm_studio_daemon.gripper.config import ChannelStore
from litearm_studio_daemon.gripper.session import GripperSession

# ── 真实 transcript (iproute2 的输出形状, 原样抄来) ────────────────────────

READY = (
    "3: can0: <NOARP,UP,LOWER_UP,ECHO> mtu 16 qdisc pfifo_fast state UP mode DEFAULT "
    "group default qlen 10\n"
    "    link/can  promiscuity 0 allmulti 0 minmtu 0 maxmtu 0\n"
    "    can state ERROR-ACTIVE restart-ms 100\n"
    "          bitrate 1000000 sample-point 0.750\n"
    "          tq 62 prop-seg 3 phase-seg1 4 phase-seg2 3 sjw 1\n"
)

DOWN_UNCONFIGURED = (
    "3: can0: <NOARP> mtu 16 qdisc noop state DOWN mode DEFAULT group default qlen 10\n"
    "    link/can  promiscuity 0 allmulti 0 minmtu 0 maxmtu 0\n"
)

WRONG_BITRATE = (
    "3: can0: <NOARP,UP,LOWER_UP,ECHO> mtu 16 qdisc pfifo_fast state UP mode DEFAULT "
    "group default qlen 10\n"
    "    link/can  promiscuity 0 allmulti 0 minmtu 0 maxmtu 0\n"
    "    can state ERROR-ACTIVE restart-ms 0\n"
    "          bitrate 500000 sample-point 0.875\n"
)

BUS_OFF = (
    "3: can0: <NOARP,UP,LOWER_UP,ECHO> mtu 16 qdisc pfifo_fast state UP mode DEFAULT "
    "group default qlen 10\n"
    "    link/can  promiscuity 0 allmulti 0 minmtu 0 maxmtu 0\n"
    "    can state BUS-OFF restart-ms 0\n"
    "          bitrate 1000000 sample-point 0.750\n"
)

FD = (
    "3: can0: <NOARP,UP,LOWER_UP,ECHO> mtu 72 qdisc pfifo_fast state UP mode DEFAULT "
    "group default qlen 10\n"
    "    link/can  promiscuity 0 allmulti 0 minmtu 0 maxmtu 0\n"
    "    can state ERROR-ACTIVE restart-ms 0\n"
    "          bitrate 1000000 dbitrate 5000000 fd on\n"
)

MISSING = (
    "Cannot find device \"can7\"\n"
    "Device \"can7\" does not exist.\n"
)

MANUAL = (
    "3: can0: <NOARP,UP,LOWER_UP,ECHO> mtu 16 qdisc pfifo_fast state UP mode DEFAULT "
    "group default qlen 10\n"
    "    link/can\n"
    "    can state ERROR-ACTIVE restart-ms 100\n"
    "          bitrate 1000000 sample-point 0.750\n"
)


class FakeProcess:
    """A scripted `ip`/`pkexec`, keyed by the command name and its arguments.

    A key may map to a list of results, consumed in order — which is how the
    prep-then-reprobe sequence is expressed: the interface is wrong when it is
    first probed and right when it is asked again after the repair.
    """

    def __init__(self, answers: dict) -> None:
        self.answers = answers
        self.calls: List[List[str]] = []

    def __call__(self, argv: Sequence[str], timeout: float) -> subprocess.CompletedProcess:
        self.calls.append(list(argv))
        name = Path(argv[0]).name
        for key, result in self.answers.items():
            # Keyed by the binary's name and the arguments that follow it, so a
            # test reads as the command an operator would type.
            if name != key[0]:
                continue
            if tuple(argv[1:1 + len(key) - 1]) != tuple(key[1:]):
                continue
            if isinstance(result, list):
                return result.pop(0) if len(result) > 1 else result[0]
            return result
        raise AssertionError(f"未预期的命令: {argv}")

    @property
    def privileged(self) -> List[List[str]]:
        return [c for c in self.calls if Path(c[0]).name == "pkexec"]


def completed(args: Sequence[str], stdout: str = "", stderr: str = "",
              returncode: int = 0) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(list(args), returncode, stdout, stderr)


def which_found(_name: str) -> str:
    return "/usr/bin/ip" if _name == "ip" else "/usr/bin/pkexec"


# ── 解析 ────────────────────────────────────────────────────────────────────

def test_parse_link_reads_a_healthy_classic_bus() -> None:
    state = parse_link(READY)
    assert state.exists and state.up and not state.fd
    assert state.bitrate == 1_000_000
    assert state.can_state == can_link.CAN_ERROR_ACTIVE
    assert state.matches(1_000_000) and not state.deaf
    assert "已 up" in state.describe() and "经典 CAN" in state.describe()


def test_parse_link_reads_a_down_interface() -> None:
    state = parse_link(DOWN_UNCONFIGURED)
    assert state.exists and not state.up and state.bitrate is None
    assert not state.matches(1_000_000)


def test_parse_link_reads_bus_off_and_fd() -> None:
    off = parse_link(BUS_OFF)
    assert off.deaf and not off.matches(1_000_000)
    assert "BUS-OFF" in off.describe()
    fd = parse_link(FD)
    assert fd.fd and fd.bitrate == 1_000_000        # the nominal one, not dbitrate
    assert not fd.matches(1_000_000)                # an FD bus is never repaired


def test_parse_link_reads_a_missing_device() -> None:
    assert not parse_link(MISSING, returncode=1).exists
    assert not parse_link(MISSING, returncode=0).exists


# ── 准备 (ensure) ───────────────────────────────────────────────────────────

def test_a_correct_interface_is_left_alone_and_asks_for_no_password() -> None:
    ip = FakeProcess({("ip",): completed(["ip"], READY)})
    link = CanLink("can0", 1_000_000, run=ip, which=which_found)
    outcome = link.ensure()
    assert outcome.state == LINK_OK
    assert not outcome.needs_attention
    assert ip.privileged == [], "已经正确的接口不该提权"
    assert len(ip.calls) == 1


def test_a_wrong_bitrate_is_repaired_through_one_privileged_call() -> None:
    ip = FakeProcess({
        ("ip", "-details"): [completed(["ip"], WRONG_BITRATE),
                             completed(["ip"], READY)],
        ("pkexec",): completed(["pkexec"], ""),
    })
    link = CanLink("can0", 1_000_000, run=ip, which=which_found)
    outcome = link.ensure()
    assert outcome.state == LINK_CONFIGURED
    assert not outcome.needs_attention, "改好了不该报故障"
    assert len(ip.privileged) == 1, "一次授权, 不是三次"
    argv = ip.privileged[0]
    assert argv[1] == can_link.SHELL
    assert argv[-3:] == ["can0", "1000000", str(can_link.constants.CAN_LINK_RESTART_MS)]


def test_a_missing_interface_is_one_actionable_message_and_no_dialog() -> None:
    ip = FakeProcess({("ip",): completed(["ip"], MISSING, returncode=1)})
    link = CanLink("can7", 1_000_000, run=ip, which=which_found)
    outcome = link.ensure()
    assert outcome.state == LINK_MISSING
    assert outcome.needs_attention
    assert "can7" in outcome.detail and "不存在" in outcome.detail
    assert ip.privileged == [], "设备不存在时提权只会白弹一次密码框"


def test_a_dismissed_dialog_leaves_the_interface_alone_and_says_so() -> None:
    ip = FakeProcess({
        ("ip", "-details"): completed(["ip"], WRONG_BITRATE),
        ("pkexec",): completed(["pkexec"], stderr="用户取消了", returncode=126),
    })
    link = CanLink("can0", 1_000_000, run=ip, which=which_found)
    outcome = link.ensure()
    assert outcome.state == LINK_DENIED
    assert outcome.needs_attention
    assert manual_hint("can0", 1_000_000) in outcome.detail


def test_a_bus_off_controller_gets_the_three_possible_causes() -> None:
    ip = FakeProcess({
        ("ip", "-details"): completed(["ip"], BUS_OFF),
        ("pkexec",): completed(["pkexec"], ""),
    })
    link = CanLink("can0", 1_000_000, run=ip, which=which_found)
    outcome = link.ensure()
    assert outcome.state == LINK_FAILED
    assert "BUS-OFF" in outcome.detail
    assert "驱动器" in outcome.detail and "终端电阻" in outcome.detail


def test_missing_tools_do_not_crash_the_connect() -> None:
    ip = FakeProcess({})
    link = CanLink("can0", 1_000_000, run=ip, which=lambda _n: None)
    outcome = link.ensure()
    assert outcome.state == LINK_FAILED
    assert "pkexec" in outcome.detail
    assert ip.calls == []


def test_an_implausible_interface_name_is_never_handed_to_a_privileged_command() -> None:
    ip = FakeProcess({})
    link = CanLink("can0; rm -rf /", 1_000_000, run=ip, which=which_found)
    outcome = link.ensure()
    assert outcome.state == LINK_FAILED
    assert ip.calls == []


def test_a_bus_off_error_message_becomes_a_link_failure() -> None:
    exc = OSError(100, "Network is down")
    message = can_link.link_failure(exc, "can0")
    assert message is not None and "can0" in message
    assert can_link.link_failure(ValueError("nope"), "can0") is None


# ── 会话侧 ──────────────────────────────────────────────────────────────────

def _session(tmp_path: Path, **kwargs: Any) -> GripperSession:
    return GripperSession(fake=False, store=ChannelStore(tmp_path / "gripper.json"),
                          **kwargs)


def test_the_simulator_has_no_interface_to_prepare(tmp_path: Path) -> None:
    session = GripperSession(fake=True, store=ChannelStore(tmp_path / "gripper.json"))
    try:
        assert session._make_can_link(session.config) is None
        assert session.execute("gripper.connect", {}) == {"started": True}
    finally:
        session.close()


def test_no_can_setup_means_no_password_dialog(tmp_path: Path) -> None:
    session = _session(tmp_path, can_setup=False)
    try:
        assert session._make_can_link(session.config) is None
    finally:
        session.close()


def test_the_hook_prepares_the_configured_channel(tmp_path: Path) -> None:
    session = _session(tmp_path)
    try:
        link = session._make_can_link(session.config)
        assert link is not None and link.channel == "can0"
        assert link.bitrate == can_link.constants.CAN_BITRATE
    finally:
        session.close()


def test_connecting_to_a_channel_the_machine_lacks_lists_the_ones_it_has(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(can_link, "list_channels", lambda *a, **k: ["can0", "vcan0"])
    session = _session(tmp_path)
    try:
        with pytest.raises(GripperLinkError) as excinfo:
            session.execute("gripper.connect", {"channel": "can9"})
        assert "can9" in str(excinfo.value)
        assert "can0" in str(excinfo.value) and "vcan0" in str(excinfo.value)
    finally:
        session.close()


def test_an_empty_enumeration_does_not_refuse_the_connect(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """枚举不到不等于不存在 (容器/无 /sys): 那种机器上照样得能连。"""
    monkeypatch.setattr(can_link, "list_channels", lambda *a, **k: [])
    session = _session(tmp_path)
    try:
        assert session.execute("gripper.connect", {}) == {"started": True}
    finally:
        session.close()


def test_list_channels_is_not_filtered_by_the_session(tmp_path: Path,
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(can_link, "list_channels", lambda *a, **k: ["can1", "can0"])
    session = GripperSession(fake=True, store=ChannelStore(tmp_path / "gripper.json"))
    try:
        assert session.execute("gripper.list_channels", {}) == ["can1", "can0"]
    finally:
        session.close()


# ── 命令行 ──────────────────────────────────────────────────────────────────

def test_cli_flags_reach_the_gripper_session(tmp_path: Path,
                                             monkeypatch: pytest.MonkeyPatch) -> None:
    from litearm_studio_daemon.__main__ import build_gripper_session, build_parser

    from litearm_studio_daemon.gripper.config import CONFIG_ENV
    monkeypatch.setenv(CONFIG_ENV, str(tmp_path / "gripper.json"))
    args = build_parser().parse_args(["--fake", "--can-channel", "vcan0",
                                      "--no-can-setup"])
    session = build_gripper_session(args)
    try:
        assert session is not None
        assert session.config.channel == "vcan0"
        assert session._make_can_link(session.config) is None
    finally:
        assert session is not None
        session.close()


def test_cli_can_turn_the_gripper_off() -> None:
    from litearm_studio_daemon.__main__ import build_gripper_session, build_parser

    assert build_gripper_session(build_parser().parse_args(["--fake", "--no-gripper"])) is None
