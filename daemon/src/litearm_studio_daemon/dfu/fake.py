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


class FakeDfuDevice:
    """一个假 DFU 设备：按 `steps` 推进度，可选在某一步失败。"""

    def __init__(self, dev: object = None, *, fail: Optional[str] = None,
                 steps: int = 8, step_delay: float = 0.0,
                 total_override: Optional[int] = None):
        self.dev = dev
        #: `"flash"` = 烧录时报错；`None` = 成功。故意只支持一种失败，够用即可。
        self.fail = fail
        self.steps = max(1, int(steps))
        self.step_delay = float(step_delay)
        self.total_override = total_override
        self.opened = False
        self.left = False
        self.policy: Optional[str] = None
        #: 最近一次 `flash()` 收到的 blob —— 测试用它断言"烧的正是上传的那份"。
        self.written: Optional[bytes] = None
        self.base: Optional[int] = None

    def open(self) -> "FakeDfuDevice":
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
                 step_delay: float = 0.0, present: bool = True):
        self.fail = fail
        self.present = present
        self.steps = steps
        self.step_delay = step_delay
        #: 最后一次 `DfuDevice(...)` 造出来的设备 —— 测试断言它 `opened`/`left`。
        self.last: Optional[FakeDfuDevice] = None
        self.flash_calls = 0

    def available(self) -> bool:
        return True

    def backend_status(self) -> str:
        return "假件 (--fake / 测试)"

    def find_device(self):
        return object() if self.present else None

    def DfuDevice(self, dev=None, transfer_size=None) -> FakeDfuDevice:  # noqa: N802
        self.last = FakeDfuDevice(dev, fail=self.fail, steps=self.steps,
                                  step_delay=self.step_delay)
        self.flash_calls += 1
        return self.last
