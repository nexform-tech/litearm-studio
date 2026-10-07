"""机械臂串口的候选列表, 以及「上次连上的那个口」的记忆。

谁读它: 顶栏「端口」下拉 (`list_ports` 命令) 与会话的连接目标解析 (`Session`)。
为什么单独一个模块: 这两件事都与**设备发现**有关, 而 `session.py` 已经背着会话/状态/
自愈那一摊 —— 塞进去之后"哪几个口可能是这台臂"会散落在一千七百行里。

⚠ 只列**像 USB 串口**的设备名: `/dev/ttyS0` 这类板载口永远连不上这台臂, 列进下拉
只会让操作员在噪声里找真设备。判据取"名字像 USB 串口"**或** VID:PID 就是 STM32 CDC
(`1d50:606f`, 与 `litearm.find_cdc_port` 认的是同一台设备)。

文件位置与夹爪那份同构 (`$XDG_CONFIG_HOME/litearm-studio/arm.json`), 用
`LITEARM_STUDIO_ARM_CONFIG` 覆盖 —— 测试与"配置放别处"的操作员都要能改。
读一份坏文件**不抛**: 认不出来就当作"没记住", 会话退回自动发现。
"""

from __future__ import annotations

import glob
import json
import logging
import os
import sys
import tempfile
import threading
from pathlib import Path
from typing import List, Optional, Tuple

log = logging.getLogger("litearm_studio_daemon.ports")

#: Environment override for the record file's location.
CONFIG_ENV = "LITEARM_STUDIO_ARM_CONFIG"

#: STM32 CDC 的 VID:PID —— `litearm.find_cdc_port()` 认的就是它。带这个 VID:PID 的
#: 设备排在下拉最前: 它几乎必然是我们要连的那台臂。
STM32_VID_PID: Tuple[int, int] = (0x1D50, 0x606F)

#: 按平台 glob 的候选名 (pyserial 不可用时的退路)。Linux 上 USB 串口只有这两类;
#: macOS 的 usbmodem/usbserial 同理。
_GLOBS_BY_PLATFORM = {
    "linux": ("/dev/ttyACM*", "/dev/ttyUSB*"),
    "darwin": ("/dev/tty.usbmodem*", "/dev/tty.usbserial*",
               "/dev/tty.SLAB_USBtoUART*"),
}

#: 名子串判据 (小写比较) —— 与上面的 glob 同义, 用在 pyserial 枚举出来的名字上。
_USB_SERIAL_MARKERS = ("ttyacm", "ttyusb", "usbmodem", "usbserial", "slab_usbto")


def default_config_path() -> Path:
    """``$XDG_CONFIG_HOME/litearm-studio/arm.json``, expanded."""
    override = os.environ.get(CONFIG_ENV)
    if override:
        return Path(override).expanduser()
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base).expanduser() if base else Path.home() / ".config"
    return root / "litearm-studio" / "arm.json"


def _looks_like_usb_serial(device: str) -> bool:
    name = os.path.basename(device).lower()
    return any(marker in name for marker in _USB_SERIAL_MARKERS)


def _pyserial_devices() -> List[Tuple[str, Optional[Tuple[int, int]]]]:
    """pyserial 枚举到的 (设备名, VID:PID) —— 拿不到就回空表。

    pyserial 由 `litearm` 带进来, 正常安装下都在; 但**这里不许因它缺席就崩**:
    串口列表少了 VID:PID 只是排序变差, 不是列不出设备 (下面还有 glob 那条退路)。
    """
    try:
        from serial.tools import list_ports as _list_ports
    except Exception:  # noqa: BLE001 - 缺 pyserial 不是错误, 只是少一条线索
        return []
    out: List[Tuple[str, Optional[Tuple[int, int]]]] = []
    try:
        comports = list(_list_ports.comports())
    except Exception:  # noqa: BLE001 - 枚举失败 (权限/驱动异常) 同上
        log.debug("pyserial 枚举串口失败", exc_info=True)
        return []
    for entry in comports:
        device = getattr(entry, "device", None)
        if not device:
            continue
        vid = getattr(entry, "vid", None)
        pid = getattr(entry, "pid", None)
        pair = (int(vid), int(pid)) if vid is not None and pid is not None else None
        out.append((str(device), pair))
    return out


