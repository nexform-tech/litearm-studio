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
import tempfile
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


def storage_dir() -> Path:
    """窗口自己的持久化目录 —— cookies、localStorage、IndexedDB。

    ⚠ 与结构化日志共用同一个状态根 (`obs.handlers.default_log_dir()`), 于是"程序把东西
    放哪"只有一个答案。是 state 不是 cache: 界面存的是操作员的设置, 按缓存的规矩清掉就
    等于每次启动都恢复出厂。
    """
    from .obs.handlers import default_log_dir  # noqa: PLC0415 - 只在开窗时才需要

    return default_log_dir() / "webview"


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


def _enable_downloads(webview: Any) -> None:
    """把下载交给窗口宿主 —— 界面上两个导出按钮 (日志 JSONL、遥测 CSV) 的落点。

    ⚠ pywebview 的 `ALLOW_DOWNLOADS` 默认 **`False`**, 而它管的不是"允不允许下载",
    而是**宿主接不接管这次下载**。默认值下两个后端坏在不同地方 (均按源码核对 6.2.1):

    * **Linux / GTK** (`platforms/gtk.py`) —— `download-started` 从不连接, 于是
      **永远没有保存对话框**。WebKit 退回到自己的默认落点: 有 XDG 下载目录就静默写进
      `~/Downloads`, 没有就写进 `$HOME` 根下, 再写不进去 (目录不可写) 就直接取消这次
      下载。操作员看到的是"按了没反应", 文件却可能躺在别的地方。
    * **Windows / WebView2** (`platforms/edgechromium.py`) —— 它的
      `on_download_starting` 在 `False` 时**直接 `args.Cancel = True`**: 下载被取消,
      什么都不产生。

    打开之后两个后端都由宿主弹原生保存对话框 (GTK 是 `GtkFileChooserAction.SAVE`,
    Windows 是 WinForms 的 `SaveFileDialog`), 对话框里的默认文件名取自页面给的
    `download` 属性 —— 这正是"文件存到操作员自己选的地方"所需要的全部。

    ⚠ **页面正常不走这条路**: 导出走 `POST /api/export`, 由本进程自己弹对话框、自己写
    文件 (见 `server.create_app`)。这一条是它的兜底 —— 页面够不到接口时 (纯浏览器运行、
    静态部署) 回退到 `<a download>`, 那时"有没有对话框"就取决于这个开关。

    ⚠ 必须在 `webview.start()` **之前**设: 两个后端都是在建视图时读这个开关的
    (GTK 在 `BrowserView.__init__` 里连接信号)。
    """
    webview.settings['ALLOW_DOWNLOADS'] = True


def default_export_dir() -> Path:
    """保存导出文件时对话框从哪个目录开始。

    平台自己的"下载"目录, 依次退化到主目录与临时目录 —— **绝不返回不存在的路径**:

    * `Window.create_file_dialog` 会把不存在的目录换成空串, 原生对话框于是从它自己的
      默认位置开始 (没有错误, 只是不如人意);
    * 更要紧的是 pywebview 的 GTK 下载处理器: 它直接把 `glib` 的 XDG 查询结果塞给
      `GtkFileChooser.set_current_folder`, 而那个查询在**没有 `user-dirs.dirs`** 的
      机器上返回 `None`, PyGObject 随即抛 `TypeError` —— 对话框根本弹不出来 (issue
      #104 里"按了没反应"的一种成因)。所以这里不查 XDG, 自己按存在性挑。
    """
    home = Path.home()
    for candidate in (home / "Downloads", home):
        if candidate.is_dir():
            return candidate
    return Path(tempfile.gettempdir())


def _on_ui_thread(window: Any, call: Callable[[], Any]) -> Any:
    """在 GUI 线程上执行 `call` —— 只有 Windows 需要, GTK/Qt 不需要。

    pywebview 的 GTK 与 Qt 后端自己会把对话框投递到 GUI 线程再等结果
    (`glib.idle_add` / 信号 + 旗语), 所以从 uvicorn 的线程池里直接调是安全的。
    **Windows 后端不编组**: `winforms.create_file_dialog` 直接
    `dialog.ShowDialog(form)`, 而 WinForms 只允许在 UI 线程上开窗口 —— 它会抛
    `InvalidOperationException`, 又被 pywebview 自己吞掉并返回 `None`, 表现就是
    "操作员按了导出、什么也没发生"。这里补上这一步编组。

    ⚠ 编组失败 (没有 pythonnet、拿不到后端实例) 就照旧直接调用: 那条路在 GTK/Qt 上是
    对的, 在 Windows 上也不会比不编组更差。
    """
    if sys.platform != "win32":
        return call()
    try:
        from System import Func, Type  # noqa: PLC0415 - pythonnet, 只有 Windows 上有
        from webview.platforms import winforms  # noqa: PLC0415 - 只有 Windows 上有

        instance = winforms.BrowserView.instances.get(window.uid)
        if instance is None:
            return call()
        return instance.Invoke(Func[Type](call))
    except Exception:  # noqa: BLE001 - 编组只是"更好", 不是"必须"
        log.debug("无法把这次调用编组到 UI 线程, 直接调用", exc_info=True)
        return call()


