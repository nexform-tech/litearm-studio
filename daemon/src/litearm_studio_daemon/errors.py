"""`litearm` 异常 → 线上错误对象。

契约见 REFACTOR_PLAN 3.1 节的 `res` 帧:

```jsonc
{"t":"res","id":7,"ok":false,"err":{"kind":"TransportError","msg":"…","cmd":0,"code":0}}
```

即 `{"kind": <类名>, "msg": str(e), "cmd": <可选>, "code": <可选>}`。

⚠ **`kind` 取的是 `type(e).__name__`**, 不是硬编码表 —— 这样 SDK 将来新增异常类时
前端**天然**能拿到新类名 (拿不到的那一类缺陷正是"映射表漏了一条")。
`cmd`/`code` **只在真正带这两个属性的异常上出现** (`CommandRejectedError` 及其子类),
其它异常不填 —— 填 `null` 会比不填更容易被前端误读成"固件回了 0"。
"""
from __future__ import annotations

from typing import Any, Optional

#: 本进程自造的错误类名 —— 它们**不来自** SDK, 前端可以把它们与固件/SDK 异常分开看。
#: ⚠ 刻意保留 `kind` 字段本身用 `type(e).__name__`: 这张表只用于文档与判据提示,
#: 不做任何翻译。
LOCAL_KIND_UNKNOWN_COMMAND = "UnknownCommandError"
LOCAL_KIND_MOTION_BUSY = "MotionBusyError"


def error_to_dict(exc: BaseException, method: Optional[str] = None) -> dict:
    """异常 → 线上错误对象。

    ⚠ **两个"命令"字段不许混用** (这正是上一版的一个真 bug): `method` 是**本守护
    进程**视角的命令名 (`"movej"`), `cmd` 是**固件回显的命令码** (`0x01`)。上一版把
    两者都写进 `cmd`, 于是 `CommandRejectedError` 的固件码会把命令名**覆盖**掉 ——
    调用方再也看不到是哪个命令失败的 (docstring 还写着"各自出现", 与实现相反)。
    现在两者各占一个键。
    """
    out: dict[str, Any] = {
        "kind": type(exc).__name__,
        "msg": str(exc),
    }
    if method is not None:
        out["method"] = method
    # `CommandRejectedError` 的 `.cmd` / `.code` 都是**可编程判定**用的 (见 SDK
    # `errors.py` 的类文档): `.cmd` 是固件回显的命令码, `.code` 是逐命令定义的错误码。
    # ⚠ 用 `hasattr` 而不是 `isinstance` —— 这样 SDK 之外自造的、形状相同的异常
    # (测试桩会用) 也能带出来; 形状不对时不猜, 直接不填。
    for name in ("cmd", "code"):
        val = getattr(exc, name, None)
        if isinstance(val, bool) or not isinstance(val, int):
            continue
        out[name] = int(val)
    # 激活那条路上的错误还带一个**短码** (`reason`): 界面靠它选文案 —— 而文案要分中英文,
    # 所以不能拿 `msg` 当判据 (那是守护进程写的中文)。见 `activation.py`。
    reason = getattr(exc, "reason", None)
    if isinstance(reason, str) and reason:
        out["reason"] = reason
    return out


class DaemonError(Exception):
    """本守护进程自己产生的错误基类 (不来自 SDK, 也不来自固件)。

    ⚠ 刻意**不**继承 `litearm.LiteArmError`: 那个层级表达的是"设备/链路上的事",
    把"前端发来一个不在白名单里的命令"混进去, 会让调用方那句
    `except LiteArmError` 把一个纯协议错误读成设备故障。
    """


class UnknownCommandError(DaemonError):
    """`m` 不在命令白名单里 (`kind` = `UnknownCommandError`)。"""

    def __init__(self, method: str, allowed: list[str]):
        super().__init__(
            f"未知命令 {method!r} —— 只接受白名单: {', '.join(allowed)}")
        self.method = method


class MotionBusyError(DaemonError):
    """已有运动在飞 —— 新的运动命令**立刻被拒**, 不排队 (`kind` = `MotionBusyError`)。

    计划 2 节原则 3: 「运动互斥 (`motionBusy`) 也在这一层判定」。**不排队**是刻意的:
    排队会把"我以为臂没动、其实马上要动"这个窗口拉长, 而前端此刻显示的是"拒绝"还是
    "稍后执行"完全两回事 —— 拒绝是确定性的, 排队不是。
    """

    def __init__(self, method: str):
        super().__init__(f"已有运动在途, 拒绝 {method} (不排队; 请等它结束或先 estop)")
        self.method = method


class GripperNotConnectedError(DaemonError):
    """A ``gripper.*`` command arrived before a gripper session exists.

    Two causes, and the message must not conflate them: the daemon has no
    gripper session at all (this build or platform has none, or ``--no-gripper``
    was given), or the session exists but is not connected to the bus.  The
    caller cannot act on the first by pressing 连接, so the session answers with
    the one that applies.
    """

    def __init__(self, detail: str = "夹爪会话尚未连接"):
        super().__init__(detail)


class GripperLinkError(DaemonError):
    """The CAN interface is missing, down, or bus-off."""


class GripperFaultActiveError(DaemonError):
    """The drive reports a latched fault (``errorCode`` outside 0 and 1)."""

    def __init__(self, code: int, message: str = ""):
        self.code = int(code)
        super().__init__(message or f"夹爪驱动故障 0x{code:X}")


class GripperCalibrationError(DaemonError):
    """No usable calibration for the requested motion."""


class GripperEstoppedError(DaemonError):
    """Motion refused while the gripper's stop latch is engaged."""


class GripperBusyError(DaemonError):
    """A second long operation (a probe) was requested while one was running."""


class NotConnectedCommandError(DaemonError):
    """会话未连接时就发命令。

    ⚠ 与 SDK 的 `NotConnectedError` **不同名不同类**: 后者表达"链路/会话没建起来",
    本类表达"守护进程这一侧没有可用的会话对象"。前端只看 `kind`, 两者都是
    `NotConnectedError` / `NotConnectedCommandError`, 可分辨。
    """
