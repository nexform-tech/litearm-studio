"""没有控制台时, 把"起不来的原因"送到操作员眼前。

谁读这个文件: 改启动路径 (`__main__.main`、`packaging/launcher.py`) 的人, 以及要回答
"Windows 上双击之后什么都没发生"的人。

**问题**。打出来的 Windows 产物是 **GUI 子系统**的 exe (见 `packaging/build.py` 的
`console_build_args`): 它没有控制台, 冻结之后 `sys.stdout` / `sys.stderr` 都是 `None`,
于是 `print` 与 logging 的 stderr 处理器一律静默。正常启动不受影响 —— 权威历史是
`obs` 写的那份 JSONL 文件, 界面也照常出现。但**失败**会跟着一起消失: "没有可用的
webview 后端"这条本来打在 stderr 上, 现在操作员看到的是"双击了, 一点反应都没有",
而那是这一整套设计里最贵的一种失败形状 (见 `window.WindowUnavailable`)。

**三条出路**, 覆盖启动路径的三种情形:

* `attach_parent_console()` —— 从终端启动时, 把两个流接回**启动我们的那个**终端。
  双击 (Explorer) 没有父控制台, 它什么也不做。
* `ensure_streams()` —— 两个流仍然是 `None` 时, 给它们一个丢弃一切的落点。**这一步
  不是洁癖, 而是能不能起来的问题**: uvicorn 的 `DefaultFormatter.__init__` 无条件调用
  `sys.stdout.isatty()` (`uvicorn/logging.py`), 配上 `None` 就是一句
  `AttributeError: 'NoneType' object has no attribute 'isatty'`, 而它抛在 `serve()` 里
  配日志的时候 —— 程序根本到不了能连的地步。实测: 少了这一步, `--windowed` 换来的不是
  "少一个控制台", 而是"打不开"。
* `show_fatal()` —— 没有可用的控制台时, 用 `MessageBoxW` 把原因弹出来。

⚠ 这三条都**不许**把异常漏出去。报错机制自己炸掉, 只会比"没报"更难查: 调用点都在
启动路径上, 那里没有任何东西接得住它。
"""
from __future__ import annotations

import logging
import os
import sys
from typing import Any, List, Optional, TextIO

from .window import APP_NAME

log = logging.getLogger(__name__)

#: `ensure_streams()` 安上的那个丢弃落点; 没安过是 `None`。
#:
#: ⚠ `show_fatal` **靠它**区分"真的有人能看见 stderr"与"我们只是让库有东西可写":
#: 后者下再写一遍就等于没报 —— 对话框才是那条路上唯一的出路。
_sink: Optional[TextIO] = None

#: 对话框的图标与置顶位 (Win32 `MessageBoxW` 的 `uType`)。
#:
#: `MB_SETFOREGROUND` 不是修饰: 双击启动时我们的进程刚起来、还没有窗口, 不抢前台
#: 对话框就会藏在别的窗口后面 —— 那一刻它和"没报"没有区别, 而它要报的正是"窗口
#: 起不来"。
_MB_ICONERROR = 0x00000010
_MB_SETFOREGROUND = 0x00010000


def on_windows() -> bool:
    """构建/运行在 Windows 上吗 —— 与 `window._on_ui_thread` 用同一个判据。"""
    return sys.platform == "win32"


def attach_parent_console() -> bool:
    """把 `stdout` / `stderr` 接回启动它的那个终端; 没有父控制台 (双击) 时返回 `False`。

    ⚠ **只在冻结产物里做**: 源码直跑时两个流本来就在, 而从管道里重开 `CONOUT$` 会把
    输出从管道理到控制台 —— `litearm-studio-daemon --log-stdout | jq` 那类用法当场坏掉。

    ⚠ **只补缺的, 绝不覆盖已经存在的那个**。`sys.stdout` / `sys.stderr` 是 `None` 等价于
    "这个流根本没有落点"; 只要它**在**, 就说明启动我们的人给了它一个去处 —— 命令行上的
    `> log.txt` 就是那个去处, 抢过来会让文件变成空的, 而人以为记下来了。

    ⚠ 两个流都在时连 `AttachConsole` 都不调: 没什么可接的, 少一次系统调用。

    ⚠ 要排在 `logging.basicConfig` 与 `obs.configure` **之前**: 两个处理器都在构造时
    抓一次 `sys.stderr` (见 `obs.handlers.stderr_handler`), 晚一步就抓在那个 `None` 上。

    ⚠ 已知的粗糙处: cmd.exe 的提示符在我们接上之前就已经打出来了, 所以输出接在提示符
    后面、还会和后续命令混在一起。这是 `AttachConsole` 的固有行为, 这里修不了;
    要干净的输出就重定向到文件 —— 那条路现在也照样成立 (见上一条)。
    """
    if not on_windows() or not getattr(sys, "frozen", False):
        return False
    missing = [name for name in ("stdout", "stderr") if getattr(sys, name, None) is None]
    if not missing:
        return False
    try:
        import ctypes  # noqa: PLC0415 - 只有 Windows 的冻结产物才走到这里

        #: `ATTACH_PARENT_PROCESS` —— 接父进程的控制台, 而不是新开一个。
        attached = ctypes.windll.kernel32.AttachConsole(-1)
        if not attached:
            return False
        for name in missing:
            # 行缓冲: 控制台的那一头是人, 不是采集器, 卡在缓冲区里等于没打。
            setattr(sys, name,
                    open("CONOUT$", "w", encoding="utf-8", errors="replace",  # noqa: SIM115
                         buffering=1))
        return True
    except Exception:  # noqa: BLE001 - 接不上只是"这次看不到输出", 不该拖垮启动
        log.debug("接不回父控制台", exc_info=True)
        return False


