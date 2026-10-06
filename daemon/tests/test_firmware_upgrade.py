"""固件升级（USB DFU）单测 —— 镜像判据、流水线相位，以及两条"不这样必坏"的闸。

全部跑在假件上（`dfu.fake.FakeEngine` + SDK 的 `FakeTransport`）：**不碰硬件、
不需要 pyusb**。真机验收是另一回事（见 `FIRMWARE-UPGRADE-PLAN.md` §5.3）——
板子烧一次要人在场、臂要有支撑，不能当成日常回归。

⚠ 两条闸是本文件的重点，它们各自都能让功能"看起来能用但必坏"：

* **升级期间必须压住断线自愈** —— 设备从 CDC 消失是我们主动交出去的，自愈线程
  会去跟烧录器抢同一个 USB 设备；
* **失败也必须把设备拉出 DFU** —— 留在 bootloader 里的板子看起来就是"坏了"。
"""
from __future__ import annotations

import base64
import threading
import time

import pytest

from litearm_studio_daemon import dfu
from litearm_studio_daemon.dfu import fake as fake_engine
from litearm_studio_daemon.errors import (
    FirmwareUpgradeError,
    UpgradeBusyError,
)
from litearm_studio_daemon.session import (
    KEEP_INSPECTED_IMAGES,
    SESSION_FREE_COMMANDS,
    Session,
)


# ------------------------------------------------------------------ 造一份镜像

def _rec(off: int, typ: int, data: bytes) -> str:
    body = bytes([len(data), (off >> 8) & 0xFF, off & 0xFF, typ]) + data
    return ":" + (body + bytes([(-sum(body)) & 0xFF])).hex().upper()


def _ext(upper16: int) -> str:
    return _rec(0, 0x04, bytes([(upper16 >> 8) & 0xFF, upper16 & 0xFF]))


