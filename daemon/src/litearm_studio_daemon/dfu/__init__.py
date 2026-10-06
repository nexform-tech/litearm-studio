"""固件升级（USB DFU）—— 守护进程侧的镜像校验、烧录引擎与编排。

三块，职责分开：

* `image`  —— 镜像的离线解析与准入判据（不碰设备 ⇒ 无硬件也能测）；
* `job`    —— 相位顺序、短码与结果形状（动作由调用方注入 ⇒ 无硬件也能测）；
* `engine` —— DfuSe 烧录引擎（**逐字搬运**自上游 `dfu-flash`，见那个文件的出处说明）。

`engine` 只有在真要烧的时候才需要 pyusb + libusb，所以本包**不**在 import 期
依赖它们：没有 pyusb 时 `engine.available()` 为 False，命令层给出
`engine_unavailable` 而不是让守护进程起不来。
"""
from __future__ import annotations

from . import engine, fake
from .image import (APP_BASE, FLASH_END, ImageError, ImageSummary, inspect,
                    extract_fw_version)
from .job import (PHASES, PHASE_DETACH, PHASE_DISARM, PHASE_DONE,
                  PHASE_ENTER_DFU, PHASE_FLASH, PHASE_RECONNECT, PHASE_VALIDATE,
                  PHASE_WAIT_DFU, Progress, Result, UpgradeError, UpgradeHooks,
                  run_upgrade)

__all__ = [
    "engine", "fake", "APP_BASE", "FLASH_END", "ImageError", "ImageSummary",
    "inspect", "extract_fw_version", "PHASES", "PHASE_VALIDATE", "PHASE_DISARM",
    "PHASE_ENTER_DFU", "PHASE_WAIT_DFU", "PHASE_FLASH", "PHASE_DETACH",
    "PHASE_RECONNECT", "PHASE_DONE", "UpgradeError", "UpgradeHooks", "Progress",
    "Result", "run_upgrade", "engine_status",
]


def engine_status() -> tuple[bool, str]:
    """`(能不能烧, 人话原因)` —— 界面需要能把"缺什么"说出来。

    ⚠ 这也是一处**离线可测**的判据：没有 pyusb/libusb 时它返回 False，
    命令层据此给出可执行的提示（装 pyusb / 装驱动），而不是等烧到一半才炸。
    """
    ok = bool(engine.available())
    return ok, engine.backend_status()