class WindowHandle:
    """窗口把手 —— 抬窗口 (第二次启动的落点) 与"导出存到哪"都由它做。

    ⚠ 这些方法会被 **HTTP 线程**调用 (`POST /api/focus`、`POST /api/export`), 不是
    GUI 线程。pywebview 自己会把 GTK/Qt 的调用投递到 GUI 线程, Windows 那一路由
    `_on_ui_thread` 补上; 抬不起来、对话框开不出来也只是"没抬起来 / 没导出", 不影响
    机械臂会话。
    """

    def __init__(self, window: Any, *, save_dialog: int) -> None:
        self._window = window
        #: `webview.FileDialog.SAVE` —— 由 `run_window` 传入, 因为这个模块**不能**在
        #: 顶层 import webview (GUI 是软依赖, 无界面运行的机器上根本没有它)。
        self._save_dialog = save_dialog

    def raise_window(self) -> None:
        self._window.restore()
        self._window.show()

    def ask_save_path(self, suggested_name: str) -> Optional[str]:
        """弹原生保存对话框, 返回操作员选定的路径; 取消 (或开不出来) 返回 `None`。

        对话框里预填 `suggested_name` —— 那是页面给的、我们自己的文件名
        (见 `LogsPage` / `useTelemetryState` 的导出)。
        """
        def _ask() -> Optional[str]:
            chosen = self._window.create_file_dialog(
                self._save_dialog, str(default_export_dir()), False, suggested_name, ())
            if not chosen:
                return None
            # ⚠ pywebview 在"对话框关了但没有文件名"时回的是 `(None,)` —— 它不是路径,
            # 不能让它变成字符串 `"None"` 再被写成一个名叫 None 的文件。
            first = chosen[0]
            return str(first) if first else None

        path = _on_ui_thread(self._window, _ask)
        return path or None


def run_window(url: str, *, on_ready: Callable[[Any], None],
               title: str = APP_NAME) -> None:
    """在 `url` 打开应用窗口, 并**阻塞到窗口关闭**。

    `on_ready` 在 GUI 起来之前拿到 `WindowHandle`, 供 `/api/focus` 与 `/api/export`
    (导出文件的保存对话框) 使用。

    ⚠ **返回即代表操作员关掉了窗口** —— 这是本程序唯一的正常退出信号 (另一个是进程收到
    信号)。调用者据此收尾即可, 不需要再判断任何状态。
    """
    webview = _import_webview()
    _enable_downloads(webview)
    _set_desktop_identity()
    window = webview.create_window(title, url=url,
                                   width=WINDOW_SIZE[0], height=WINDOW_SIZE[1],
                                   min_size=WINDOW_MIN_SIZE)
    if window is None:  # pragma: no cover - 只有后端异常时才会
        raise WindowUnavailable(_unavailable_message("pywebview 没有创建窗口"))
    on_ready(WindowHandle(window, save_dialog=int(webview.FileDialog.SAVE)))
    log.info("应用窗口已打开: %s", url)
    try:
        # ⚠ `icon` 是 `start()` 的参数而不是 `create_window()` 的 (6.2.1 的签名如此)。
        # GTK 与 Qt 两个后端都会用它: `gtk.py` 的 `set_icon_from_file` /
        # `set_default_icon_from_file`, `qt.py` 的 `QIcon(...)` + `setWindowIcon`。
        #
        # ⚠ **`private_mode` 必须显式关掉, 并给一个持久的 `storage_path`。** pywebview
        # 的默认值是 `True`, 而它在 GTK 后端建的是 `WebKitWebContext.new_ephemeral()`
        # —— 那意味着**界面自己存的东西一样都不留**: 速度、夹持力、主题、指标选择、
        # 遥测保留上限, 以及遥测那份 IndexedDB, 每次启动都回到出厂值。界面的持久化是
        # 产品行为, 不是可有可无的优化。
        #
        # 顺带它也把一处崩溃的温床关掉了: 存储不可用时浏览器**会抛**, 而 `localStorage`
        # 的读取点里原本有一个没做防护 (`useGripperPanel.readStored`), 它的调用点是
        # `useState` 的惰性初始化 —— 一抛就是整页控制台被错误边界替换。那一处已经补上
        # 防护 (前端不该因为存储不可用而死), 这里再从源头保证它可用。
        webview.start(icon=icon_file(), private_mode=False,
                      storage_path=str(_ensure_storage_dir()))
    except WindowUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - 后端起不来 (没有 GTK/Qt) 也走这条
        raise WindowUnavailable(_unavailable_message(exc)) from exc


def _ensure_storage_dir() -> Path:
    """把 `storage_dir()` 建出来再交给 pywebview —— 各后端不一定自己会建。"""
    path = storage_dir()
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError:
        # 建不出来也照样把路径给出去: 窗口该开还得开, 大不了这次不持久化。
        log.warning("无法创建窗口存储目录 %s", path, exc_info=True)
    return path
