"""`dfu/engine.py` 的擦除、读回校验与"擦回空白"三条恢复路径。

为什么在 **USB 控制传输**这一层造假件, 而不是用 `dfu.fake` 那个假引擎: 后者替换的是整个
引擎 (`FakeDfuDevice.flash` 收下 `erase`/`verify` 就返回), 而这三条路正是历史砖机 bug 的
所在 (`engine.py` 里每条注释都记着代价), 也是 `skip` 策略许诺"扇区 6+7 原样保留"的地方。
要测它们, 就得让**真的** `flash()` 跑起来 —— 只有 USB 那根线是假的。

两处刻意的"不真实", 都不影响被测的判据:

* **时间**: `_wait` 每块至少睡 5 ms, 而 `erase_sector_verified` 用**墙钟**量擦除时长
  (下界 0.15 s)。换成虚拟时钟之后两条判据一条不少地跑, 整套用例不到一秒 —— 真机上那是
  实测钉住的 (见 `ERASE_MIN_BUSY_S` 的注释)。
* **几何**: 按真机 (1 MiB、128 KiB 扇区) 的话, 一段跨进受保护区的镜像要 700+ KiB, 而
  `skip` 的第二段还得再往 flash 之外延伸才非空 —— 于是把扇区缩到 8 KiB、受保护区缩到
  16 KiB。判据与真机同形 (两个受保护扇区、保护区前一段、后一段), 用例只需几十 KiB。
"""
from __future__ import annotations

import pathlib
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from litearm_studio_daemon.dfu import engine  # noqa: E402

FLASH_BASE = engine.FLASH_BASE
SECTOR = 0x2000                       # 8 KiB, 真机是 128 KiB (见文件头)
LICENCE = FLASH_BASE + 6 * SECTOR     # 扇区 6 起 = 受保护区起
CALIB = FLASH_BASE + 7 * SECTOR
PROTECTED_END = FLASH_BASE + 8 * SECTOR

#: 许可证的魔术字 (`engine.py` 的扇区 6 说明), 用它证明那一段有没有被动过。
LICENCE_BYTES = b"LTC1" + b"\x00" * 60
CALIB_BYTES = b"\xa5" * 64

#: 镜像: 从应用基址起, 跨过整个受保护区之后**再写 8 KiB** —— 第二段非空, "分两段绕开"
#: 才真的发生 (镜像正好停在保护区尾的话只剩一段, 测的就不是"绕开")。
IMAGE = bytes((i * 7 + 3) & 0xFF for i in range(PROTECTED_END - FLASH_BASE + 0x2000))


class Clock:
    """虚拟时钟 —— 引擎只看 `time.sleep` / `time.perf_counter`。"""

    def __init__(self) -> None:
        self.now = 0.0

    def sleep(self, seconds: float) -> None:
        self.now += max(0.0, float(seconds))

    def perf_counter(self) -> float:
        return self.now

    def monotonic(self) -> float:
        return self.now


@pytest.fixture(autouse=True)
def clock(monkeypatch) -> Clock:
    """把引擎看到的时间换成虚拟的 (判据一条不动, 只是不用真等)。"""
    fake = Clock()
    monkeypatch.setattr(engine, "time", SimpleNamespace(
        sleep=fake.sleep, perf_counter=fake.perf_counter, monotonic=fake.monotonic))
    return fake


@pytest.fixture(autouse=True)
def geometry(monkeypatch) -> None:
    """把几何缩到 8 KiB 扇区 (见文件头); monkeypatch 会在用例结束后还原。"""
    monkeypatch.setattr(engine, "SECTOR_SIZE", SECTOR)
    monkeypatch.setattr(engine, "LICENSE_SECTOR_START", LICENCE)
    monkeypatch.setattr(engine, "LICENSE_SECTOR_END", CALIB)
    monkeypatch.setattr(engine, "PARAM_SECTOR_START", CALIB)
    monkeypatch.setattr(engine, "PARAM_SECTOR_END", PROTECTED_END)
    monkeypatch.setattr(engine, "PARAM_SECTOR_SIZE", SECTOR)
    monkeypatch.setattr(engine, "PROTECTED_START", LICENCE)
    monkeypatch.setattr(engine, "PROTECTED_END", PROTECTED_END)
    monkeypatch.setattr(engine, "PROTECTED_SIZE", 2 * SECTOR)


