"""升级编排 —— 把"失能 → 进 DFU → 擦写校验 → 复位 → 接回来"串成一条流水线。

为什么单独一个模块：这条流水线**跨了两个完全不同的会话**
（应用态的 USB CDC 命令通道 → ROM bootloader 的 USB DFU 设备 → 又是应用态），
而它必须能被离线测试 —— 真机验证一次要人在场、臂要有支撑，不能当成日常回归。

所以这里只有**相位顺序、短码与结果形状**，具体动作由调用方以 `UpgradeHooks`
注入：守护进程注入真实现（SDK + pyusb 引擎），测试注入假实现。

⚠ 两个不变量写在这里，改的时候别丢：

* **进 DFU 之前必须已失能** —— 跳转停 TIM3 ⇒ 不再发 MIT 帧 ⇒ 电机侧
  `RID_TIMEOUT`(100ms) 松开 ⇒ 有重力负载的臂会下垂；
* **失败也要把设备拉出 DFU** —— 让板子回到应用态（哪怕应用区是空的），
  好过把它留在 bootloader 里"像坏了"。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional, Protocol, Tuple

#: 相位名 —— 界面按它选文案，所以是**协议的一部分**，不要随手改名。
PHASE_VALIDATE = "validate"
PHASE_DISARM = "disarm"
PHASE_ENTER_DFU = "enter_dfu"
PHASE_WAIT_DFU = "wait_dfu"
PHASE_FLASH = "flash"
PHASE_DETACH = "detach"
PHASE_RECONNECT = "reconnect"
PHASE_DONE = "done"

PHASES = (PHASE_VALIDATE, PHASE_DISARM, PHASE_ENTER_DFU, PHASE_WAIT_DFU,
          PHASE_FLASH, PHASE_DETACH, PHASE_RECONNECT, PHASE_DONE)

#: 面向界面的短码。界面文案只能按短码选（`str(e)` 是中文，英文界面要换一句话）。
REASON_IMAGE_UNREADABLE = "image_unreadable"
REASON_IMAGE_NOT_AT_BASE = "image_not_at_app_base"
REASON_IMAGE_TOO_LARGE = "image_too_large"
REASON_IMAGE_COVERS_PROTECTED = "image_covers_protected"
REASON_ARM_ENABLED = "arm_enabled"
REASON_DFU_NOT_ENTERED = "dfu_not_entered"
REASON_DFU_DEVICE_ABSENT = "dfu_device_absent"
REASON_ENGINE_UNAVAILABLE = "engine_unavailable"
REASON_FLASH_FAILED = "flash_failed"
REASON_RECONNECT_FAILED = "reconnect_failed"
REASON_CANCELLED = "cancelled"


class UpgradeError(Exception):
    """升级流水线里的一步失败，带一个面向界面的短码。"""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class Progress:
    """一条进度 —— 由 `emit` 送往界面（广播帧，不是 RPC 应答）。"""

    phase: str
    done: int = 0
    total: int = 0
    detail: str = ""

    def to_dict(self, job: str) -> dict:
        return {"job": job, "phase": self.phase, "done": self.done,
                "total": self.total, "detail": self.detail}


@dataclass(frozen=True)
class Result:
    """升级的终局。`ok` 只表示**流程走完且烧录经读回校验**。"""

    ok: bool
    reason: Optional[str] = None
    message: str = ""
    version: Optional[str] = None
    port: Optional[str] = None
    #: 流程成功、但有一件操作员该知道的事（目前只有"版本串对不上"）。
    warning: Optional[str] = None

    def to_dict(self, job: str) -> dict:
        return {"job": job, "ok": self.ok, "reason": self.reason,
                "msg": self.message, "version": self.version,
                "port": self.port, "warning": self.warning}


class UpgradeHooks(Protocol):
    """流水线要的六个动作 —— 由调用方实现（真机或假件）。"""

    def disarm(self) -> None:
        """失能全部关节。**必须真的失能**，否则后面的跳转会让臂下垂。"""

    def enter_dfu(self) -> None:
        """发 `CMD_ENTER_DFU (0x15)` 并等设备真的离开 CDC。"""

    def wait_for_dfu(self, is_cancelled: Callable[[], bool]) -> None:
        """等 `0483:DF11` 枚举出来（设备重枚举需要时间）。"""

    def flash(self, blob: bytes, base: int,
              on_progress: Callable[[int, int, str], None]) -> None:
        """擦写 + 读回校验。`on_progress(已写字节, 总字节, 阶段文本)`。"""

    def detach(self) -> None:
        """让设备离开 DFU 并复位回应用。"""

    def reconnect(self, is_cancelled: Callable[[], bool]) -> Tuple[str, str]:
        """等 CDC 回来并建立新会话 → `(端口, 固件版本串)`。"""


def run_upgrade(*, blob: bytes, base: int, summary, hooks: UpgradeHooks,
                emit: Callable[[Progress], None],
                is_cancelled: Callable[[], bool] = lambda: False) -> Result:
    """跑完整条升级流水线。**不抛异常** —— 一切终局都折成 `Result`。

    `summary` 是 `image.ImageSummary`（只用于显示与版本核对，判据在 `image.inspect`
    里已经过了）。`emit` 会被多次调用；`is_cancelled` 在相位之间与"等待类"相位内
    被查询，**烧录相位内不生效**（擦一半中断比烧完更糟，引擎自己也带"擦回空白"保护）。
    """
    expected_version = getattr(summary, "version", None)

    def note(phase: str, detail: str = "", done: int = 0, total: int = 0) -> None:
        emit(Progress(phase, done, total, detail))

    note(PHASE_VALIDATE,
         f"{summary.name} · {summary.size} B · "
         f"版本 {expected_version or '未识别'} · sha256 {summary.sha256[:12]}")

    if is_cancelled():
        return Result(False, REASON_CANCELLED, "已取消（尚未开始）")

    entered_dfu = False
    try:
        note(PHASE_DISARM, "失能全部关节")
        hooks.disarm()

        note(PHASE_ENTER_DFU, "发送 CMD_ENTER_DFU (0x15)")
        hooks.enter_dfu()
        entered_dfu = True

        note(PHASE_WAIT_DFU, "等待 DFU 设备 (0483:DF11) 枚举")
        hooks.wait_for_dfu(is_cancelled)

        note(PHASE_FLASH, "开始烧录", 0, summary.size)
        hooks.flash(blob, base, lambda d, t, s: note(PHASE_FLASH, s, d, t))

        if is_cancelled():
            # 烧完了才按的取消：镜像已经落盘, 这里**不能**说"没升级"。
            note(PHASE_DETACH, "复位回应用（烧录已完成, 取消不再生效）")
        else:
            note(PHASE_DETACH, "复位回应用")
        hooks.detach()
        entered_dfu = False

        note(PHASE_RECONNECT, "等待串口重新枚举并重建会话")
        port, version = hooks.reconnect(is_cancelled)
    except UpgradeError as e:
        return _fail(e.reason, str(e), hooks, entered_dfu, note)
    except Exception as e:                                     # noqa: BLE001
        # 引擎抛的是 `DfuError`, 但这里的边界是"任何一步都不许把异常漏出去":
        # 漏出去就只剩一条 WS 断连，操作员看不到是哪一步坏的。
        return _fail(REASON_FLASH_FAILED, f"{type(e).__name__}: {e}",
                     hooks, entered_dfu, note)

    warning = None
    if expected_version and version and version != expected_version:
        # ⚠ 不做成失败: 读回校验已经过了, 镜像**确实**写进去了 —— 对不上说明
        #   我们对"镜像里的版本串"或"设备报的版本串"的理解有一个是错的, 这要
        #   让人看见, 但不是"升级失败"。
        warning = (f"镜像版本 {expected_version}, 但设备复位后报 {version} —— "
                   f"烧录本身已通过读回校验, 请核对这份镜像是否选错")
    note(PHASE_DONE, f"完成 · 设备报版本 {version or '未知'}")
    return Result(True, None, "升级完成并通过读回校验",
                  version=version, port=port, warning=warning)


def _fail(reason: str, message: str, hooks: UpgradeHooks, entered_dfu: bool,
          note: Callable[..., None]) -> Result:
    """失败收尾：**尽力把设备拉出 DFU**，然后把失败如实交出去。

    留在 bootloader 里的板子看起来就是"坏了"（串口不枚举、界面永远连不上），
    而它其实只是等着一条 `DFU_DETACH`。这一步失败只记在 detail 上，不覆盖
    真正的失败原因 —— 后者才是操作员要看的。
    """
    if entered_dfu:
        note(PHASE_DETACH, "失败后复位回应用 ...")
        try:
            hooks.detach()
        except Exception as e:                                 # noqa: BLE001
            note(PHASE_DETACH, f"复位回应用也失败 ({type(e).__name__}: {e}) "
                               f"—— 板子可能停在 bootloader, 断电重上电即可")
    return Result(False, reason, message)
