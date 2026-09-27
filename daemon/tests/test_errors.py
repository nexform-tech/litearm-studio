"""`errors` 的异常 → 线上错误对象转换。"""
from __future__ import annotations

from litearm.errors import CommandRejectedError, TransportError

from litearm_studio_daemon.errors import (
    DaemonError,
    MotionBusyError,
    NotConnectedCommandError,
    UnknownCommandError,
    error_to_dict,
)


def test_basic_shape() -> None:
    assert error_to_dict(TransportError("打不开串口")) == {
        "kind": "TransportError",
        "msg": "打不开串口",
    }


def test_daemon_method_context_uses_its_own_key() -> None:
    """守护进程的命令名走 `method`, 不与固件的 `cmd` 抢同一个键。"""
    out = error_to_dict(ValueError("q 不对"), method="movej")
    assert out["kind"] == "ValueError"
    assert out["method"] == "movej"
    assert "cmd" not in out


def test_command_rejected_keeps_both_method_and_firmware_code() -> None:
    """回归用例 —— 上一版固件码会把 `method` 覆盖掉, 调用方看不到是哪个命令失败。"""
    exc = CommandRejectedError("固件拒绝", cmd=0x01, code=0x03)
    out = error_to_dict(exc, method="movej")
    assert out["kind"] == "CommandRejectedError"
    assert out["method"] == "movej"     # 守护进程视角
    assert out["cmd"] == 0x01           # 固件回显的命令码
    assert out["code"] == 0x03


def test_bool_is_not_treated_as_int() -> None:
    """`True` 也是 `int`, 但它不是命令码 —— 不许填进 `cmd`/`code`。"""

    class Weird(Exception):
        cmd = True
        code = False

    out = error_to_dict(Weird("x"))
    assert "cmd" not in out
    assert "code" not in out


def test_daemon_errors_are_not_sdk_errors() -> None:
    """自造错误刻意不继承 `LiteArmError`: 「命令不在白名单」不是设备故障。"""
    import litearm

    for exc in (UnknownCommandError("nope", ["enable"]),
                MotionBusyError("movej"),
                NotConnectedCommandError("未连接")):
        assert isinstance(exc, DaemonError)
        assert not isinstance(exc, litearm.LiteArmError)
        assert error_to_dict(exc)["kind"] == type(exc).__name__


def test_unknown_command_error_lists_the_whitelist() -> None:
    exc = UnknownCommandError("nope", ["enable", "movej"])
    assert "nope" in str(exc)
    assert "enable" in str(exc) and "movej" in str(exc)


def test_motion_busy_error_says_it_does_not_queue() -> None:
    assert "不排队" in str(MotionBusyError("movej"))