class FakeFlash:
    """一块 STM32 的内部 flash, 挂在 DFU 控制传输上。

    只实现引擎用到的那几条请求: GETSTATUS / DNLOAD / UPLOAD / CLRSTATUS / ABORT /
    DETACH, 以及 DfuSe 的三条特殊命令 (Set Address、Erase、数据块)。

    ⚠ 两件事必须"真": ERASE **真的把扇区擦成 0xFF**, 而且**擦得慢** —— 引擎的
      `erase_sector_verified` 正是靠忙时长与读回这两条判据识破"擦除静默失效"的
      (2026-09-29 那次砖: wBlockNum 写错时设备只忙 11 ms 而一个字节没擦)。
    """

    def __init__(self, erase_seconds: float = 0.2) -> None:
        self.mem = bytearray(b"\xff" * (PROTECTED_END - FLASH_BASE + 0x4000))
        self.erase_seconds = erase_seconds
        self.ptr = 0
        self.upload_ptr = 0
        self.busy_until = 0.0
        self.writes = 0
        #: 注入: 第 N 次数据块写之后抛错 (模拟写中途断链)。
        self.fail_after_writes: int | None = None
        #: 注入: 这一个地址的读回与写进去的不同 (模拟 ECC 坏字)。**只生效一次**, 且只在
        #: 写过之后 —— 擦除阶段的读回也要准, 否则测的就不是"写坏了被读回抓到"。
        self.corrupt_addr: int | None = None
        self.upload_ok = True
        self.detached = 0
        self.erased: list[int] = []

    # ---- 测试用的直接访问 ----
    def at(self, addr: int) -> bytes:
        start = addr - FLASH_BASE
        return bytes(self.mem[start:start + 64])

    def fill(self, addr: int, blob: bytes) -> None:
        start = addr - FLASH_BASE
        self.mem[start:start + len(blob)] = blob

    def _erase(self, addr: int) -> None:
        sector = FLASH_BASE + ((addr - FLASH_BASE) // SECTOR) * SECTOR
        start = sector - FLASH_BASE
        self.mem[start:start + SECTOR] = b"\xff" * SECTOR
        self.erased.append(sector)
        self.busy_until = engine.time.monotonic() + self.erase_seconds

    # ---- USB ----
    def set_configuration(self, *args, **kwargs) -> None:          # `open()` 会调
        pass

    def set_interface_altsetting(self, *args, **kwargs) -> None:
        pass

    def ctrl_transfer(self, bm_request_type, request, value, index, data=None,
                      timeout=0):
        if request == engine.DFU_GETSTATUS:
            busy = engine.time.monotonic() < self.busy_until
            remaining = max(0, int((self.busy_until - engine.time.monotonic()) * 1000))
            state = engine.DFU_STATE_DNBUSY if busy else engine.DFU_STATE_DFU_IDLE
            return bytes([0, remaining & 0xFF, (remaining >> 8) & 0xFF,
                          (remaining >> 16) & 0xFF, state, 0])
        if request in (engine.DFU_CLRSTATUS, engine.DFU_ABORT):
            self.busy_until = 0.0
            return None
        if request == engine.DFU_DETACH:
            self.detached += 1
            return None
        if request == engine.DFU_DNLOAD:
            return self._dnload(value, bytes(data or b""))
        if request == engine.DFU_UPLOAD:
            if not self.upload_ok or value == 1:                   # 块 1 是保留槽
                raise usb_error()
            return self._upload(int(data))
        raise usb_error()

    def _upload(self, want: int) -> bytes:
        start = self.upload_ptr - FLASH_BASE
        chunk = bytes(self.mem[start:start + want])
        if self.corrupt_addr is not None and self.writes:
            bad = self.corrupt_addr - self.upload_ptr
            if 0 <= bad < len(chunk):
                chunk = chunk[:bad] + bytes([chunk[bad] ^ 0xFF]) + chunk[bad + 1:]
                self.corrupt_addr = None                           # 一次性
        self.upload_ptr += len(chunk)
        return chunk

    def _dnload(self, block: int, data: bytes):
        if block == engine.WBLOCK_SET_ADDRESS and data:
            if data[0] == engine.DFUSE_SET_ADDRESS:
                self.ptr = int.from_bytes(data[1:5], "little")
                self.upload_ptr = self.ptr
                return None
            if data[0] == engine.DFUSE_ERASE:
                self._erase(int.from_bytes(data[1:5], "little"))
                return None
        if block >= engine.WBLOCK_DATA0:
            self.writes += 1
            if self.fail_after_writes is not None and self.writes > self.fail_after_writes:
                raise engine.DfuError("注入: 写中断")
            start = self.ptr - FLASH_BASE
            self.mem[start:start + len(data)] = data
            self.ptr += len(data)
            return None
        if not data:
            return None                                            # 零长度 DNLOAD = manifest
        raise usb_error()


def usb_error() -> Exception:
    """一条与引擎 `except usb.core.USBError` 同形的异常 (pyusb 缺席时也要能跑)。"""
    if getattr(engine, "_HAVE_PYUSB", False):
        return engine.usb.core.USBError("桩: 管道错误")
    return engine.DfuError("桩: 管道错误")


def open_device(**kwargs) -> tuple[engine.DfuDevice, FakeFlash]:
    flash = FakeFlash(**kwargs)
    return engine.DfuDevice(flash, transfer_size=1024), flash


def write_licence(flash: FakeFlash) -> None:
    flash.fill(LICENCE, LICENCE_BYTES)
    flash.fill(CALIB, CALIB_BYTES)


# --------------------------------------------------------------- 成功路径与 skip


def test_skip_writes_around_the_protected_sectors_and_leaves_them_intact() -> None:
    """`skip` 的许诺: 擦除避开扇区 6+7, 写入分两段绕开, 两者**原样保留**。"""
    device, flash = open_device()
    write_licence(flash)

    device.flash(IMAGE, FLASH_BASE, param_policy=engine.PARAM_POLICY_SKIP)

    assert flash.at(LICENCE)[:4] == b"LTC1"
    assert flash.at(CALIB)[:2] == b"\xa5\xa5"
    # 两段都真的写了: 第一段的头, 以及跳过保护区之后的第一个字节。
    assert flash.at(FLASH_BASE)[:8] == IMAGE[:8]
    assert flash.at(PROTECTED_END)[:8] == IMAGE[2 * SECTOR:2 * SECTOR + 8]
    # 两个受保护扇区一次都没进过擦除列表。
    assert LICENCE not in flash.erased and CALIB not in flash.erased


def test_abort_refuses_a_covering_image_before_touching_the_device() -> None:
    """默认策略: 覆盖受保护区就**拒绝烧录**, 且一个字节都还没发出去。"""
    device, flash = open_device()

    with pytest.raises(engine.DfuError, match="受保护扇区"):
        device.flash(IMAGE, FLASH_BASE)

    assert flash.writes == 0 and flash.erased == []


# ------------------------------------------- `base` 落在受保护区内 (issue #211)


def test_skip_from_inside_the_protected_area_writes_nothing_there() -> None:
    """`base` 落在受保护区内、镜像也没伸出保护区: 拒绝, 且一个字节都不碰设备。

    旧分段用 `cut = PROTECTED_START - base` 切片: base 一旦**在保护区内**, cut 就是
    负数, `blob[:cut]` 变成"除尾部 |cut| 字节以外的全部", 而它仍被写在 `base` 上 ——
    写进扇区 6/7 并顺手把它们擦掉, 而两者只存在于设备。地址算法下这里没有可烧的内容。
    """
    device, flash = open_device()
    write_licence(flash)

    with pytest.raises(engine.DfuError, match="没有可烧的内容"):
        device.flash(b"\xff" * 1024, engine.PROTECTED_START + 0x20,
                     param_policy=engine.PARAM_POLICY_SKIP)

    assert flash.writes == 0 and flash.erased == []
    assert flash.at(LICENCE)[:4] == b"LTC1"
    assert flash.at(CALIB)[:2] == b"\xa5\xa5"


def test_skip_from_inside_the_protected_area_writes_only_the_tail_after_it() -> None:
    """`base` 在保护区内、镜像又伸出保护区之外: 只写保护区**之后**那一段。

    写出去的字节必须落在它**自己的地址**上: 伸出保护区的那部分挪到 `PROTECTED_END`,
    而不是接着 `base` 顺序发下去 (那样写的是受保护扇区)。
    """
    device, flash = open_device()
    write_licence(flash)
    base = engine.PROTECTED_START + 0x20                  # 32B 对齐, 落在保护区内
    tail_bytes = 0x800
    blob = bytes((i * 5 + 1) & 0xFF for i in range(engine.PROTECTED_END - base + tail_bytes))

    device.flash(blob, base, param_policy=engine.PARAM_POLICY_SKIP)

    assert flash.writes > 0
    # 保护区之后的第一个字节 = 镜像里地址为 PROTECTED_END 的那个字节。
    assert flash.at(engine.PROTECTED_END)[:8] == blob[len(blob) - tail_bytes:
                                                      len(blob) - tail_bytes + 8]
    assert flash.at(LICENCE)[:4] == b"LTC1"
    assert flash.at(CALIB)[:2] == b"\xa5\xa5"
    assert LICENCE not in flash.erased and CALIB not in flash.erased


def test_erasing_a_protected_sector_needs_an_explicit_opt_in() -> None:
    """擦除的唯一收口处 fail-closed: 没有 `wipe` 授权就拒绝碰扇区 6/7。

    分段算错这一类缺陷挡不完 (这一次是 `cut` 为负, 下一次可能是别的算法), 所以闸放在
    唯一收口处: 最坏的结果是烧录失败, 而不是许可证与标定被安静地擦掉。
    """
    device, flash = open_device()
    write_licence(flash)

    with pytest.raises(engine.DfuError, match="受保护区内"):
        device.erase_sectors_covering(engine.PROTECTED_START, 0x20)

    assert flash.erased == []
    # 显式授权 (`wipe` 走的就是这条) 才允许 —— 否则这条路本身也没法用了。
    device.erase_sectors_covering(engine.PROTECTED_START, 0x20, allow_protected=True)
    assert LICENCE in flash.erased


def test_wipe_still_erases_the_protected_sectors_it_was_asked_to() -> None:
    """`wipe` 的许诺没被守卫一起拦掉: 说好了连扇区 6+7 一起擦, 那就得擦得掉。

    守卫加在唯一收口处, 最容易失手的方式是"把 wipe 也拦了" —— 于是许可证与标定成了
    谁也写不了的孤岛, 而这条路存在的意义正是"我确认两者都不要了"。
    """
    device, flash = open_device()
    write_licence(flash)

    device.flash(IMAGE, FLASH_BASE, param_policy=engine.PARAM_POLICY_WIPE)

    assert LICENCE in flash.erased and CALIB in flash.erased
    assert flash.at(FLASH_BASE)[:8] == IMAGE[:8]
    assert flash.at(engine.PROTECTED_END)[:8] == IMAGE[2 * SECTOR:2 * SECTOR + 8]


# --------------------------------------------------------- 三条"擦回空白"恢复路径


def test_a_write_failure_does_not_erase_the_protected_sectors() -> None:
    """写中途失败 ⇒ 擦回空白, 但**只擦这次写过的那两段**。

    这正是 `skip` 策略最坏的失效方式: 恢复擦除按 `base, total` 一把擦过去, 会把许可证与
    出厂标定一起擦掉 —— 而它们只存在于设备、擦掉不可恢复, 日志却只说"已擦回空白 ⇒ 板子
    未砖"。板子确实没砖, 设备侧的身份与标定没了。
    """
    device, flash = open_device()
    write_licence(flash)
    # 第一段 (受保护区之前) 写完、第二段写到一半时断链。
    first_segment_blocks = (LICENCE - FLASH_BASE) // 1024
    flash.fail_after_writes = first_segment_blocks + 2

    with pytest.raises(engine.DfuError, match="注入"):
        device.flash(IMAGE, FLASH_BASE, param_policy=engine.PARAM_POLICY_SKIP)

    assert flash.at(LICENCE)[:4] == b"LTC1", "许可证被恢复擦除擦掉了"
    assert flash.at(CALIB)[:2] == b"\xa5\xa5", "标定扇区被恢复擦除擦掉了"
    # 写过的两段确实擦回了空白 —— 半写状态不能留。
    assert flash.at(FLASH_BASE)[:64] == b"\xff" * 64
    assert flash.at(PROTECTED_END)[:64] == b"\xff" * 64


def test_a_read_back_mismatch_blanks_what_it_wrote() -> None:
    """读回不一致 ⇒ 擦回空白并如实报告 (擦回空白 = 板子还能用 USB DFU 重烧)。"""
    device, flash = open_device()
    write_licence(flash)
    flash.corrupt_addr = FLASH_BASE + 0x100

    with pytest.raises(engine.DfuError, match="读回校验失败") as caught:
        device.flash(IMAGE, FLASH_BASE, param_policy=engine.PARAM_POLICY_SKIP)

    assert f"0x{FLASH_BASE + 0x100:08X}" in str(caught.value)
    assert flash.at(FLASH_BASE)[:64] == b"\xff" * 64
    assert flash.at(PROTECTED_END)[:64] == b"\xff" * 64
    assert flash.at(LICENCE)[:4] == b"LTC1"
    assert flash.at(CALIB)[:2] == b"\xa5\xa5"


def test_an_upload_that_stops_working_after_it_worked_is_a_failure_not_a_warning() -> None:
    """UPLOAD 之前能用、此刻读不回 ⇒ 按**校验失败**处理 (擦回空白), 不是"本机不支持"。

    旧写法把这条一律降级成告警, 于是恰好把它本该捕获的那个故障吞掉: 烧坏 → UPLOAD 失败
    → 当成"不支持" → 不擦回空白 → 板子留在 ECC 已坏的状态 ⇒ 只能上 SWD。
    """
    device, flash = open_device()
    write_licence(flash)
    real_upload = flash._upload

    # 两段一共写这么多块 (第一段 = 保护区之前, 第二段 = 保护区之后)。
    written_blocks = ((LICENCE - FLASH_BASE) + (len(IMAGE) - (PROTECTED_END - FLASH_BASE))) // 1024

    def failing_upload(want: int) -> bytes:
        # ⚠ 只在**全部写完之后**才读不回: 擦除阶段那几次读回是"UPLOAD 本来可用"的证据,
        #   少了它这条用例就退化成"本机不支持 UPLOAD"那条分支 —— 测不到要测的东西。
        if flash.writes >= written_blocks:
            raise usb_error()
        return real_upload(want)

    flash._upload = failing_upload

    with pytest.raises(engine.DfuError, match="读回校验失败"):
        device.flash(IMAGE, FLASH_BASE, param_policy=engine.PARAM_POLICY_SKIP)

    assert flash.at(FLASH_BASE)[:64] == b"\xff" * 64
    assert flash.at(LICENCE)[:4] == b"LTC1"


# ------------------------------------------------------------------ 擦除判据本身


def test_a_fake_erase_is_refused_by_the_busy_time_floor() -> None:
    """擦除只忙了 11 ms ⇒ 判定为没擦, **拒绝继续编程**。

    2026-09-29 那场砖的根因就是"擦除静默失效"(ERASE 的 wBlockNum 误用 1): 设备回
    bStatus=0 却一个字没擦, 主机随后往还有旧固件的扇区写新镜像 ⇒ 二次编程 ⇒ ECC 坏字。
    """
    device, _ = open_device(erase_seconds=0.01)

    with pytest.raises(engine.DfuError, match="拒绝继续编程"):
        device.flash(b"\x00" * 4096, FLASH_BASE)


def test_a_sector_that_stays_non_blank_is_refused() -> None:
    """擦除后扇区里还剩非 0xFF 字节 ⇒ 拒绝继续 (等 ~30 s 之后报错)。"""
    device, flash = open_device()
    real = flash.ctrl_transfer

    def never_blank(bm_request_type, request, value, index, data=None, timeout=0):
        if request == engine.DFU_UPLOAD:
            return b"\x00" * int(data)
        return real(bm_request_type, request, value, index, data, timeout)

    flash.ctrl_transfer = never_blank

    with pytest.raises(engine.DfuError, match="仍有非 0xFF 字节"):
        device.flash(b"\x00" * 4096, FLASH_BASE)
