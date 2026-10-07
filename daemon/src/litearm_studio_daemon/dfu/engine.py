#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DfuSe 烧录引擎 —— 用 pyusb 直接实现 STM32 ROM bootloader 的 USB-DFU 烧录。

来源与搬运说明
-------------
本文件**逐字搬运**自上游工具仓 `gitee.com/yudao_hz_1/dfu-flash`（HEAD `2dc3fb5`，
文件 `dfu_usb.py`，搬运日期 2026-10-06）。只做了两处**非逻辑**改动：

* 顶部这段出处说明；
* 订正原文件末尾关于 `DFU_UPLOAD` 的**陈旧结论**（见下）。

**逻辑一行未改。** 里面每一条注释都是真机烧砖换来的：DfuSe 特殊命令的
`wBlockNum`、32 B flash word 对齐、擦除忙时长下界、相位切换。要改这里的行为，
请**回改上游仓**，不要在本仓就地发明 —— 否则两边的时序会漂移，而漂移的代价是砖机。

为什么不用 dfu-util / STM32CubeProgrammer
----------------------------------------
这样上位机就**只依赖 Python + pyusb**, 目标机上不必再装 ST 的工具链。

实测描述符 (STM32H723VGT6 的 ROM bootloader)
-------------------------------------------
  idVendor=0x0483 idProduct=0xDF11  bcdDevice=0x0200
  Product = "DFU in FS Mode";  Serial 与板载 CDC 相同 (同一根 USB 线)
  alt=0 内部 Flash / alt=1 另一片内存;  bNumEndpoints=0 (走控制传输)
  ★ DFU 功能描述符: bmAttributes=0x0B  wDetachTimeOut=255ms
                    wTransferSize=1024   bcdDFUVersion=0x011A (DfuSe 扩展)

DfuSe 协议要点 (与标准 DFU 1.1 的区别)
--------------------------------------
  · 特殊命令全部用 **wBlockNum = 0**, 靠**载荷首字节**区分:
        Set Address Pointer: 载荷 = 0x21 + 4B 地址(LE)
        Erase:               载荷 = 0x41 + 4B 地址(LE)
        Read Unprotect:      载荷 = 0x92 (+ 4B 0)
    ⚠⚠ **它们不是各占一个块号。** 本文件曾把 Erase 写成 `wBlockNum = 1`
    (标题为"0=SetAddress、1=Erase"的想当然), 后果是**擦除静默失效**:
    ROM 只忙 11 ms 就回 bStatus=0x00 "成功", 而 128KB 扇区一个字节没擦
    ⇒ 往未擦除的扇区写新镜像 ⇒ 二次编程 ⇒ ECC 坏字 ⇒ 砖机。
    2026-09-29 实测: wBlockNum=0 时忙 1865 ms 且扇区真的全变 0xFF。
  · **数据块从 wBlockNum=2 开始编号**, 逐块 +1 (这条实测有效)
  · 每发一条命令都要 GETSTATUS 并等 bwPollTimeout 毫秒
  · 全部数据发完 → 发一个**零长度 DNLOAD** 表示结束 → GETSTATUS
  · 擦除是**按扇区**的: 传该扇区内的任一地址即可

读回校验 (DFU_UPLOAD)
--------------------
**本板 ROM bootloader 支持 `DFU_UPLOAD`** —— 原文件此处曾写"实测不支持"，那是
2026-09-29 之前的误判：真因是漏发了 DNLOAD↔UPLOAD 相位切换用的 `DFU_CLRSTATUS`
(见 `clr_status` 与 `read_back`)。修好后实测
`✓ 读回校验通过 (103840 B 逐字节一致)`，`flash(verify=True)` 因此**真的会校验**。