def _glob_devices(platform: str) -> List[str]:
    patterns = _GLOBS_BY_PLATFORM.get(platform, ())
    out: List[str] = []
    for pattern in patterns:
        out.extend(glob.glob(pattern))
    return out


def _candidates() -> List[Tuple[str, Optional[Tuple[int, int]]]]:
    """这台机器上可能是机械臂的串口。

    Windows 上**全部** pyserial 串口都留: 那边没有 `/dev/ttyS*` 这种板载噪声, 而
    `COM*` 这个名字本身分不出 CDC 与普通 USB 串口 —— 用名字筛会把真设备筛掉。
    """
    devices = _pyserial_devices()
    if os.name == "nt":
        return devices
    # 非 Windows: 用名字/VID:PID 把板载口与虚拟口挡在外面。
    keep = [(d, vp) for d, vp in devices
            if vp == STM32_VID_PID or _looks_like_usb_serial(d)]
    known = {d for d, _ in keep}
    # pyserial 不可用 (或它没枚举到) 时按平台 glob 补一遍 —— 去重。
    for device in _glob_devices(sys.platform):
        if device not in known:
            keep.append((device, None))
            known.add(device)
    return keep


def list_serial_ports() -> List[str]:
    """候选串口路径, **STM32 CDC 排最前** —— 界面直接把第一条当默认选择。

    ⚠ 顺序是有意义的: 同名的两块 CDC 板子在下拉里分不出来, 而带上 VID:PID 的那台
    几乎必然是我们要连的臂。拿不到 VID:PID 时按名字排序, 顺序退化成"稳定"而不是
    "最优", 这一点在界面上由操作员自己确认。
    """
    cdc: List[str] = []
    others: List[str] = []
    for device, vid_pid in _candidates():
        (cdc if vid_pid == STM32_VID_PID else others).append(device)
    return sorted(set(cdc)) + sorted(set(others))


class LastPortStore:
    """记住「上次连上的串口」—— 重启守护进程之后仍是默认选择。

    与夹爪那份 (`gripper.config.ChannelStore`) 同一意图: 界面上选过的东西不该在下次
    启动时被忘掉。差别是这里只有**一个字符串**, 所以不引入 dataclass。

    ⚠ 它只是**默认值**, 不是"必须连这个口": 端口可以重新枚举成别的节点名
    (`/dev/ttyACM1` → `/dev/ttyACM0` 实测过), 拿它当硬性目标会让"上次那个口没了"
    变成连不上。见 `Session._connect_candidates`。
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path) if path is not None else default_config_path()
        self._lock = threading.Lock()
        self._loaded = False
        self._last: Optional[str] = None

    # ------------------------------------------------------------------ reading
    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as exc:
            # 坏文件 = 没记住。不抛: 一个读不懂的配置不该让守护进程起不来。
            log.warning("读不懂的机械臂端口记录 %s (已忽略): %s", self.path, exc)
            return
        value = raw.get("lastPort") if isinstance(raw, dict) else None
        if isinstance(value, str) and value.strip():
            self._last = value.strip()

    def last_port(self) -> Optional[str]:
        with self._lock:
            self._load()
            return self._last

    # ------------------------------------------------------------------ writing
    def remember(self, port: Optional[str]) -> None:
        """记下这次连上的口 —— 空值 = 什么都不记 (不改动已有的记录)。"""
        port = (port or "").strip()
        if not port:
            return
        with self._lock:
            self._load()
            if port == self._last:
                return
            self._last = port
            self._write()

    def _write(self) -> None:
        payload = {"lastPort": self._last}
        text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # Atomic: a reader (or a crash) never sees a partial file.
            fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), prefix=".arm-",
                                       suffix=".json")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(text)
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError as exc:
            # 记不住上次的口不是不连的理由: 下一次退回自动发现即可, 操作员不用知道。
            log.warning("无法写入机械臂端口记录 %s: %s", self.path, exc)