def make_hex(payload: bytes = b"Litearm1.9.0-7J\x00\x00\x00\x00",
             base_hi: int = 0x0800, extra: str = "") -> str:
    """一份起于应用基址的最小合法 Intel HEX（`extra` 用来追加别的地址段）。"""
    lines = [_ext(base_hi)]
    for off in range(0, len(payload), 16):
        lines.append(_rec(off & 0xFFFF, 0x00, payload[off:off + 16]))
    if extra:
        lines.append(extra)
    lines.append(":00000001FF")
    return "\n".join(lines) + "\n"


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def _wait(pred, timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


class _NoEngine:
    """`available()` 为假的引擎 —— 模拟"没装 pyusb / 没有 libusb"。"""

    def available(self) -> bool:
        return False

    def backend_status(self) -> str:
        return "未安装 pyusb (pip install pyusb)"

    def find_device(self):
        return None

    def DfuDevice(self, dev=None, transfer_size=None):  # noqa: N802
        raise AssertionError("引擎不可用时不该被调用")


@pytest.fixture
def engine():
    return fake_engine.FakeEngine(steps=3)


@pytest.fixture
def session(engine):
    """已连上的假会话，升级用注入的假引擎。"""
    s = Session(fake=True, poll_period=0.02, state_push_interval=0.05,
                dfu_engine=engine)
    assert s.connect() is True
    assert _wait(lambda: s.connected), f"假会话没连上: {s.arm_info()}"
    try:
        yield s
    finally:
        s.close()


def _inspect(s: Session, text: str = None, name: str = "fw.hex") -> dict:
    return s.execute("firmware_inspect", {"name": name, "data": b64(text or make_hex())})


# ================================================================== 镜像判据
# 这一组不需要会话 —— `image.inspect` 是纯函数，判据在这里钉死。

def test_a_valid_hex_image_is_summarized_and_32b_aligned() -> None:
    blob, s = dfu.inspect("fw.hex", make_hex().encode())
    assert s.base == dfu.APP_BASE
    assert s.format == "hex"
    assert s.version == "Litearm1.9.0-7J"
    assert s.version_note == ""
    assert len(blob) % 32 == 0, "长度必须补齐到 H7 flash word —— 否则会二次编程坏 ECC"


def test_a_bare_bin_is_accepted_at_the_app_base_and_padded() -> None:
    blob, s = dfu.inspect("fw.bin", b"\x01" * 100)
    assert s.base == dfu.APP_BASE and s.format == "bin"
    assert len(blob) == 128 and len(blob) % 32 == 0
    # 裸 bin 里没有版本串 —— 提取不到是**正常**的，但要说清原因。
    assert s.version is None and "未找到" in s.version_note


@pytest.mark.parametrize("text,reason", [
    # 起于 0x08020000：应用只能烧到 0x08000000
    (_ext(0x0802) + "\n" + _rec(0, 0x00, b"\xAA" * 8) + "\n:00000001FF\n",
     "image_not_at_app_base"),
    # 起于基址但伸进受保护区 (扇区 6 许可证 / 扇区 7 标定)
    (_ext(0x0800) + "\n" + _rec(0, 0x00, b"\xAA" * 8) + "\n"
     + _ext(0x080C) + "\n" + _rec(0, 0x00, b"\xBB" * 8) + "\n:00000001FF\n",
     "image_covers_protected"),
    # 起于基址但越出 1MB
    (_ext(0x0800) + "\n" + _rec(0, 0x00, b"\xAA" * 8) + "\n"
     + _ext(0x0810) + "\n" + _rec(0, 0x00, b"\xBB" * 8) + "\n:00000001FF\n",
     "image_too_large"),
    ("这不是 HEX，也不是 bin\n", "image_unreadable"),
])
def test_unusable_images_are_rejected_with_a_reason(text: str, reason: str) -> None:
    """短码是**界面的判据** —— 文案要分中英文，所以不能靠异常消息选。"""
    with pytest.raises(dfu.ImageError) as ei:
        dfu.inspect("fw.hex", text.encode())
    assert ei.value.reason == reason


def test_the_protected_span_is_rejected_even_when_it_is_the_whole_image() -> None:
    """整份镜像落在受保护区 ⇒ 先撞"基址不对"。两条拦法都对，重点是**不许放过**。"""
    text = _ext(0x080C) + "\n" + _rec(0, 0x00, b"\xAA" * 8) + "\n:00000001FF\n"
    with pytest.raises(dfu.ImageError) as ei:
        dfu.inspect("fw.hex", text.encode())
    assert ei.value.reason in ("image_covers_protected", "image_not_at_app_base")


# ================================================================== 校验命令

def test_inspect_returns_a_token_and_works_without_an_arm_session() -> None:
    """`firmware_inspect` 是**会话无关**的：DFU 期间没有会话，校验仍要能用。"""
    s = Session(fake=True, dfu_engine=fake_engine.FakeEngine())
    try:
        assert "firmware_inspect" in SESSION_FREE_COMMANDS
        out = _inspect(s)                      # 没 connect()
        assert out["token"] and out["base"] == dfu.APP_BASE
        assert out["version"] == "Litearm1.9.0-7J"
        assert len(out["sha256"]) == 64
    finally:
        s.close()


def test_inspect_rejects_bad_base64_and_oversized_payloads(session) -> None:
    with pytest.raises(dfu.ImageError) as ei:
        session.execute("firmware_inspect", {"name": "fw.hex", "data": "!!!not base64!!!"})
    assert ei.value.reason == "image_unreadable"

    with pytest.raises(dfu.ImageError) as ei:
        session.execute("firmware_inspect",
                        {"name": "fw.hex", "data": "A" * (4 * 1024 * 1024 + 4)})
    assert ei.value.reason == "image_too_large"


def test_only_the_last_few_inspected_images_are_kept(session) -> None:
    """上传一份几 MB 的文件不便宜 —— 留几份供"选错了再退回去"，但不许无限攒。"""
    tokens = [_inspect(session, make_hex(base_hi=0x0800))["token"]
              for _ in range(KEEP_INSPECTED_IMAGES + 1)]
    assert len(session._images) == KEEP_INSPECTED_IMAGES
    assert tokens[0] not in session._images


# ================================================================== 开始升级的闸

def test_upgrading_without_confirm_is_refused_before_any_hardware_action(session) -> None:
    token = _inspect(session)["token"]
    with pytest.raises(FirmwareUpgradeError) as ei:
        session.execute("firmware_upgrade", {"token": token})
    assert ei.value.reason == "confirm_required"
    assert session.connected and not session._upgrading


def test_upgrading_an_unknown_token_is_refused(session) -> None:
    with pytest.raises(FirmwareUpgradeError) as ei:
        session.execute("firmware_upgrade", {"token": "nope", "confirm": True})
    assert ei.value.reason == "image_unreadable"


def test_upgrading_without_an_engine_is_refused_before_entering_dfu() -> None:
    """⚠ 必须在**任何硬件动作之前**说清缺什么：等跳进 DFU 才发现没引擎,
    板子已经停在 bootloader 里了, 那种失败最难收场。"""
    s = Session(fake=True, dfu_engine=_NoEngine())
    try:
        assert s.connect() is True and _wait(lambda: s.connected)
        token = _inspect(s)["token"]
        with pytest.raises(FirmwareUpgradeError) as ei:
            s.execute("firmware_upgrade", {"token": token, "confirm": True})
        assert ei.value.reason == "engine_unavailable"
        assert s.connected is True, "拒绝之后会话必须原样可用"
        assert s._upgrading is False
    finally:
        s.close()


def test_upgrading_needs_a_connected_session() -> None:
    s = Session(fake=True, dfu_engine=fake_engine.FakeEngine())
    try:
        with pytest.raises(Exception) as ei:
            s.execute("firmware_upgrade", {"token": "x", "confirm": True})
        assert type(ei.value).__name__ == "NotConnectedCommandError"
    finally:
        s.close()


# ================================================================== 流水线（假件）

def test_a_full_fake_upgrade_walks_every_phase_and_comes_back(session, engine) -> None:
    frames = []
    session.add_listener(frames.append)
    token = _inspect(session)["token"]

    started = session.execute("firmware_upgrade", {"token": token, "confirm": True})
    job = started["job"]
    assert _wait(lambda: any(f.get("t") == "firmware_result" for f in frames))

    phases = [f["phase"] for f in frames if f.get("t") == "firmware_progress"]
    assert phases[0] == dfu.PHASE_VALIDATE
    assert phases[1] == dfu.PHASE_DISARM
    assert phases[2] == dfu.PHASE_ENTER_DFU
    assert phases[3] == dfu.PHASE_WAIT_DFU
    assert phases[-3:] == [dfu.PHASE_DETACH, dfu.PHASE_RECONNECT, dfu.PHASE_DONE]

    result = [f for f in frames if f.get("t") == "firmware_result"][-1]
    assert result["ok"] is True, result
    assert result["job"] == job
    assert result["port"] == "fake"
    # 烧的正是上传的那一份，而且引擎拿到的是"覆盖即拒"的默认策略。
    assert engine.last.written is not None
    assert engine.last.policy == "abort"
    assert engine.last.left is True, "烧完必须让设备离开 DFU"
    # 会话接回来了 —— 新 Arm，不是原来那个（旧的已进终态）。
    assert session.connected is True
    assert session._upgrading is False
    assert session.arm_info()["status"] == "connected"


def test_progress_frames_carry_the_job_id_and_a_size(session) -> None:
    frames = []
    session.add_listener(frames.append)
    token = _inspect(session)["token"]
    job = session.execute("firmware_upgrade",
                          {"token": token, "confirm": True})["job"]
    assert _wait(lambda: any(f.get("t") == "firmware_result" for f in frames))
    progress = [f for f in frames if f.get("t") == "firmware_progress"]
    assert all(f["job"] == job for f in progress)
    writing = [f for f in progress if f["phase"] == dfu.PHASE_FLASH and f["total"]]
    assert writing and writing[-1]["done"] == writing[-1]["total"]


def test_a_flash_failure_is_reported_and_the_device_is_detached() -> None:
    """引擎报错 ⇒ 结果里带短码, 而且**仍然把设备拉出 DFU**。"""
    engine = fake_engine.FakeEngine(steps=2, fail="flash")
    s = Session(fake=True, dfu_engine=engine)
    try:
        assert s.connect() is True and _wait(lambda: s.connected)
        frames = []
        s.add_listener(frames.append)
        token = _inspect(s)["token"]
        s.execute("firmware_upgrade", {"token": token, "confirm": True})
        assert _wait(lambda: any(f.get("t") == "firmware_result" for f in frames))
        result = [f for f in frames if f.get("t") == "firmware_result"][-1]
        assert result["ok"] is False
        assert result["reason"] == "flash_failed"
        assert engine.last.left is True, "失败的板子不许留在 bootloader 里"
    finally:
        s.close()


def test_a_version_mismatch_is_a_warning_not_a_failure(session) -> None:
    """读回校验已经过了 ⇒ 镜像确实写进去了。版本对不上要让人看见, 但不是"升级失败"。"""
    frames = []
    session.add_listener(frames.append)
    # 假设备复位后报 Litearm1.8.0-7J，而镜像里写的是 1.9.0。
    token = _inspect(session, make_hex(b"Litearm1.9.0-7J\x00\x00\x00\x00"))["token"]
    session.execute("firmware_upgrade", {"token": token, "confirm": True})
    assert _wait(lambda: any(f.get("t") == "firmware_result" for f in frames))
    result = [f for f in frames if f.get("t") == "firmware_result"][-1]
    assert result["ok"] is True
    assert "1.9.0" in result["warning"] and "1.8.0" in result["warning"]


# ================================================================== 两条闸

def test_commands_are_refused_while_upgrading(session) -> None:
    """升级把设备交出去了 —— 别的命令要**当场**被拒，而不是排队等一条早已终态的会话。"""
    session._upgrading = True
    try:
        with pytest.raises(UpgradeBusyError):
            session.execute("get_tcp", {})
        with pytest.raises(UpgradeBusyError):
            session.execute("firmware_upgrade", {"token": "x", "confirm": True})
        # 会话无关的几条仍然可用 —— 否则界面连"取消"都点不到。
        assert session.execute("firmware_status", {})["job"] is None
        assert session.execute("firmware_cancel", {})["cancelled"] is True
    finally:
        session._upgrading = False


def test_link_loss_during_an_upgrade_never_starts_self_healing(session) -> None:
    """⚠ 本功能最容易踩的一处。

    设备从 CDC 消失是**我们主动交出去的**。这时起自愈线程去重连，会跟烧录器抢
    同一个 USB 设备，升级必然随机失败 —— 而且现场表现为"偶发"。
    """
    session._upgrading = True
    session._status = "upgrading"           # 与 `_begin_upgrade` 落的状态一致
    arm = session._arm
    try:
        arm._tr.dfu_gone = True                # 桩: 读写都抛 TransportError
        assert session._note_link_lost(arm, "设备消失") is False
        assert session._recovering is False
        assert session._recover_thread is None
        assert session.arm_info()["status"] == "upgrading"
    finally:
        session._upgrading = False
        session._status = "connected"


def test_cancel_before_the_flash_stops_the_pipeline() -> None:
    """取消在相位之间生效 —— 用真流水线验，不靠 `_cancel_upgrade` 的返回值。"""
    engine = fake_engine.FakeEngine(steps=2, step_delay=0.05)
    s = Session(fake=True, dfu_engine=engine)
    try:
        assert s.connect() is True and _wait(lambda: s.connected)
        frames = []
        s.add_listener(frames.append)
        token = _inspect(s)["token"]
        # 一开跑就取消 —— 引擎的 step_delay 让"进 DFU 之前"这个窗口足够宽。
        s.execute("firmware_upgrade", {"token": token, "confirm": True})
        assert s.execute("firmware_cancel", {})["cancelled"] is True
        assert _wait(lambda: any(f.get("t") == "firmware_result" for f in frames))
        result = [f for f in frames if f.get("t") == "firmware_result"][-1]
        # 要么在相位之间被取消，要么已经快到来不及 —— 两者都必须是"没烧"或"烧成功"，
        # 绝不能出现"取消了但结果说成功却什么都没写"。
        assert result["ok"] is False
        assert result["reason"] == "cancelled"
    finally:
        s.close()


def test_status_reports_the_engine_so_the_ui_can_warn_early() -> None:
    s = Session(fake=True, dfu_engine=_NoEngine())
    try:
        st = s.execute("firmware_status", {})
        assert st["engineReady"] is False and "pyusb" in st["engine"]
    finally:
        s.close()