⇒ 本引擎**能自证烧录结果**：写坏了当场发现，并触发"擦回空白"保护。
`flash()` 失败时抛出，调用方看到的是一句可执行的报告，不是"可能成功了"。
"""

from __future__ import annotations

import time
from typing import Callable

try:
    import usb.core
    import usb.util
    _HAVE_PYUSB = True
except ImportError:                                            # pragma: no cover
    _HAVE_PYUSB = False

# ---- DFU 常量 ----
VID, PID = 0x0483, 0xDF11
BMREQ_OUT = 0x21            # host->device, class, interface
BMREQ_IN = 0xA1             # device->host, class, interface

DFU_DETACH = 0
DFU_DNLOAD = 1
DFU_UPLOAD = 2
DFU_GETSTATUS = 3
DFU_CLRSTATUS = 4
DFU_GETSTATE = 5
DFU_ABORT = 6

# DFU 状态机 bState (DFU 1.1 规范)
DFU_STATE_APP_IDLE = 0
DFU_STATE_DFU_IDLE = 2
DFU_STATE_DNLOAD_SYNC = 3   # 收到 DNLOAD 后、真正开写之前的过渡态 (易被漏判!)
DFU_STATE_DNBUSY = 4        # 设备正在写/擦, 期间发新命令会被 STALL
DFU_STATE_DNLOAD_IDLE = 5   # 写完了 —— 到这里才安全发下一块
DFU_STATE_MANIFEST = 7
DFU_STATE_ERROR = 10        # 处于此状态时用 DFU_CLRSTATUS 恢复

# ⚠ 设备"还在干活"的状态集合。这两个状态下上一块数据**尚未落盘**,
# 提前放行会让相邻两块写操作重叠 → 对同一批 flash word 重复编程 →
# H7 直接产生 ECC 双比特错误 (FLASH_SR1.DBECCERR) → 板子砖掉。
# ★ 2026-09-23 修复: 旧判据写作 `state != DFU_STATE_DNBUSY`, **漏掉了
#   SYNC(3)**。DFU 1.1 的状态序列是 2 → 3 → 4 → 5, 在 3 处就提前返回了。
#   实测后果: 用旧代码烧 ctrboard-fw.hex (101280 B) 后 flash 出现 4 个
#   DBECCERR 坏 word (0x08000000/0x20/0x40/0x1000), 其中含向量表首字 ⇒
#   CPU 取不到 MSP/Reset 直接卡死, 表现就是"烧完 USB 口就没了"。
#   同一镜像改用 SWD (pyocd) 烧录: 0 坏 word。⇒ 根因在 DFU 这条路径。
_BUSY_STATES = (DFU_STATE_DNLOAD_SYNC, DFU_STATE_DNBUSY)

# H7 的 Flash 编程单位 (flash word = 256 bit = 32 B)。
# 数据长度/起始地址不对齐时, ROM bootloader 需做 read-modify-write,
# 而目标 word 若已被本轮写过就会二次编程 → 同样破坏 ECC。故强制对齐。
FLASH_WORD = 32

# DfuSe 特殊命令码
DFUSE_SET_ADDRESS = 0x21
DFUSE_ERASE = 0x41
DFUSE_UNPROTECT = 0x92

# ⚠⚠ DfuSe 的特殊命令(SET_ADDRESS 0x21 / ERASE 0x41 / READ_UNPROTECT 0x92)
#   **都用 wBlockNum = 0**, 靠**载荷首字节**区分 —— 不是各占一个块号。
#   `WBLOCK_ERASE` 原为 1(沿用了"0=SetAddress、1=Erase"的想当然), 后果极其严重:
#   2026-09-29 实测 wBlockNum=1 的 ERASE 是**静默空操作** —— 设备只忙 **11 ms**
#   就回 `bStatus=0x00`(成功), 而 128KB 扇区**一个字节都没擦**; 改成 0 后设备
#   忙 **1865 ms** 且扇区真的变全 0xFF。← 这就是"dfu-flasher 更新固件必砖"的根因:
#   擦除没发生 → 往**还有旧固件**的扇区写新镜像 → 新旧不同的 32B flash word 被
#   **二次编程** → ECC 坏字散布整个扇区 → 砖。
#   (工具注释里那句"省掉擦除前那次 Set Address, 擦除会返回 bStatus=0 但实际没擦",
#    撞见的就是这个 bug, 但归因错了, 靠多加一次 Set Address 绕过去 —— 没修到根。)
WBLOCK_SET_ADDRESS = 0
WBLOCK_ERASE = 0            # ⚠ 必须是 0 (曾误为 1, 导致擦除静默失效 → 烧砖)
WBLOCK_UNPROTECT = 0        # 同上, 协议一致 (本工具未调用; 未单独实测)
WBLOCK_DATA0 = 2            # 数据块从 2 开始 (实测有效, 不要动)

# 一次**真实**擦除的下界(秒)。128KB 扇区实测 1.865 s; 而 wBlockNum 写错时的
# "假擦除"只忙 ~0.011 s。取 0.15 s 作判据 —— 不依赖 DFU_UPLOAD, 也不需要外部工具,
# 却能当场识破"擦除其实没发生"。fail-closed: 低于下界即拒绝继续编程。
ERASE_MIN_BUSY_S = 0.15

FLASH_BASE = 0x08000000
SECTOR_SIZE = 0x20000       # H723: 8 x 128KB, 单 bank

# ⚠ 2026-09-29 记: 这里**曾经**放过一个 `ERASE_FALLBACK_WAIT_S = 8.0`(UPLOAD 不可用时
#   在擦除后固定等 8 秒)。**那是错的, 不要再加回来** —— 它的假设是"擦除提前放行",
#   而实测真相是**原生 DfuSe ERASE 根本没擦**(静默空操作, 报 bStatus=0x00)。
#   等再久也等不来一个不会发生的擦除。真正的修法是把它**擦成功**: 见 WBLOCK_ERASE
#   (0 而非 1), 外加 erase_sector_verified() 的"忙时长下界"闸。
#   ⚠ 也不要改成"交给外部 STM32_Programmer_CLI 擦" —— 那会引入对 CubeProgrammer
#     的依赖, 而本工具的设计前提是**只依赖 Python + pyusb**(Windows/Linux 同一套)。

# ---- 受保护扇区: 扇区 6 (许可证) 与 扇区 7 (标定参数) ----
# 两者都是**设备侧状态**, 都不在源码里, 擦掉都不可恢复:
#   · 扇区 6 @ 0x080C0000 — 许可证记录 (64 B, magic "LTC1")。擦掉 = 未激活,
#     而激活需要凭据 + 上位机; 现场等于"设备变砖一半"。
#   · 扇区 7 @ 0x080E0000 — 本工程 flash_store 标定参数。
#     ⚠ 2026-09-23 复核发现: 摩擦前馈等**已标定参数只存在于设备这一扇区里** ——
#       仓库 `params/defaults.c` 的默认值与设备实际值**不同**(例: J2 fc0 2.2810 vs 1.2396),
#       即"修复态"是标定进 Flash 的, 不在源码里。**擦掉就退回未修状态且不可恢复。**
# ⚠ 2026-09-28: 保护区由"仅扇区 7"扩为 **扇区 6+7 连续一块** (用户要求:
#   "必须跳过扇区6、7烧录")。原实现只护扇区 7, 扇区 6 无任何保护 —— 那是缺口:
#   许可证与标定同样只存在于设备。两扇区物理相邻 (0x080C0000..0x08100000, 256KB),
#   故按**连续一块**处理, 分段/擦除一并对齐。
# 本模块默认**拒绝**覆盖该区; 用 flash(param_policy=...) 选 "skip"(跳过)
# 或 "wipe"(连它一起擦)。三种策略见下方 PARAM_POLICY_* 。
LICENSE_SECTOR_START = 0x080C0000    # 扇区 6 起始
LICENSE_SECTOR_END   = 0x080E0000    # 扇区 6 结束(= 扇区 7 起始)
PARAM_SECTOR_START = 0x080E0000      # 扇区 7 起始
PARAM_SECTOR_END   = 0x08100000      # 扇区 7 结束(= 1MB Flash 末)
PARAM_SECTOR_SIZE  = PARAM_SECTOR_END - PARAM_SECTOR_START

# 受保护区 = 扇区 6 + 扇区 7 (连续)。**所有拦截/分段判据一律用这组**。
PROTECTED_START = LICENSE_SECTOR_START
PROTECTED_END   = PARAM_SECTOR_END
PROTECTED_SIZE  = PROTECTED_END - PROTECTED_START

# 镜像覆盖受保护区时的三种策略 (2026-09-23 引入, 09-28 扩到扇区 6+7)。
# 由 `flash(param_policy=...)` 选择; 默认 ABORT —— 最保守, 不会漏掉参数。
PARAM_POLICY_ABORT = "abort"    # 默认: 覆盖即拒绝, 要求调用方显式选 skip 或 wipe
PARAM_POLICY_SKIP  = "skip"     # 跳过扇区 6+7: 只烧其余部分, 许可证与参数原样保留
PARAM_POLICY_WIPE  = "wipe"     # 连扇区 6+7 一起擦写 (明确的"许可证和参数都不要了")
PARAM_POLICIES = (PARAM_POLICY_ABORT, PARAM_POLICY_SKIP, PARAM_POLICY_WIPE)

DETACH_TIMEOUT_MS = 255


class DfuError(Exception):
    pass


# --------------------------------------------------------------------------
# libusb 后端
# --------------------------------------------------------------------------
_backend = None
_backend_label = "未解析"
_backend_resolved = False


def _load_backend():
    """
    找一个可用的 libusb 后端, 返回 (backend, 说明); 都没有则 (None, 原因)。

    ⚠ 实测教训 (2026-09-15, 本机 Win11 + Python 3.13 + pyusb 1.3.1):
    **不能依赖 pyusb 的自动后端选择。** Windows 上 pyusb 靠
    ctypes.util.find_library('usb-1.0') 找 libusb-1.0.dll, 而 ctypes 在 Windows
    只查系统目录 —— 返回 None, 于是 pyusb **静默地没有后端**:
        usb.backend.libusb1.get_backend()  -> None
        usb.core.find(...)                 -> None / []   ← 看着像"设备不在"
    同一时刻实测:
        libusb_package.get_libusb1_backend() -> 可用, 枚举出 10 个设备 (含本板)
    所以**优先用 libusb-package**: 它自带 DLL 且按绝对路径加载, 不看 PATH。

    症状: GUI (走 pyusb) 报"未发现设备", 而 CLI (走 PowerShell) 报"已在 DFU"
    —— 两边矛盾, 且板子其实就在 DFU 模式。烧录会因此彻底不可用。
    """
    # 1) libusb-package —— 自带 DLL, Windows 上最可靠
    try:
        import libusb_package
        be = libusb_package.get_libusb1_backend()
        if be is not None:
            try:
                return be, f"libusb-package: {libusb_package.get_library_path()}"
            except Exception:                                  # noqa: BLE001
                return be, "libusb-package"
    except Exception:                                          # noqa: BLE001
        pass
    # 2) pyusb 自带查找 —— DLL 在 PATH/系统目录时有效; Linux 走这条
    try:
        be = usb.backend.libusb1.get_backend()
        if be is not None:
            return be, "pyusb 自带 libusb"
    except Exception:                                          # noqa: BLE001
        pass
    return None, "找不到 libusb 后端 (pip install libusb-package)"


def get_backend():
    """带缓存 —— GUI 每秒都调 find_device(), 不必反复解析"""
    global _backend, _backend_label, _backend_resolved
    if not _backend_resolved:
        _backend_resolved = True
        if _HAVE_PYUSB:
            _backend, _backend_label = _load_backend()
    return _backend


def backend_status() -> str:
    """后端诊断串, 供 GUI/CLI 显示"""
    if not _HAVE_PYUSB:
        return "未安装 pyusb (pip install pyusb)"
    get_backend()
    return _backend_label


def available() -> bool:
    """pyusb 装上 **且** libusb 后端可用, 才算能烧录"""
    return _HAVE_PYUSB and get_backend() is not None


def find_device():
    """返回 DFU 设备对象, 没有则 None"""
    if not _HAVE_PYUSB:
        return None
    return usb.core.find(idVendor=VID, idProduct=PID, backend=get_backend())


class DfuDevice:
    """一个已打开的 DFU 设备会话。用 with 或显式 close()。"""

    def __init__(self, dev=None, transfer_size: int | None = None):
        self.dev = dev or find_device()
        if self.dev is None:
            raise DfuError("找不到 DFU 设备 (VID:PID = 0483:DF11) —— 芯片是否已进入 bootloader?")
        self.transfer_size = transfer_size or self._read_transfer_size()
        # [2026-09-28 加固] 块大小必须是 flash word 的整数倍。
        # 理由: _flash_range 按 transfer_size 切连续块。若它**不是** 32B 的整数倍,
        #   每个块的**末尾会切在 flash word 中间** ⇒ ROM bootloader 必须对该字做
        #   read-modify-write, 而**下一个块又从同一个字开始** ⇒ 该字被编程两次 ⇒
        #   H7 ECC 直接损坏 (FLASH_SR1.DBECCERR) → 砖机。与"blob 未对齐"是同一
        #   故障模式, 只是发生在**块边界**而不是镜像首尾。
        # ⚠ 本板 wTransferSize=1024 (= 32×32) 本来就对齐, 故这是**纵深防线**:
        #   换型号/换 bootloader 报别的值时, 这里会当场拒绝而不是安静地烧出砖头。
        if self.transfer_size <= 0 or self.transfer_size % FLASH_WORD:
            raise DfuError(
                f"wTransferSize={self.transfer_size} 不是 {FLASH_WORD} B flash word 的整数倍 —— "
                f"块边界会切在 flash word 中间, 相邻块将二次编程同一批字, "
                f"H7 会产生 DBECCERR 坏字并变砖。请显式传对齐的 transfer_size=。")
        self.intf = 0
        self._opened = False
        self._upload_ok = None      # None=未探测; 见 upload_supported()

    # ------------------------------------------------------------------
    def _read_transfer_size(self) -> int:
        """
        ⚠ 实测教训 (2026-09-13): 这里**不要**去遍历配置描述符 / 调非标准 API ——
        那些会触发额外的 GET_DESCRIPTOR 控制传输, 在 DFU 设备上会把状态搞乱
        (表现为 open() 之后 GETSTATUS 立刻 USBError, 随后所有 DNLOAD 全是 Pipe error)。

        本板实测 wTransferSize=1024 (STM32 ROM bootloader 在 FS 模式下的常见值)。
        换别的 STM32 型号若块大小不同, 用构造参数 transfer_size= 显式传。
        """
        return 1024

    def open(self) -> "DfuDevice":
        """
        ⚠ 实测教训: **只做 set_configuration + 选 alt**, 与手工 walk 一致;
        不要遍历配置描述符 (现象同 _read_transfer_size 注释)。
        """
        try:
            self.dev.set_configuration()
        except usb.core.USBError:
            pass                                               # 已配置
        # [2026-09-29] **先 claim 接口, 再设 alt setting。**
        #   libusb 在 Windows(WinUSB) 与 Linux 上都要求接口已被 claim 才能改
        #   alt setting。不 claim 就直接 set_interface_altsetting, 在部分环境
        #   (本机 Win11 + pyusb 1.3.1 + libusb-package 复现) 报
        #   `DfuError: 选择 alt=0 失败: [Errno 13] Access denied` ⇒ 工具完全不可用。
        #   ⚠ 旧注释称"claim 会把设备状态弄坏" —— 2026-09-29 实测**否定了这个说法**:
        #     claim 之后 GETSTATUS / SET_ADDRESS / ERASE(真擦 1.865 s) / 写 103840 B
        #     全程正常, 且 SWD 复核 0 坏字、逐字节一致。当时那个"弄坏"很可能是被
        #     同一个文件里的另外两个 bug (WBLOCK_ERASE/wBlockNum) 误伤了。
        #   兜底: claim 失败不致命(某些平台/驱动下本就不支持), 继续走原路径。
        try:
            usb.util.claim_interface(self.dev, self.intf)
        except Exception:                                      # noqa: BLE001
            pass
        self.set_alt(0)
        self._opened = True
        return self

    def close(self) -> None:
        """只释放 pyusb 资源, 不发任何控制传输。"""
        try:
            usb.util.dispose_resources(self.dev)
        except Exception:                                      # noqa: BLE001
            pass
        self._opened = False

    def __enter__(self):
        return self.open()

    def __exit__(self, *exc):
        self.close()

    # ------------------------------------------------------------------
    def set_alt(self, alt: int) -> None:
        try:
            self.dev.set_interface_altsetting(interface=self.intf, alternate_setting=alt)
        except usb.core.USBError as e:
            raise DfuError(f"选择 alt={alt} 失败: {e}") from e

    def get_status(self) -> tuple[int, int, int]:
        """返回 (bStatus, bwPollTimeout_ms, bState)"""
        d = self.dev.ctrl_transfer(BMREQ_IN, DFU_GETSTATUS, 0, self.intf, 6, timeout=5000)
        if len(d) < 6:
            raise DfuError(f"GETSTATUS 返回 {len(d)} 字节")
        status = d[0]
        timeout = d[1] | (d[2] << 8) | (d[3] << 16)
        state = d[4]
        if status != 0:
            raise DfuError(f"设备报错 bStatus=0x{status:02X} (bState={state})")
        return status, timeout, state

    def _wait(self) -> None:
        """
        ⚠ 实测教训 (2026-09-13): **不能只等一次 bwPollTimeout 就发下一条命令**。
        设备返回的 poll=10ms 只是"最早可以来查"的时间; 若不等它真正离开
        dfuDNBUSY 就发下一条, 控制端点会被 STALL (USBError: Pipe error)。
        手动逐步调用时因为中间夹着调试查询而"碰巧"成功, 掩盖了这个问题。

        ⚠⚠ 2026-09-23 修复: 判据必须是 `state not in _BUSY_STATES` (白名单式
        "已离开干活态"), **不能**是旧写法 `state != DFU_STATE_DNBUSY`。
        后者漏掉过渡态 SYNC(3), 会在设备刚收到 DNLOAD、还没开始写时就放行,
        导致相邻两块写操作重叠 → 同一批 flash word 被二次编程 → ECC 损坏。
        详见 _BUSY_STATES 处的长注释 (含实测坏 word 地址)。
        """
        for _ in range(200):                                   # 上限约 20 s
            _, tmo, state = self.get_status()
            if state not in _BUSY_STATES:
                # [2026-09-28 加固] 二次确认 —— "黑名单式放行"仍留着一个**同源**窗口:
                #   设备可能在 DNLOAD 的 status stage 返回**之后**才把 bState 推进到
                #   SYNC(3)/DNBUSY(4)。此刻首轮 get_status 会读到 dfuIDLE(2), 因为 2
                #   不在 _BUSY_STATES 里, 于是**立即放行** —— 与旧版"在 3 就放行"是
                #   同一类提前放行, 后果同样是相邻两块写操作重叠 → 同一批 flash word
                #   二次编程 → H7 ECC 损坏 (FLASH_SR1.DBECCERR) → 砖机。
                #   再等一个 bwPollTimeout, 只有状态**仍然**不在干活态才真的放行。
                # ⚠ 本加固只可能"多等", **不可能提前放行** ⇒ 无回归风险;
                #   代价是每块多一次 GETSTATUS (本镜像 ~102 块, 可忽略)。
                time.sleep(max(tmo, 5) / 1000.0)
                _, tmo, state2 = self.get_status()
                if state2 not in _BUSY_STATES:
                    return
                state = state2
                continue
            time.sleep(max(tmo, 5) / 1000.0)
        raise DfuError(f"设备长时间停在干活态 (bState={state})")

    def dnload(self, block_num: int, data: bytes) -> None:
        self.dev.ctrl_transfer(BMREQ_OUT, DFU_DNLOAD, block_num, self.intf, data, timeout=10000)
        self._wait()

    def _raw_status(self):
        """裸读 GETSTATUS, 返回 (bStatus, bwPollTimeout, bState); 失败返回 None。
        与 get_status() 的区别: **bStatus != 0 时不抛错** —— 错误恢复路径需要它。"""
        try:
            d = self.dev.ctrl_transfer(BMREQ_IN, DFU_GETSTATUS, 0, self.intf, 6, timeout=2000)
            if len(d) < 6:
                return None
            return d[0], d[1] | (d[2] << 8) | (d[3] << 16), d[4]
        except usb.core.USBError:
            return None

    def clr_status(self) -> None:
        """把设备清回 `dfuIDLE(2)` —— **这是 DNLOAD 相位与 UPLOAD 相位的切换开关**。

        ★★ 2026-09-29 实测(这是本工具最深的那个坑): 本 ROM bootloader 只在
          **`dfuIDLE(2)`** 受理命令。`SET_ADDRESS` / `ERASE` / 数据块这些 DNLOAD
          会把状态推到 `dfuDNLOAD-IDLE(5)`; 此后发 `DFU_UPLOAD` **一律 STALL**;
          反过来 UPLOAD 之后(状态 6)再发 DNLOAD 也一样 STALL。
          **必须发一次 `DFU_CLRSTATUS` 回到 2, 两个方向的切换才成立。**
          ⇒ 旧代码从没发过它, 于是**每次读回都 Pipe error**; 我当时误判成
            "本板 ROM bootloader 不支持 DFU_UPLOAD"(错)。实测加上本调用后,
            UPLOAD 不但能用, 还能靠 `SET_ADDRESS` 读到**任意地址**
            (块 2 = 指定地址起, 后续块顺序 +wTransferSize), 数据与固件 hex
            逐字节 1024/1024 全对。

        ⚠ 已经在 `dfuIDLE` 且 `bStatus==0` 时**不发** —— DFU 规范里在 dfuIDLE 下发
          CLRSTATUS 属错误操作, 可能反过来把 bStatus 置成 errUNKNOWN。
        ⚠ 错误态(`dfuERROR(10)`)下 get_status() 会抛错, 故这里用 `_raw_status()`。
        """
        st = self._raw_status()
        if st is not None and st[2] == DFU_STATE_DFU_IDLE and st[0] == 0:
            return                                             # 已是干净态, 别多此一举
        for _ in range(4):
            try:
                self.dev.ctrl_transfer(BMREQ_OUT, DFU_CLRSTATUS, 0, self.intf, None, timeout=2000)
            except usb.core.USBError:
                pass
            time.sleep(0.05)
            st = self._raw_status()
            if st is not None and st[2] != DFU_STATE_ERROR:
                return
        raise DfuError("DFU_CLRSTATUS 之后设备仍在 dfuERROR —— 无法恢复命令相位。")

    # ------------------------------------------------------------------
    def upload(self, block_num: int, length: int) -> bytes:
        """DFU_UPLOAD 单块读回。"""
        return bytes(self.dev.ctrl_transfer(BMREQ_IN, DFU_UPLOAD, block_num,
                                            self.intf, length, timeout=10000))

    def read_back(self, addr: int, length: int,
                  progress: Callable[[int, int], None] | None = None) -> bytes:
        """
        读回 Flash 内容 (DfuSe: 先 Set Address, 再逐块 UPLOAD)。

        ⚠ 2026-09-23 新增。原实现只声明"未实现 DFU_UPLOAD", 于是**整个工具
        没有任何烧录后校验** —— 而同一文件里却写着"真正的成功判据是烧录后的
        读回校验"。复核确认这是最实质的缺口: 烧坏了也无从发现, 只能靠板子
        起不起来反推。故补齐。

        ★★ 2026-09-29 实测修正 —— **UPLOAD 本来就能用**, 之前失败是因为少了相位切换:
          本 ROM bootloader 只在 `dfuIDLE(2)` 受理命令。顺序必须是

              clr_status()                  → 回到 dfuIDLE(2)
              set_address(addr) + 等空闲    → 设定读指针 (状态变 5)
              clr_status()                  → **关键**: 回 dfuIDLE, 否则 UPLOAD 必 STALL
              连续 UPLOAD 块 2,3,4,...      → 块 2 = addr, 之后每块 +wTransferSize

          少掉第二个 clr_status() 的后果就是"读回永远 `[Errno 32] Pipe error`" ——
          那让整条"烧录后校验"链从未生效, 也是我一度误判"本板不支持 UPLOAD"的原因。
          ⚠ 相位内**不要**再插 GETSTATUS/_wait: 实测连续读 100+ 块不需要它, 插了反而多事。

        ⚠ 块 0 = 4 B DfuSe 命令头(`00 21 41 92`); 块 1 是保留槽(读它必 STALL);
          数据从块 2 开始 —— 与下载路径的块号约定一致。
        """
        self.clr_status()                                      # 相位切换: 回 dfuIDLE
        self.set_address(addr)                                 # 内部已含 clr_status + _wait
        self.clr_status()                                      # ★ 相位切换: 才能发 UPLOAD
        buf = bytearray()
        block = WBLOCK_DATA0
        while len(buf) < length:
            want = min(self.transfer_size, length - len(buf))
            chunk = self.upload(block, want)
            if not chunk:
                break                                          # 设备提前结束
            buf += chunk
            block += 1
            if progress:
                progress(len(buf), length)
        return bytes(buf)

    # ------------------------------------------------------------------
    def set_address(self, addr: int) -> None:
        """设 DfuSe 地址指针 (DNLOAD 类控制命令, 载荷 = 0x21 + 4B 地址 LE)。

        ⚠ 2026-09-29: 发之前**必须先把状态清回 `dfuIDLE(2)`** —— 若上一动是 UPLOAD
          (设备停在 dfuUPLOAD-IDLE), 直接发会被 STALL。见 clr_status() 的长注释。
        """
        self.clr_status()
        self.dnload(WBLOCK_SET_ADDRESS,
                    bytes([DFUSE_SET_ADDRESS]) + addr.to_bytes(4, "little"))

    def erase_sector_at(self, addr: int) -> None:
        self.dnload(WBLOCK_ERASE, bytes([DFUSE_ERASE]) + addr.to_bytes(4, "little"))

    # ------------------------------------------------------------------
    # [2026-09-28] 擦除的**物理确认** —— USB 烧录可靠性的核心加固
    #
    # 2026-09-28 实测事故: 用本引擎烧 103,712 B 后, 扇区 0 有 **101/128 个 1KB 块
    #   读失败(2,384 个坏 flash word, 散布整个扇区)**, 首坏块就是 0x08000000
    #   (向量表首字) ⇒ CPU 取不到启动向量 ⇒ USB 不枚举; FLASH_SR1 的 DBECCERR 置位。
    #
    # 机理: 该损坏**不是**"相邻两块重叠"(那只会销毁数字节), 而是**整片在未擦完的
    #   扇区上写** —— 擦除尚未结束时主机就开始写, 写进半擦除的字 ⇒ ECC 非法。
    #   根因仍是"提前放行": 状态机判据 `state not in (SYNC,DNBUSY)` 会在设备刚
    #   接受擦除命令、还没真正开擦时就读到 dfuIDLE(2) ⇒ 立刻返回 ⇒ 立刻开写。
    #
    # 对策(不依赖状态机): 擦完**读回来确认整扇区都是 0xFF**。这是物理证据 ——
    #   只要还有非 0xFF 的字节就说明没擦完, 继续等。**状态机可以骗人, 读回不能。**
    # ------------------------------------------------------------------
    def upload_supported(self) -> bool:
        """探测 UPLOAD 是否可用(只探一次)。不可用则退回旧行为并告警。"""
        if self._upload_ok is None:
            try:
                self.read_back(FLASH_BASE, 32)
                self._upload_ok = True
            except Exception:                                      # noqa: BLE001
                self._upload_ok = False
        return bool(self._upload_ok)

    def sector_is_erased(self, addr: int) -> bool:
        """整扇区读回是否全 0xFF。读不到(忙 / STALL)一律按**未擦完**处理。"""
        try:
            data = self.read_back(addr, SECTOR_SIZE)
        except Exception:                                          # noqa: BLE001
            return False
        return len(data) == SECTOR_SIZE and all(b == 0xFF for b in data)

    def erase_sector_verified(self, addr: int, note=None) -> None:
        """擦一个扇区, 并用**两条相互独立的证据**确认它真的被擦了才返回。

        ① **忙时长下界**(不依赖 UPLOAD、不依赖任何外部工具):
           128KB 扇区真实擦除实测 **1.865 s**; 而 ERASE 的 wBlockNum 写错时的
           "假擦除"只让设备忙 **0.011 s** 就回 bStatus=0x00。差两个数量级,
           故用 0.15 s 作下界 —— 低于它一律判为"没擦", **拒绝继续编程**。
           这条正是 2026-09-29 那场砖的直接教训, 也是本函数最要紧的一道闸。
        ② **读回全 0xFF**(仅当 DFU_UPLOAD 可用): 整扇区逐字读回, 物理证据。
           本板 ROM bootloader 不支持 UPLOAD, 故这条在本机不生效 —— 但保留,
           换到 UPLOAD 可用的 bootloader 上会多一层保护。
        """
        self.set_address(addr)
        t0 = time.perf_counter()
        self.erase_sector_at(addr)                 # 内部 _wait() 会等到设备离开忙态
        busy = time.perf_counter() - t0
        if busy < ERASE_MIN_BUSY_S:
            raise DfuError(
                f"扇区 0x{addr:08X} 的擦除只让设备忙了 {busy*1000:.0f} ms"
                f"(真实擦除需 >{ERASE_MIN_BUSY_S*1000:.0f} ms) —— **判定为没擦, 拒绝继续编程**。\n"
                f"    在未擦除的扇区上写会让同一批 32B flash word 二次编程, 毁掉 ECC\n"
                f"    (FLASH_SR1.DBECCERR) 并把板子变砖 —— 2026-09-29 实测过:\n"
                f"    ERASE 的 wBlockNum 误用 1 时只忙 11 ms, 扇区一个字节都没擦。\n"
                f"    ⇒ 检查 WBLOCK_ERASE 是否为 0 (DfuSe 特殊命令都用 wBlockNum=0)。")
        if not self.upload_supported():
            if note:
                note(f"擦除扇区 0x{addr:08X} 耗时 {busy:.2f} s ✓ (忙时长下界通过; "
                     f"本机无 UPLOAD, 无法再读回复核)")
            return
        for i in range(300):                       # 上限 ~30 s (最坏擦除 4s 的 7 倍余量)
            if self.sector_is_erased(addr):
                if note:
                    note(f"擦除扇区 0x{addr:08X} 耗时 {busy:.2f} s, 读回复核全 0xFF ✓")
                return
            time.sleep(0.1)
        raise DfuError(
            f"扇区 0x{addr:08X} 擦除后仍有非 0xFF 字节(已等 ~30 s) —— **拒绝继续编程**。\n"
            f"    在未擦完的扇区上写会毁掉 ECC(FLASH_SR1.DBECCERR), 让整片变砖\n"
            f"    (2026-09-28 实测过: 扇区 0 的 101/128 个块读失败, 首坏块是向量表首字)。")

    def erase_sectors_covering(self, base: int, total: int, note=None) -> None:
        """擦掉 [base, base+total) 覆盖到的**所有**扇区。

        ⚠ 单一来源: 正常烧录路径与"校验失败后擦回空白"路径**共用这一个实现** ——
          避免两份擦除逻辑各自漂移(本仓的老毛病: 一份写对一份错)。

        ★ 2026-09-29 关键修复 —— 擦除**曾经完全没发生**: ERASE 的 wBlockNum 误用 1
          (DfuSe 特殊命令都该是 0), ROM 只忙 11 ms 就回 bStatus=0x00 而扇区**一字未擦**;
          工具却以为擦好了, 直接往**还有旧固件**的扇区写新镜像 ⇒ 新旧不同的那些
          32B flash word 被**二次编程** ⇒ ECC 坏字散布整个扇区 ⇒ 砖。
          该链解释了此前的全部砖: 坏字比例≈新旧镜像差异比例; 空白扇区烧录反而正常;
          重烧同一固件逐字节完美(位没变)。**修正 WBLOCK_ERASE=0 后实测耗时 1.865 s,
          扇区真的全变 0xFF。**
          另: erase_sector_verified() 里加了"忙时长下界"闸 —— 万一将来又出现假擦除,
          低于 0.15 s 一律拒绝编程。
          ⚠ 两条判据都**不依赖 DFU_UPLOAD, 也不需要任何外部工具**(纯 pyusb) ——
            Linux 上只要有 libusb + udev 规则即可, 与 Windows 同一套代码。
        """
        lo, hi = base, base + total - 1
        s = (lo - FLASH_BASE) // SECTOR_SIZE
        e = (hi - FLASH_BASE) // SECTOR_SIZE
        for k in range(s, e + 1):
            sect = FLASH_BASE + k * SECTOR_SIZE
            if note:
                note(f"擦除扇区 {k} (@0x{sect:08X}) ...")
            self.erase_sector_verified(sect, note=note)


    def finish(self) -> None:
        """
        零长度 DNLOAD = 结束并 manifest。

        ⚠ 实测 (2026-09-13): ST ROM bootloader 对这一条**常回 STALL**
        (USBError: Pipe error), 这是**预期行为, 不是失败** —— 读回比对已证明
        数据完整写入且逐字节一致。设备随后由 detach() 正常离开。
        故此处吞掉该异常; 真正的成功判据是烧录后的读回校验。
        """
        try:
            self.dnload(0, b"")
        except (usb.core.USBError, DfuError):
            pass

    def detach(self) -> None:
        """让设备离开 DFU 并复位回应用"""
        try:
            self.dev.ctrl_transfer(BMREQ_OUT, DFU_DETACH, DETACH_TIMEOUT_MS,
                                   self.intf, None, timeout=2000)
        except usb.core.USBError:
            pass                                               # 设备可能已自己重启

    # ------------------------------------------------------------------
    def _flash_range(self, blob: bytes, base: int, rep, erase: bool,
                     done_base: int = 0) -> None:
        """
        烧一段**连续**区域: Set Address -> Erase -> Set Address -> 数据块。

        不含参数扇区策略 —— 分段由 flash() 负责。done_base 是这一段在整体
        进度里的起点(分段烧时用来把两段的进度接成一条)。

        ⚠ 顺序是实测出来的 (2026-09-13):
          Set Address -> Erase -> Set Address -> 数据块
        若省掉**擦除前**那次 Set Address, 擦除会返回 bStatus=0 但实际没擦,
        随后第一个数据块 DNLOAD 被 STALL (USBError: Pipe error)。
        这也与 dfu-util 的 DfuSe 流程一致 (erase 前先给地址指针)。
        """
        total = len(blob)
        if not total:
            return
        if erase:
            rep(done_base, "设置地址指针 (擦除前) ...")
            # ⚠ 只擦**镜像覆盖到的**扇区。本工程固件 103,712 B 全部落在扇区 0,
            #   所以正常情况下这里只会擦扇区 0 —— 扇区 6(许可证)/7(标定) 不会被碰。
            self.erase_sectors_covering(base, total,
                                        note=lambda m, d=done_base: rep(d, m))

        rep(done_base, "设置地址指针 (写数据前) ...")
        self.set_address(base)

        block = WBLOCK_DATA0
        off = 0
        while off < total:
            chunk = blob[off:off + self.transfer_size]
            self.dnload(block, chunk)
            off += len(chunk)
            block += 1
            rep(done_base + off, f"写入 {off}/{total} B (块 {block - 1}) ...")

    # ------------------------------------------------------------------
    def flash(self, blob: bytes, base: int = FLASH_BASE,
              progress: Callable[[int, int, str], None] | None = None,
              erase: bool = True,
              param_policy: str = PARAM_POLICY_ABORT,
              verify: bool = True) -> None:
        """
        把 blob 烧到 base。progress(已写字节, 总字节, 阶段文本) 会被回调。
        擦除按扇区进行, 只擦 blob 覆盖到的扇区。

        ⚠ 受保护扇区策略 (2026-09-23 新增; 09-28 扩到扇区 6+7):
        若镜像**覆盖** 0x080C0000..0x08100000 (扇区 6 许可证 + 扇区 7 标定参数,
        两者都**只存在于设备**、仓库里没有), 按 param_policy 处理:
          · "abort"(默认) —— 直接拒绝, 抛 DfuError。要求你显式选下面两者之一
          · "skip"        —— **跳过扇区 6+7**: 擦除避开它们, 写入分两段绕开, 两者原样保留
          · "wipe"        —— 连扇区 6+7 一起擦写 (明确的"许可证与参数都不要了")

        ⚠ 读回校验 (2026-09-23 新增): verify=True(默认) 写完读回逐字节比对,
        不一致即抛 DfuError。若 bootloader 不支持 UPLOAD 则降级为**警告**,
        不算失败(但会明确告诉你"结果未经证实")。
        """
        # ⚠ 2026-09-23: 长度与起始地址都要对齐到 32 B flash word。
        # 不对齐时 ROM bootloader 需做 read-modify-write, 而目标 word 若已被
        # 本轮写过就会二次编程 → 破坏 ECC。尾部用 0xFF 补齐 (等同擦除态)。
        if base % FLASH_WORD:
            raise DfuError(
                f"起始地址 0x{base:08X} 未对齐到 {FLASH_WORD} 字节 flash word")
        pad = (-len(blob)) % FLASH_WORD
        if pad:
            blob = blob + b"\xFF" * pad
        total = len(blob)

        # ---- ⚠ 受保护扇区策略 (2026-09-23 新增; 09-28 扩到扇区 6+7) ----
        # 宁可拒绝烧录, 也不要在用户没意识到的情况下擦掉不可再生的
        # 设备侧状态 —— 许可证(扇区 6) 与 标定参数(扇区 7) 都只存在于设备。
        if param_policy not in PARAM_POLICIES:
            raise DfuError(f"未知 param_policy: {param_policy!r} (可选 {PARAM_POLICIES})")

        hi_addr = base + total - 1
        covers_param = (base < PROTECTED_END) and (hi_addr >= PROTECTED_START)

        if covers_param and param_policy == PARAM_POLICY_ABORT:
            raise DfuError(
                f"镜像覆盖受保护扇区 "
                f"0x{PROTECTED_START:08X}..0x{PROTECTED_END - 1:08X}, 已拒绝烧录。\n"
                f"    该区含两个**只存在于设备**的记录, 擦掉均不可恢复:\n"
                f"      · 扇区 6 @ 0x{LICENSE_SECTOR_START:08X} — 许可证 (magic LTC1)\n"
                f"      · 扇区 7 @ 0x{PARAM_SECTOR_START:08X} — 标定参数 (flash_store; 例: J2 摩擦前馈 fc0/fc1)\n"
                f"    可选:\n"
                f"      param_policy=\"skip\"  —— 跳过扇区 6+7, 只烧其余部分 (全部保住)\n"
                f"      param_policy=\"wipe\"  —— 连扇区 6+7 一起擦写 (许可证与参数都不要了)")

        def rep(done: int, stage: str) -> None:
            if progress:
                progress(done, total, stage)

        # 分段: 只有 skip 模式且确实跨越受保护区时才切。
        # 切成 [base, PROTECTED_START) + [PROTECTED_END, hi] 两段, 中间整块不碰 ——
        # ⚠ 不能只"跳过擦除": 镜像里落在受保护区内的字节若照常按连续块发出,
        #   会被写到**错误的地址**上。必须连写入也分段。
        # ⚠ 保护区跨越 2 个扇区 (256KB), 而 cut 与 PROTECTED_SIZE 都是 0x20000 的
        #   整数倍 ⇒ 分段边界天然落在扇区边界上, _flash_range 的按扇区擦除不会
        #   误伤保护区 (它在两段各自的范围之外)。
        segments: list[tuple[bytes, int, int]] = []
        if covers_param and param_policy == PARAM_POLICY_SKIP:
            cut = PROTECTED_START - base                 # 第一段长度 (32B 对齐)
            seg1 = blob[:cut]
            seg2 = blob[cut + PROTECTED_SIZE:]           # 扇区 6+7 整块跳过
            skipped = total - len(seg1) - len(seg2)
            rep(0, f"⚠ skip 策略: 跳过受保护扇区 6+7 共 {skipped} B "
                   f"(@0x{PROTECTED_START:08X}), 许可证与参数原样保留")
            if seg1:
                segments.append((seg1, base, 0))
            if seg2:
                segments.append((seg2, PROTECTED_END, len(seg1)))
            if not segments:
                # 整个镜像都落在受保护区里 —— skip 模式下没有任何可烧的内容。
                # 静默不烧是危险的(调用方以为烧成功了), 必须明确告知。
                raise DfuError(
                    f"skip 策略下没有可烧的内容: 镜像整体落在受保护扇区 "
                    f"0x{PROTECTED_START:08X}..0x{PROTECTED_END - 1:08X} 内。\n"
                    f"    要么改用 param_policy=\"wipe\" (确认许可证与参数都不要了), "
                    f"要么检查这个镜像是不是选错了。")
        else:
            segments.append((blob, base, 0))

        try:
            for seg_blob, seg_base, done_base in segments:
                self._flash_range(seg_blob, seg_base, rep, erase, done_base)
        except Exception as e:                                     # noqa: BLE001
            # [2026-09-28] 写中途失败(**不是**校验失败那条)也要擦回空白:
            # 半写状态同样可能含 ECC 坏字; 擦干净后板子仍可被 USB DFU 重烧。
            rep(0, f"⚠ 烧录中断 ({type(e).__name__}: {e}) —— 尝试擦回空白以保住 USB 可重烧性 ...")
            try:
                if erase:
                    self.erase_sectors_covering(
                        base, total, note=lambda m: rep(0, "  " + m))
                    rep(0, "已擦回空白 ⇒ 板子未砖, 可直接重烧")
            except Exception as e2:                                # noqa: BLE001
                rep(0, f"⚠ 擦回空白也失败 ({type(e2).__name__}: {e2}) ⇒ 可能需要 SWD 救砖")
            raise

        # ---- ⚠ 读回校验 (2026-09-23 新增) ----
        # 必须在 finish() **之前**: 零长度 DNLOAD(manifest) 之后设备可能已离开
        # DFU 状态, 那时再 UPLOAD 会失败。
        if verify:
            rep(total, "读回校验 ...")
            back: bytes | None = None
            # [2026-09-29 修复] **UPLOAD 读不出来 ≠ 本机不支持 UPLOAD**。
            #   若擦除阶段已探明 UPLOAD 可用(_upload_ok is True), 那么此刻读不回内容
            #   就只可能是**刚写进去的东西坏了** —— 读一个 ECC 坏字会让 ROM bootloader
            #   直接总线错误, DFU_UPLOAD 被 STALL。
            #   ⚠ 旧写法把这条 except 一律降级成"结果未经证实"的**告警**, 于是**恰好把它
            #     本该捕获的那个故障吞掉**: 烧坏 → UPLOAD 失败 → 当成"本机不支持" →
            #     不触发下面的"擦回空白" → 板子留在 ECC 已坏的状态 ⇒ 砖机, 只能上 SWD。
            #     这正是 2026-09-29 实测"加固版 exe 仍把新板子烧砖"的漏点。
            #   ⇒ 判据改成: 之前能用 + 现在读不回 = 内容坏了 = 按校验失败处理(擦回空白)。
            upload_was_ok = self._upload_ok is True
            try:
                back = self.read_back(base, total)
            except (usb.core.USBError, DfuError) as e:
                if upload_was_ok:
                    erased = False
                    try:
                        self.erase_sectors_covering(
                            base, total, note=lambda m: rep(total, "  " + m))
                        erased = True
                    except Exception as e2:                        # noqa: BLE001
                        rep(total, f"⚠ 擦回空白失败 ({type(e2).__name__}: {e2})")
                    raise DfuError(
                        f"读回校验失败: UPLOAD 读不回刚写入的内容 ({type(e).__name__}: {e})。\n"
                        f"    本机 UPLOAD 此前已探明可用 ⇒ 只可能是写入的内容坏了(ECC 坏字)。\n"
                        + ("    **已把受损扇区擦回空白** ⇒ 板子没砖, 重新执行本工具即可再烧。"
                           if erased else
                           "    ⚠ 擦回空白**也失败了** ⇒ 需要 SWD 探针 (pyocd erase --sector) 救砖。"))
                # [2026-09-29] 本机(bcdDevice 0x200 的 STM32H723 ROM bootloader)**实测不支持
                #   DFU_UPLOAD**: 任何块号/长度都被 STALL ⇒ 这条提示是**必然**出现的,
                #   不代表烧录失败。措辞必须让用户知道"接下来怎么判断成败"。
                # ⚠ 不再回显原始异常(`USBError: [Errno 32] Pipe error`) —— 它在这条路径上
                #   已知且必然, 打出来只会让人误以为出了故障。用 ℹ 而非 ⚠。
                #   注: 若 UPLOAD **此前已探明可用**、此刻却读不回, 走的是上面 upload_was_ok
                #   分支(带完整异常信息并抛 DfuError), 所以此处丢掉细节不会掩盖真问题。
                rep(total, "ℹ 读回校验不可用: 本机 bootloader 不支持 DFU_UPLOAD —— "
                           "这不是烧录失败; 复位后串口/版本串能回来即代表烧写成功")
            if back is not None:
                if len(back) != total:
                    raise DfuError(f"读回长度不符: 期望 {total} B, 实得 {len(back)} B")
                if back != blob:
                    bad = next(i for i in range(total) if back[i] != blob[i])
                    # [2026-09-28] 失败保护: 立刻把已写扇区**擦回空白**。
                    # 理由(本工具存在的意义): "空白但 ECC 健康"的板子**仍能用 USB DFU 重烧**
                    #   —— ROM bootloader 在系统存储器, 与主 flash 无关; 而"ECC 已坏"的板子
                    #   读即 fault, **只能上 SWD**。两害相权, 擦回空白保住了 USB 烧录能力。
                    # ⚠ 所以下面的报错必须同时说清"板子现在是空的, 需要重烧"。
                    erased = False
                    try:
                        self.erase_sectors_covering(
                            base, total, note=lambda m: rep(total, "  " + m))
                        erased = True
                        rep(total, "已把受损扇区擦回空白 —— 板子未砖, 可直接用 DFU 重烧")
                    except Exception as e2:                        # noqa: BLE001
                        rep(total, f"⚠ 擦回空白失败 ({type(e2).__name__}: {e2})")
                    raise DfuError(
                        f"读回校验失败: 首个不一致处 0x{base + bad:08X} "
                        f"(写入 0x{blob[bad]:02X}, 读回 0x{back[bad]:02X})。\n"
                        + ("    **已把受损扇区擦回空白** ⇒ 板子没砖, 重新执行本工具即可再烧。"
                           if erased else
                           "    ⚠ 擦回空白**也失败了** ⇒ 可能需要 SWD 探针(pyocd erase -r)救砖。"))
                rep(total, f"✓ 读回校验通过 ({total} B 逐字节一致)")

        rep(total, "结束 (manifest) ...")
        self.finish()

    # ------------------------------------------------------------------
    def leave(self, reset: bool = True) -> None:
        """离开 DFU。设备通常自行复位回应用。"""
        if reset:
            try:
                self.detach()
            except Exception:                                  # noqa: BLE001
                pass
        self.close()


def flash_bytes(blob: bytes, base: int = FLASH_BASE,
                progress: Callable[[int, int, str], None] | None = None,
                reset: bool = True) -> None:
    """一次性: 找设备 → 打开 → 烧 → 离开。"""
    d = DfuDevice()
    try:
        d.open()
        d.flash(blob, base, progress)
    finally:
        d.leave(reset)
