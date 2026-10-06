"""`dfu.engine` 的假件 —— 供 `--fake` 演示与离线测试使用。

为什么要一个**假引擎**而不是 monkeypatch：升级流水线要跨"应用态会话 → DFU 设备
→ 又是应用态会话"三个阶段，测试必须能断言**相位顺序**与**失败收尾**。真引擎要
pyusb + 一块真板子，而板子烧一次要人在场、臂要有支撑 —— 不能当日常回归。

它与 `dfu.engine` **同形**（`available` / `backend_status` / `find_device` /
`DfuDevice`），所以 `Session` 不需要知道自己在跟谁说话。
"""
from __future__ import annotations

import time
from typing import Callable, Optional


class FakeDfuError(Exception):
    """与 `engine.DfuError` 同义 —— 假的烧录失败。"""


class FakePermissionError(Exception):
    """模拟 libusb 的 `EACCES`（真机上是 udev 还没来得及 chmod 设备节点）。

    带 `errno=13`，与 `usb.core.USBError` 同形 —— 所以 `_is_permission_error` 那条
    判据在假件上也是真的在跑，不是"只有真机才走得到"的死代码。
    """

    def __init__(self, message: str = "[Errno 13] Access denied (insufficient permissions)"):
        super().__init__(message)
        self.errno = 13


class FakeDfuDevice:
    """一个假 DFU 设备：按 `steps` 推进度，可选在某一步失败。"""

    def __init__(self, dev: object = None, *, fail: Optional[str] = None,
                 steps: int = 8, step_delay: float = 0.0,
                 total_override: Optional[int] = None,
                 deny_open: bool = False):
        self.dev = dev
        #: `"flash"` = 烧录时报错；`None` = 成功。故意只支持一种失败，够用即可。
        self.fail = fail
        self.steps = max(1, int(steps))
        self.step_delay = float(step_delay)
        self.total_override = total_override
        #: 第一次 `open()` 是否报 EACCES（模拟"设备在、节点还没 chmod 好"）。
        self.deny_open = deny_open
        self.opened = False
        self.left = False
        self.policy: Optional[str] = None
        #: 最近一次 `flash()` 收到的 blob —— 测试用它断言"烧的正是上传的那份"。
        self.written: Optional[bytes] = None
        self.base: Optional[int] = None

    def open(self) -> "FakeDfuDevice":
        if self.deny_open:
            self.deny_open = False          # 只拒绝第一次 —— 模拟 udev 随后 chmod 好
            raise FakePermissionError()
        self.opened = True
        return self

    def flash(self, blob: bytes, base: int,
              progress: Callable[[int, int, str], None] | None = None,
              erase: bool = True, param_policy: str = "abort",
              verify: bool = True) -> None:
        self.written = blob
        self.base = base
        self.policy = param_policy
        total = self.total_override if self.total_override is not None else len(blob)
        for i in range(1, self.steps + 1):
            if self.step_delay:
                time.sleep(self.step_delay)
            if progress:
                progress(int(total * i / self.steps), total,
                         f"写入 {int(total * i / self.steps)}/{total} B (假件)")
        if self.fail == "flash":
            raise FakeDfuError("假件: 读回校验失败 (首个不一致处 0x08000100)")
        if progress:
            progress(total, total, f"✓ 读回校验通过 ({total} B 逐字节一致, 假件)")

    def close(self) -> None:
        self.opened = False

    def leave(self, reset: bool = True) -> None:
        self.left = True
        self.close()


class FakeEngine:
    """`dfu.engine` 的同形替身。默认**总能烧成功**。"""

    DfuError = FakeDfuError

    def __init__(self, *, fail: Optional[str] = None, steps: int = 8,
                 step_delay: float = 0.0, present: bool = True,
                 deny_open_times: int = 0):
        self.fail = fail
        self.present = present
        self.steps = steps
        self.step_delay = step_delay
        #: 头 `n` 次 `open()` 报 EACCES —— 模拟"设备已经枚举出来, 但 udev 还没 chmod
        #: 好节点"。真机演练撞到过：`find_device()` 成功、`open()` 却 Access denied。
        self.deny_open_times = deny_open_times
        self._denied = 0
        #: 造过几个 `DfuDevice` —— 用来钉"存在≠可用"那次重试。
        self.last: Optional[FakeDfuDevice] = None
        self.devices_made = 0

    def available(self) -> bool:
        return True

    def backend_status(self) -> str:
        return "假件 (--fake / 测试)"

    def find_device(self):
        return object() if self.present else None

    def DfuDevice(self, dev=None, transfer_size=None) -> FakeDfuDevice:  # noqa: N802
        deny = self._denied < self.deny_open_times
        if deny:
            self._denied += 1
        self.last = FakeDfuDevice(dev, fail=self.fail, steps=self.steps,
                                  step_delay=self.step_delay, deny_open=deny)
        self.devices_made += 1
        return self.last
