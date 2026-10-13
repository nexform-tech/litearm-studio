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

from typing import Any, List, Optional

from . import engine, fake
from .image import (APP_BASE, FLASH_END, ImageError, ImageSummary, inspect,
                    extract_fw_version)
from .job import (PHASES, PHASE_DETACH, PHASE_DISARM, PHASE_DONE,
                  PHASE_ENTER_DFU, PHASE_FLASH, PHASE_RECONNECT, PHASE_VALIDATE,
                  PHASE_WAIT_DFU, Progress, Result, UpgradeError, UpgradeHooks,
                  run_upgrade, REASON_DFU_PERMISSION)

__all__ = [
    "engine", "fake", "APP_BASE", "FLASH_END", "ImageError", "ImageSummary",
    "inspect", "extract_fw_version", "PHASES", "PHASE_VALIDATE", "PHASE_DISARM",
    "PHASE_ENTER_DFU", "PHASE_WAIT_DFU", "PHASE_FLASH", "PHASE_DETACH",
    "PHASE_RECONNECT", "PHASE_DONE", "UpgradeError", "UpgradeHooks", "Progress",
    "Result", "run_upgrade", "engine_status", "device_location",
    "REASON_DFU_PERMISSION",
]


def engine_status() -> tuple[bool, str]:
    """`(能不能烧, 人话原因)` —— 界面需要能把"缺什么"说出来。

    ⚠ 这也是一处**离线可测**的判据：没有 pyusb/libusb 时它返回 False，
    命令层据此给出可执行的提示（装 pyusb / 装驱动），而不是等烧到一半才炸。
    """
    ok = bool(engine.available())
    return ok, engine.backend_status()


def _as_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _port_chain(dev: Any) -> List[int]:
    """端口链 —— 优先整条 (`port_numbers`), 退到单跳 (`port_number`), 再退到空。"""
    raw = getattr(dev, "port_numbers", None)
    if isinstance(raw, (list, tuple)) and raw:
        chain: List[int] = []
        for item in raw:
            port = _as_int(item)
            if port is None:
                chain = []
                break
            chain.append(port)
        if chain:
            return chain
    one = _as_int(getattr(dev, "port_number", None))
    return [one] if one is not None else []


def device_location(dev: Any) -> str:
    """设备的**物理位置**（"总线-端口链", 形如 `1-3.2`）; 取不到就是空串。

    用途只有一个: 让操作员核对"我们找到的这块板子, 是不是我插的那块"。所以它必须是
    **插在哪儿**（总线 + 端口链 —— 换个插口它就变），而不是"这次枚举成几号"
    (`address` 每次重枚举都会变, 拿它对不上任何人眼里的东西)。

    ⚠ **只用枚举时白拿的字段** (`bus` / `port_numbers` / `port_number`): 它们来自
      libusb 缓存的设备描述符, 不发任何控制传输。**不许**顺手读 `serial_number` 或
      `manufacturer` / `product` —— 那会发 `GET_DESCRIPTOR`, 而 `engine` 里那条实测
      教训说得很清楚: 在 DFU 设备上多打一次就会把状态搞乱, 表现为 `open()` 之后
      `GETSTATUS` 立刻报错、随后所有写入全是 Pipe error (见 `engine._read_transfer_size`)。
    ⚠ 它在**包级**而不在 `engine.py` 里, 也是因为那条纪律: 那边是**逐字搬运**的上游
      文件 (逻辑一行未改, 见其文件头), 要改行为得回改上游仓, 不能在本仓就地发明。
    """
    bus = _as_int(getattr(dev, "bus", None))
    if bus is None:
        # 连总线号都拿不到 ⇒ 这个位置说不出任何可核对的信息, 不如不说 (回空串)。
        return ""
    ports = _port_chain(dev)
    return str(bus) if not ports else f"{bus}-" + ".".join(str(p) for p in ports)