def ensure_streams() -> bool:
    """`sys.stdout` / `sys.stderr` 是 `None` 时给它们一个丢弃落点; 换过返回 `True`。

    排在 `attach_parent_console()` **之后**: 接得上父控制台就有真流, 接不上 (双击)
    才需要一个落点。两个流的处理是一样的 —— 弄坏程序的是 uvicorn 读 `stdout`, 而
    `--log-stdout` 与 `logging` 的默认处理器读 `stderr`, 只补一半等于没补。

    ⚠ 落点是 `os.devnull`, **不是**一个什么都不做的假对象: 有些库会顺着 `fileno()`
    走 (`isatty()` 只是最常见的那一个), 给一个真 fd 才能把那条路一起堵上。

    ⚠ 也**不是**把这两个流接到日志文件上。uvicorn 与 SDK 的人读日志有自己的格式,
    塞进 `obs` 的 JSONL 会把那份文件的格式破坏掉 (按它解析的采集器当场失败), 而那是
    权威历史 —— 见 `obs` 模块文档。丢进这里的东西权威历史里一条不少; 真正只存在于
    "给人看的一句话"里的那几条 (fatal) 由 `show_fatal` 走对话框, 不走这两个流。
    """
    global _sink

    if sys.stdout is not None and sys.stderr is not None:
        return False
    try:
        sink = open(os.devnull, "w", encoding="utf-8")
    except OSError:  # pragma: no cover - 打不开 devnull 是"系统坏了"这一档
        log.debug("打不开 %s, 这两个流就继续是 None", os.devnull, exc_info=True)
        return False
    _sink = sink
    for name in ("stdout", "stderr"):
        if getattr(sys, name, None) is None:
            setattr(sys, name, sink)
    return True


def show_fatal(message: str) -> bool:
    """把一条失败原因送到操作员眼前; 送到了返回 `True`。

    有可用的 stderr 就写 stderr —— 终端里跑的时候, 弹窗只是打扰。没有 (GUI 子系统的
    产物) 才在 Windows 上弹对话框。

    `False` 表示"这次没送到人眼前"。调用点用它做不了什么, 所以也不该据此分支; 它存在
    是为了让测试与将来的兜底有判据。
    """
    if _stderr_writable():
        print(f"[litearm-studio-daemon] {message}", file=sys.stderr)
        return True
    if on_windows():
        return _message_box(message)
    return False


def report_exception(exc: BaseException) -> bool:
    """未捕获异常的兜底 —— 冻结产物里那意味着"双击了, 什么都没发生"。

    对话框里只放**最后几行** traceback: 一屏放不下几百行, 而人先要读的是最后那条错误
    与它来自哪一行。完整记录在 `obs` 写的那份文件里, 所以这里把路径也给它。
    """
    try:
        lines = _exception_lines(exc)
        return show_fatal("程序因未处理的错误退出。\n\n"
                          + "".join(lines).strip()
                          + _log_hint())
    except Exception:  # noqa: BLE001 - 见模块文档最后一条
        log.debug("报不出这次未捕获异常", exc_info=True)
        return False


def _exception_lines(exc: BaseException, keep: int = 6) -> List[str]:
    """`traceback.format_exception` 的最后 `keep` 行 —— 抽出来是为了能单独测。"""
    import traceback  # noqa: PLC0415 - 只有这条兜底路径需要它

    lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
    return lines[-keep:]


def _log_hint() -> str:
    """日志文件在哪 —— 取不到就返回空串 (对话框里少一行, 比多一行谎话好)。"""
    try:
        from . import obs  # noqa: PLC0415 - 只有要报错时才需要

        path = obs.log_path()
    except Exception:  # noqa: BLE001 - 日志还没配起来就是"不知道"
        return ""
    return f"\n\n完整记录: {path}" if path else ""


def _stderr_writable() -> bool:
    """**有人能看见的** stderr 真的能写吗。

    `--windowed` 的产物里它是 `None`; 别处还可能是一个已经关掉的流 (父进程退出、
    管道断开), 所以光判 `is not None` 不够 —— 写一下才是答案。

    ⚠ 我们自己安的那个丢弃落点也算"没人看得见": 它写得进去, 但那正是问题 ——
    往 `os.devnull` 里写一句"窗口起不来", 与不写没有区别, 而它会让我们跳过对话框。
    """
    stream: Optional[Any] = sys.stderr
    if stream is None or stream is _sink:
        return False
    try:
        stream.write("")
        stream.flush()
    except Exception:  # noqa: BLE001 - 任何写不进去的原因都算"没有"
        return False
    return True


def _message_box(message: str) -> bool:
    """Win32 的对话框 —— GUI 子系统的产物没有别的出路。"""
    try:
        import ctypes  # noqa: PLC0415

        ctypes.windll.user32.MessageBoxW(None, message, APP_NAME,
                                         _MB_ICONERROR | _MB_SETFOREGROUND)
    except Exception:  # noqa: BLE001 - 弹不出来只是"这次没报成", 不能变成新的异常
        log.debug("弹不出对话框", exc_info=True)
        return False
    return True
