"""应用窗口 —— 由守护进程自己拥有, 因此关掉窗口就是退出整个程序。

谁读这个文件: 改启动路径的人, 以及要回答"为什么关掉窗口进程就没了"的人。

**为什么是嵌入式窗口, 而不是让浏览器开一个。** 硬件 I/O 在这个 Python 进程里 (见
`session` 与 `litearm-python`), 而界面跑在浏览器内核里, 于是"程序"天然裂成两个进程。
让操作系统里的 Chrome 持有窗口时, 关掉那个窗口与守护进程毫无关系 —— 串口继续被握着,
界面却没了; 操作员用"一个程序"的心智去关它, 关出的是另一种结果。

这里改成任何桌面程序都一样的做法: **窗口由持有硬件的进程自己创建**。于是:

* 关掉窗口 ⇒ `webview.start()` 返回 ⇒ 调用方收尾 ⇒ 失能 + 释放串口。没有计时器,
  没有心跳, 没有宽限期 —— 窗口活着就是进程活着。
* 刷新页面**不会**退出: 刷新发生在浏览器内核里, 窗口与进程都还在。旧做法要区分
  "刷新"和"关窗"必须靠猜, 这里不需要。
* 窗口、任务栏图标、单实例都归我们自己, 不再借用用户的浏览器 —— 机器上没装任何
  浏览器也能用。
* 第二次启动可以**把已有窗口抬到前面** (见 `WindowHandle`), 这是桌面程序的规范行为。

**代价, 如实写在最前面。** 需要一个 webview 后端:

* Linux 的 GTK 后端依赖系统包 (`python3-gi` / `gir1.2-webkit2-4.1`), 这些包 pip 装不了;
* Qt 后端 (`pywebview[qt]`) 是纯 pip 安装、不需要 apt, 所以本项目的 `ui` extra 走它
  (见 `daemon/pyproject.toml`);
* Windows 用系统自带的 WebView2, macOS 用 WKWebView, 都不需要额外安装。
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)

#: 窗口标题, 也是桌面条目里的 `Name`。
APP_NAME = "LiteArm Studio"

#: 应用 id。这一个字符串同时决定三件事, 所以只能有一个来源:
#: 窗口的 WM_CLASS / Qt 的 desktopFileName, 以及 `packaging/deb.py` 桌面条目里的
#: `StartupWMClass`。
#:
#: ⚠ 三者必须相等, 否则桌面会把窗口和启动图标当成两个不同的程序 —— 表现就是任务栏里
#: 显示的是别人的图标。`packaging/tests/test_deb.py` 钉住这个等式。
WINDOW_CLASS = "litearm-studio"

#: 窗口的初始尺寸与下限。取自旧 Tauri 壳的 `tauri.conf.json`, 界面在更小的尺寸下会挤。
WINDOW_SIZE = (1440, 900)
WINDOW_MIN_SIZE = (1024, 700)


class WindowUnavailable(RuntimeError):
    """没有可用的 webview 后端。

    ⚠ 调用者必须**明说**, 不能静默退回无界面: 那会重现"操作员以为程序关了、进程还在
    握着串口"这个原始缺陷。要无界面运行请显式 `--no-open`。
    """


def icon_file() -> Optional[str]:
    """窗口/任务栏用的 PNG; 本构建没带图标时返回 `None`。

    查找顺序与 `server.resolve_ui_dir` 同构: 显式覆盖 → 冻结包内 → 仓库检出。
    找不到只是"窗口用默认图标", 绝不该让程序起不来。
    """
    candidates = []
    override = os.environ.get("LITEARM_STUDIO_ICON", "").strip()
    if override:
        candidates.append(Path(override).expanduser())
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        candidates.append(Path(bundle) / "assets" / "icon-png" / "icon-256.png")
    for parent in Path(__file__).resolve().parents:
        candidates.append(parent / "assets" / "icon-png" / "icon-256.png")
    for path in candidates:
        try:
            if path.is_file():
                return str(path)
        except OSError:  # pragma: no cover - 权限/路径异常都只是"这个位置没有"
            continue
    log.debug("没有找到窗口图标 (找了 %d 个位置)", len(candidates))
    return None


def _set_desktop_identity() -> None:
    """把进程的应用名设成 `WINDOW_CLASS`, 好让桌面把窗口归到我们的启动图标下。

    ⚠ **必须在窗口创建之前**调用: GTK 的 WM_CLASS 取自 GLib 的程序名, Qt 的取自
    `QCoreApplication.applicationName()` / `desktopFileName`, 两者都在创建窗口时读一次。
    pywebview 自己**不设**这两样 (已核对 6.2.1 的 `platforms/gtk.py` 与 `platforms/qt.py`),
    于是默认值是 Python 解释器/可执行文件名, 桌面找不到 `litearm-studio.desktop`, 就
    借用了通用图标。

    每一步独立失败: 只装了其中一个后端是正常情况, 缺哪个都不该报错。
    """
    try:
        from gi.repository import GLib  # noqa: PLC0415 - 有 GTK 后端才有

        # `set_prgname` 喂的是 X11 的 WM_CLASS **instance** 与 Wayland 的 app id —— 两者
        # 都正是 `WINDOW_CLASS`，桌面据此就能对上 `litearm-studio.desktop`。
        #
        # ⚠ X11 的 WM_CLASS **class** 那一半我们控制不了：实测它在 GTK 里既不跟着
        # `set_prgname` 也不跟着 `set_application_name`（`Gdk.set_program_class` 也被
        # GTK 初始化时覆盖掉了，设了与不设完全一样）。GTK 给出的是 `Litearm-studio`
        # ——与 `StartupWMClass=litearm-studio` 只差首字母大小写。桌面的匹配对
        # instance 与 class 都会试，且实际比较不区分大小写，所以图标能归对组;
        # 万一某台机器上不行，改 `deb.desktop_entry()` 的 `StartupWMClass` 即可。
        GLib.set_prgname(WINDOW_CLASS)
        GLib.set_application_name(APP_NAME)
    except Exception:  # noqa: BLE001 - 没有 GTK 后端
        log.debug("未设置 GTK 程序名 (没有 GTK 后端)", exc_info=True)

    for module in ("qtpy", "PyQt6", "PySide6"):
        try:
            core = __import__(f"{module}.QtCore", fromlist=["QCoreApplication"])
            gui = __import__(f"{module}.QtGui", fromlist=["QGuiApplication"])
            core.QCoreApplication.setApplicationName(WINDOW_CLASS)
            gui.QGuiApplication.setDesktopFileName(WINDOW_CLASS)
            return
        except Exception:  # noqa: BLE001 - 换下一个绑定
            log.debug("未通过 %s 设置 Qt 应用名", module, exc_info=True)


def _import_webview() -> Any:
    try:
        import webview  # noqa: PLC0415 - GUI 依赖必须是软依赖, 见模块 docstring
    except Exception as exc:  # noqa: BLE001 - 缺包之外还可能缺后端
        raise WindowUnavailable(_unavailable_message(exc)) from exc
    return webview


def _unavailable_message(cause: Any) -> str:
    return ("无法打开应用窗口: 没有可用的 webview 后端。\n"
            "    Linux（推荐, 用系统的 WebKitGTK）:\n"
            "        apt install python3-gi gir1.2-webkit2-4.1\n"
            "    或者自带内核的 Qt（不需要 apt, 但多 ~200 MB）:\n"
            "        pip install \"litearm-studio-daemon[ui-qt]\"\n"
            "    或者无界面运行:\n"
            "        litearm-studio-daemon --no-open\n"
            f"    (原始错误: {cause})")


class WindowHandle:
    """窗口把手 —— 目前唯一的用途是"把窗口抬到前面" (第二次启动的落点)。

    ⚠ 这些方法会被 **HTTP 线程**调用 (`POST /api/focus`), 不是 GUI 线程。pywebview
    自己会把调用投递到 GUI 线程, 所以这里可以直接调; 抬不起来也只是没抬起来。
    """

    def __init__(self, window: Any) -> None:
        self._window = window

    def raise_window(self) -> None:
        self._window.restore()
        self._window.show()


def run_window(url: str, *, on_ready: Callable[[Any], None],
               title: str = APP_NAME) -> None:
    """在 `url` 打开应用窗口, 并**阻塞到窗口关闭**。

    `on_ready` 在 GUI 起来之前拿到 `WindowHandle`, 供 `/api/focus` 使用。

    ⚠ **返回即代表操作员关掉了窗口** —— 这是本程序唯一的正常退出信号 (另一个是进程收到
    信号)。调用者据此收尾即可, 不需要再判断任何状态。
    """
    webview = _import_webview()
    _set_desktop_identity()
    window = webview.create_window(title, url=url,
                                   width=WINDOW_SIZE[0], height=WINDOW_SIZE[1],
                                   min_size=WINDOW_MIN_SIZE)
    if window is None:  # pragma: no cover - 只有后端异常时才会
        raise WindowUnavailable(_unavailable_message("pywebview 没有创建窗口"))
    on_ready(WindowHandle(window))
    log.info("应用窗口已打开: %s", url)
    try:
        # ⚠ `icon` 是 `start()` 的参数而不是 `create_window()` 的 (6.2.1 的签名如此)。
        # GTK 与 Qt 两个后端都会用它: `gtk.py` 的 `set_icon_from_file` /
        # `set_default_icon_from_file`, `qt.py` 的 `QIcon(...)` + `setWindowIcon`。
        webview.start(icon=icon_file())
    except WindowUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - 后端起不来 (没有 GTK/Qt) 也走这条
        raise WindowUnavailable(_unavailable_message(exc)) from exc
