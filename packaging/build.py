"""把 daemon + SDK + 界面打成一个可执行程序（计划 Phase 5）。

用法（**仓库根目录**执行，且 `pnpm build` 已经产出 `dist/`）：

```bash
python packaging/build.py
# 产物：packaging/dist/litearm-studio-daemon[.exe]              （单文件，默认）

LITEARM_STUDIO_BUNDLE_MODE=onedir python packaging/build.py
# 产物：packaging/dist/litearm-studio-daemon/litearm-studio-daemon[.exe]
```

两种形态的取舍见 `bundle_mode()`：单文件每次启动都要把整包解到临时目录，目录不用。

三件事：

* **版本来源唯一**：优先环境变量 `LITEARM_STUDIO_VERSION`（CI 传 git tag），否则
  `git describe --tags`，再否则 `0.0.0+dev`。写进 `_build_version.py`（构建产物，
  不入库，见 `.gitignore`）—— 这样 `hello.daemon` 报的就是发出去的那个 tag，
  而不是 manifest 里的 `0.0.0+semantic-release` 占位符。
* **把界面打进包**：`dist/` 以 `--add-data` 放到 `_MEIPASS/dist`，
  `server.resolve_ui_dir()` 认识这个冻结路径（免手工 `--ui-dir`）。
* **把 SDK 打进包**：两个 SDK 都不在 PyPI 上，来源**只有一个** —— 本仓的 git
  submodule（`sdk/`，tag 即版本），开发 venv / CI / `.deb` 容器 / Windows 构建都
  从它装（`make sdk`）。`litearm` 连同 `pyserial` 一起内嵌。
* **夹爪 SDK 按平台收**：`litegrip` 需要 `fcntl` / `PF_CAN`，Windows 上装了也
  import 不了 —— 那里的构建**不收它**，产物里夹爪是缺席的（D10）。Linux 上缺它
  则**直接判失败**：一个"忘了装 SDK"的 Linux 产物会静默地没有夹爪，而那是发布物
  必须具备的能力。
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

# ⚠ Windows 控制台默认是 cp1252: 打中文会抛 `UnicodeEncodeError`, 让**整个构建步骤**
# 判失败 —— 实测 CI 上 PyInstaller 已经成功, 却死在后一句 `print` 上。先切 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001 - 非标准流/老解释器就保持原样
        pass

ROOT = Path(__file__).resolve().parents[1]
DAEMON_SRC = ROOT / "daemon" / "src"
UI_DIST = ROOT / "dist"
OUT_DIST = ROOT / "packaging" / "dist"
WORK = ROOT / "packaging" / "build"
VERSION_FILE = DAEMON_SRC / "litearm_studio_daemon" / "_build_version.py"
#: 打包期注入的激活服务地址（可选）。与版本号同一个套路：构建时生成、不入库、
#: 用完删掉。见 `activation.default_activation_url()`。
ACTIVATION_URL_FILE = DAEMON_SRC / "litearm_studio_daemon" / "_build_activation_url.py"
EXE_NAME = "litearm-studio-daemon"

#: 窗口后端的选择。`gtk` 借系统的 WebKitGTK（产物小），`qt` 自带 Chromium（产物 ~240 MB）。
#: 没设就自动：有 GTK 用 GTK，否则 Qt。见 `window_backend()`。
WINDOW_BACKEND_ENV = "LITEARM_STUDIO_WINDOW_BACKEND"

#: GTK 后端要显式点名的 gi 模块。`Gtk` 那个钩子会把 libgtk-3 及其传递依赖一起收进来；
#: `WebKit2` **没有** PyInstaller 钩子，它的 typelib 与 `libwebkit2gtk` 必须由 `.deb` 的
#: `Depends` 提供（见 `deb.control_text`）。
GTK_MODULES = ("Gtk", "Gdk", "GdkPixbuf", "Gio", "GLib", "GObject", "Pango", "Atk")
# Windows 可执行文件的图标。不传 `--icon` 时 PyInstaller 会用它自带的默认图标 ——
# 发出去的程序在资源管理器/任务栏里就是那个通用图标，而不是我们的标识。
# Linux 的 ELF 不嵌图标，这个参数在 Linux 上只是被 PyInstaller 接受后忽略。
ICON = ROOT / "assets" / "litearm.ico"

#: 我们自己的 PyInstaller 钩子目录（见 `packaging/hooks/`）。目前只有一条：GTK 那条
#: 图标主题白名单。它**替代**（不是补充）PyInstaller 自带的同名钩子 —— PyInstaller
#: 每个模块只留一条钩子，同名的用户钩子优先。
HOOKS_DIR = ROOT / "packaging" / "hooks"


def resolve_version() -> str:
    """tag > git describe > 兜底。统一的去 `v` 前缀口径由调用方决定。"""
    env = os.environ.get("LITEARM_STUDIO_VERSION", "").strip()
    if env:
        return env
    try:
        described = subprocess.check_output(
            ["git", "describe", "--tags", "--always"], cwd=ROOT, text=True,
            stderr=subprocess.DEVNULL).strip()
        return described or "0.0.0+dev"
    except Exception:  # noqa: BLE001 - 没有 git 也能构建（只是版本不精确）
        return "0.0.0+dev"


def resolve_activation_url() -> str:
    """打包期注入的激活服务地址；没给就返回空串（用 daemon 里的内置生产地址）。

    ⚠ 与版本号不同，这个**不是必填**：正式包用内置默认即可。它存在是为了能用同一份
    源码出指向别的环境的包（staging / 本地联调），而**不**要求终端用户设环境变量。
    """
    url = os.environ.get("LITEARM_ACTIVATION_URL", "").strip()
    if not url:
        return ""
    # 形态闸门放在这里：写进包的地址要是坏串，打包照样成功，用户端只会看到"连不上
    # 激活服务" —— 而那正是这个功能要消灭的那种失败。
    if not url.startswith(("http://", "https://")):
        raise SystemExit(f"LITEARM_ACTIVATION_URL 必须是 http(s) 地址，实得 {url!r}")
    return url


def activation_build_args(url: str) -> list[str]:
    """注入地址时，显式让 PyInstaller 收下那个模块。

    ⚠ `activation.py` 那句 import 在**函数体内**（惰性，好让源码直接运行时不必有这个
    文件）。PyInstaller 的静态分析通常能找到函数内 import，但那取决于它有没有把该模块
    扫进依赖图。显式 hidden-import 是"地址不许静默丢掉"的兜底 —— 丢掉的话打包照样
    成功，而发出去的包仍然连内置的生产地址。
    """
    if not url:
        return []
    return ["--hidden-import", "litearm_studio_daemon._build_activation_url"]


#: 夹爪 SDK 的平台判据。与 daemon 侧的 `__main__.build_gripper_session` 同一条口径：
#: Linux 上提供，别处缺席。这里用 `sys.platform` 而不是 `os.name`，因为判据是
#: PF_CAN（POSIX 内核特性）而不是"是不是 Windows"。
GRIPPER_PLATFORMS = ("linux",)


def sdk_available(name: str) -> bool:
    """这个包在当前解释器里装了吗（不 import 它 —— import 会执行模块代码）。"""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):  # pragma: no cover - 名字被别的包挡住
        return False


def arm_build_args() -> list[str]:
    """机械臂 SDK（`litearm` 与它带来的 `pyserial`）的 PyInstaller 参数。

    ⚠ 缺了要**判失败**，理由与下面那三条一样，只是后果更早发生：`litearm` 是靠
    submodule 装进来的（不在 PyPI 上），一个没装它的构建照样"成功" —— PyInstaller
    把解析不到的 `import litearm` 当 WARNING 放行，于是产物能启动、一连臂就
    ModuleNotFoundError。那是发布物里最不该有的一种缺陷：只有插上真机才暴露。
    """
    missing = [n for n in ("litearm", "serial") if not sdk_available(n)]
    if missing:
        raise SystemExit(
            f"找不到 SDK {', '.join(missing)} —— 发布出来的产物**连不上机械臂**。"
            "它随本仓的 submodule 一起来（`sdk/litearm-python`）：\n"
            "    make sdk        # 或 git submodule update --init --recursive")
    print("[package] 收集机械臂 SDK litearm（含 pyserial）")
    return ["--collect-all", "litearm", "--collect-all", "serial"]


def gripper_build_args() -> list[str]:
    """夹爪 SDK 的 PyInstaller 参数, 或一句"为什么没有它"。

    `--collect-all litegrip` 是必须的：包里除了 .py 还有三份 JSON（两个模板与出厂
    标定）和 `py.typed`，只收模块的话 `load_template()` 找不到文件会抛。
    """
    on_gripper_platform = sys.platform.startswith(GRIPPER_PLATFORMS)
    if not on_gripper_platform:
        print(f"[package] {sys.platform}: 夹爪缺席 (需要 PF_CAN), 不收 litegrip")
        return []
    if not sdk_available("litegrip"):
        raise SystemExit(
            "找不到夹爪 SDK `litegrip`，但这是 Linux 构建 —— 发布出来的 Linux 产物"
            "会**没有夹爪**。它随本仓的 submodule 一起来（`sdk/litegrip-python`，"
            "版本由 .gitmodules 钉住）：\n"
            "    make sdk        # 或 git submodule update --init --recursive")
    print("[package] 收集夹爪 SDK litegrip（含模板与出厂标定）")
    return ["--collect-all", "litegrip"]


def dfu_build_args() -> list[str]:
    """固件升级（USB DFU）引擎的 PyInstaller 参数。

    两个包都**必须显式收**，PyInstaller 的静态分析看不见它们：

    * `usb`（pyusb）—— 它是**动态加载** libusb 的（`ctypes`），没有 import 语句；
    * `libusb_package` —— 它不只是 .py，还带着各平台的 libusb 动态库。少了它，
      冻结出来的 exe 在 Windows 上会"静默地没有后端"：`usb.core.find()` 恒为空，
      GUI 报"未发现设备"而板子其实就在 DFU 模式。这正是上游 `dfu-flash` 踩过的坑。

    ⚠ 缺 pyusb 时**判失败**，与夹爪那条同一条口径：谁都可以在没有它的情况下把包装
    出去，而发出去的产物里"固件升级"永远显示"引擎不可用" —— 一个静默残缺的能力
    比一个构建失败难查得多。
    """
    if not sdk_available("usb"):
        raise SystemExit(
            "找不到固件烧录引擎 `pyusb`，发布出来的产物**没有固件升级能力**。\n"
            "    pip install pyusb libusb-package")
    args = ["--collect-all", "usb"]
    if sdk_available("libusb_package"):
        print("[package] 收集 libusb（libusb-package 自带各平台动态库）")
        args += ["--collect-all", "libusb_package"]
    else:
        # 不判失败：Linux 上系统 libusb 通常够用（engine 会回退到 pyusb 自带查找）。
        # 但 Windows 上少了它多半就是"找不到设备"，所以说清楚。
        print("[package] ⚠ 没有 libusb-package —— Windows 上可能需要手工放 "
              "libusb-1.0.dll，或装 ST 的 WinUSB 驱动")
    return args


def uvicorn_build_args() -> list[str]:
    """uvicorn 里那几个**运行时才选**的实现 —— 点名要的，不做整包收。

    ⚠ `--collect-submodules uvicorn` 是**冗余**的，而且正是它把最大的那件死重拖进来的：
    `pyinstaller-hooks-contrib` 的 `hook-uvicorn.py` 无条件执行
    `collect_submodules('uvicorn')`，于是 `uvicorn.loops.uvloop` 进包、它顶上那句
    `import uvloop` 又把 16 MB 的 uvloop 拉进来。所以删掉那个参数一点用都没有，
    真正起作用的是下面 `slimming_args()` 里的 `--exclude-module uvloop`。

    留下的是按**字符串**被引用的模块（`uvicorn/config.py` 的 `loop_factory`、
    `http_protocol`、`ws_protocol`、`lifespan` 字段与 `LOGGING_CONFIG`），
    静态分析看不见它们。
    """
    return [
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops.auto",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.lifespan.on",
        # WebSocket 的实际实现（`protocols/websockets/auto.py` 的那个分支）。界面的
        # 状态推送全靠这条路 —— 今天它已经被 uvicorn 那个钩子顺带收进来了，显式写出来
        # 是为了钩子哪天变了也不会静默地少掉 WS。
        "--hidden-import", "uvicorn.protocols.websockets.websockets_sansio_impl",
    ]


def slimming_args() -> list[str]:
    """**明确不收**的包。每一条都是实测出来的死重，理由写在各自那一行上。

    实测（本机 14 核；`LITEARM_STUDIO_WINDOW_BACKEND=native` 的 onefile，两个版本同一台
    机器、同一份 `dist/`。GTK 变体同样含 uvloop，这四处差值按比例同样成立）：

    | | 修前 | 修后 |
    | --- | --- | --- |
    | 可执行文件 | 28.4 MB | 21.8 MB（-23%） |
    | 每次启动解包 | 68.9 MB / 349 项 | 48.0 MB / 337 项（-30%） |
    | 解包 + 导入（`--help`，中位，14 次） | 749 ms | 626 ms（-17%） |
    | 进程起到 `/api/health` 通（中位，6 次） | 1114 ms | 935 ms（-16%） |

    两组样本的分布不重叠（修后最慢的 697 ms 仍快于修前的中位）；`--help` 那一行只含
    解包与导入，去掉了服务启动的抖动，所以它是最干净的一条对照。

    ⚠ 这里**不动** httptools（解包 1.1 MB）：它同样是"可选实现"，但它是一个真实的运行时
    能力（更快的 HTTP 解析），为省 1.1 MB 换成纯 Python 的 h11 是笔不划算的买卖。
    `--exclude-module` 只去掉真正用不到的东西，不是把可选依赖一律砍掉。
    """
    return [
        # 解包 16.0 MB（占整包 23%），**单项最大**。`uvicorn.loops.auto` 只在
        # `import uvloop` 成功时才用它；本程序的事件循环要伺候一条 50Hz 状态推送、
        # 一个应用窗口和几十个静态资源请求，全在本机回环上 —— uvloop 带来的吞吐在这里
        # 没有可测量的收益，代价却是每次启动都要把这 16 MB 解包到临时目录。
        # 排掉之后 `auto` 退回 asyncio（实测：`asyncio.unix_events._UnixSelectorEventLoop`）。
        "--exclude-module", "uvloop",
        # 解包 1.2 MB，只有 `--reload`（开发期热重载）才 import 它 —— 冻结产物从不 reload。
        "--exclude-module", "watchfiles",
        # 解包 2.7 MB。整个依赖图里只有两处 `import yaml`，都在**函数体内**且我们永不执行：
        # `uvicorn.config.Config.load()`（本程序的 Config 由关键字参数构造，从不读配置文件）
        # 与 `starlette.schemas` 的 module-level `try`（本来就容错）。
        "--exclude-module", "yaml",
        # 解包 2.5 MB。依赖图里没有任何第三方包 import 它（`click/decorators.py` 提到
        # `pkg_resources` 只是一句注释），进包的是 PyInstaller 给 `pkg_resources` 准备的
        # 运行时钩子连带收进来的 setuptools 全家。
        "--exclude-module", "setuptools",
        "--exclude-module", "pkg_resources",
    ]


def hooks_args() -> list[str]:
    """挂上我们自己的 PyInstaller 钩子目录（`packaging/hooks/`）。

    ⚠ 这一条是**体积**参数，只是长得不像。PyInstaller 自带的 `hook-gi.repository.Gtk`
    在没配 hooksconfig 时执行 `collect_glib_share_files('icons')`，把**构建机**上装着的
    整套图标主题原样收进产物 —— ubuntu-22.04 上是 Humanity 等，展开后 71 MB，占
    v0.22.2 那个 `.deb` 安装体积的三分之一还多。

    `--additional-hooks-dir` 里的目录被放在最前面，而一个模块只有一条钩子生效（优先级
    高的胜出），所以这一条是**替代**上游那条而不是给它打补丁：我们那条在执行时把上游
    原样调用一遍，只筛掉多余的图标主题（见 `packaging/hooks/hook-gi.repository.Gtk.py`）。

    少了这个参数不会有任何报错 —— 包只是白白大一截。所以 `test_build.py` 里有一条钉住它。
    """
    return ["--additional-hooks-dir", str(HOOKS_DIR)]


def window_build_args() -> list[str]:
    """应用窗口（`daemon/.../window.py`）的 PyInstaller 参数。

    `pywebview` 是**软依赖**（`daemon[ui]` extra）：无界面运行、CI 与测试都不装它。所以
    这里分两种情况，判据与夹爪 / pyusb 那两条同源：

    * 装了就收进来 —— 冻结产物必须能开窗，否则"关掉窗口就是退出"这条行为在发布版上
      根本不成立；
    * 没装就**判失败**，而不是打出一个没窗口的产物。一个能启动、能连臂、一开窗就退出码 3
      的 `.deb` 比一次构建失败难查得多。

    **两个后端，体积差一个数量级**（Linux）：

    * `gtk`：借系统的 WebKitGTK。产物里只有 Python 侧与 PyGObject，`libwebkit2gtk` 那
      94 MB 留在系统上、由 `.deb` 的 `Depends` 提供（见 `deb.control_text`）。
    * `qt`：把 Qt WebEngine（一整个 Chromium）打进产物，不依赖任何系统库，代价是 `~240 MB`。

    选哪个由 `LITEARM_STUDIO_WINDOW_BACKEND` 决定，没设就自动：有 GTK 用 GTK，否则 Qt。
    """
    if not sdk_available("webview"):
        raise SystemExit(
            "找不到应用窗口的依赖 `pywebview`，发布出来的产物**打不开窗口** —— "
            "\"关掉窗口就是退出\"这条行为也就无从谈起。请装界面依赖：\n"
            '    pip install -e "daemon[ui]"')
    backend = window_backend()
    print(f"[package] 窗口后端 = {backend}")
    if backend == "gtk":
        return _gtk_build_args()
    if backend == "qt":
        return _qt_build_args()
    if backend == "native":
        return _native_build_args()
    raise SystemExit(
        "没有任何可用的窗口后端。二选一：\n"
        "    借系统的 GTK:  apt install python3-gi gir1.2-webkit2-4.1   （产物小）\n"
        '    自带的 Qt:     pip install -e "daemon[ui-qt]"             （产物 ~240 MB）')


def window_backend() -> str | None:
    """`gtk` / `qt` / `native`；一个都没有时返回 `None`。

    ⚠ Linux 上 `auto` 优先 GTK 是因为体积，不是因为 GTK 更好用：`libwebkit2gtk` 有
    94 MB，自带的 Qt 有 240 MB，而两者都要在系统里放一份 WebKit/Chromium 才能渲染。
    Windows 与 macOS 没有这个取舍 —— 它们**自带**内核（WebView2 / WKWebView），
    pywebview 直接用，既不用 GTK 也不用 Qt，所以那两个平台是 `native`。
    """
    forced = os.environ.get(WINDOW_BACKEND_ENV, "").strip().lower()
    if forced:
        if forced not in ("gtk", "qt", "native"):
            raise SystemExit(
                f"{WINDOW_BACKEND_ENV} 只接受 gtk / qt / native，实得 {forced!r}")
        return forced
    if not sys.platform.startswith("linux"):
        return "native"
    if gtk_available():
        return "gtk"
    if any(sdk_available(name) for name in ("PyQt6", "PySide6")):
        return "qt"
    return None


def gtk_available() -> bool:
    """这台构建机上有没有可用的 GTK + WebKit2 4.1（`gi` 是系统包，pip 装不了）。"""
    try:
        import gi  # noqa: PLC0415 - 只有构建 GTK 产物时才需要
        gi.require_version("WebKit2", "4.1")
    except Exception:  # noqa: BLE001 - 缺 gi、缺 typelib、版本不对都算"没有"
        return False
    return True


def _gtk_build_args() -> list[str]:
    """GTK 后端的参数。

    ⚠ **WebKit2 没有 PyInstaller 钩子**（自带的 `hook-gi.repository.*` 里有 Gtk/Gdk/Gio…
    但没有 WebKit2），所以它的 typelib 与 `libwebkit2gtk` 必须由 `.deb` 的 `Depends` 提供。
    漏掉这条依赖的表现是：装完打开就报"没有可用的 webview 后端"。

    ⚠ `Gtk` 那个钩子会顺带把 `libgtk-3` 及其依赖收进产物（`collect_typelib_data()` 会收
    typelib 指向的共享库）。这是有意的：GTK 的传递依赖太多，与其在 `Depends` 里逐条列，
    不如让 PyInstaller 收干净；真正大的是 WebKit，而它不在那条链上。
    """
    if not gtk_available():
        # ⚠ 被 `LITEARM_STUDIO_WINDOW_BACKEND=gtk` 强制指定、但机器上其实没有 GTK 时，
        # 静默继续会打出一个**开不了窗口**的产物 —— 正是这个函数要拦的那类失败。
        raise SystemExit(
            "选定了 GTK 窗口后端，但这台构建机上没有可用的 PyGObject / WebKit2 4.1。\n"
            "    apt install python3-gi gir1.2-webkit2-4.1\n"
            f"    或者去掉 {WINDOW_BACKEND_ENV}=gtk，改用自带的 Qt 后端")
    args = ["--collect-all", "webview", "--collect-all", "gi"]
    for name in GTK_MODULES:
        args += ["--hidden-import", f"gi.repository.{name}"]
    args += ["--hidden-import", "gi.repository.WebKit2"]
    return args


def _native_build_args() -> list[str]:
    """Windows / macOS 的窗口参数：系统自带内核，什么都不用额外收。

    pywebview 在那两个平台用 WebView2 / WKWebView，pywebview 自己的平台模块由
    `--collect-all webview` 收干净。Windows 上还要 Python.NET（pywebview 的依赖会带进来），
    它的加载器是动态导入的，静态分析看不见。
    """
    args = ["--collect-all", "webview"]
    if sys.platform == "win32":
        for name in ("pythonnet", "clr_loader"):
            if sdk_available(name):
                args += ["--collect-all", name]
    return args


def _qt_build_args() -> list[str]:
    """Qt 后端的参数。

    ⚠ `qtpy` 是**独立包**，不在 pywebview 的基础依赖里（只有它的 `[qt]` extra 才带）。
    所以"装了 PyQt6"并不等于 Qt 后端能起来 —— 它第一行就是 `from qtpy import ...`。
    少了它的表现是产物**构建成功**、一启动就报"没有可用的 webview 后端"。

    ⚠ **为什么显式列 QtWebEngine**：pywebview 经 `qtpy` 选绑定（运行时的动态选择），
    PyInstaller 的静态分析跟不到那条路；`qtpy` 自己也是运行时挑 PyQt/PySide 的。
    """
    if not sdk_available("qtpy"):
        raise SystemExit(
            "找不到 `qtpy` —— pywebview 的 Qt 后端要靠它选绑定，没有它产物开不了窗口。\n"
            '    pip install -e "daemon[ui-qt]"')
    args = [
        "--collect-all", "webview",
        # qtpy 是运行时选绑定的，静态分析看不见它到底会用哪一个。
        "--collect-all", "qtpy",
    ]
    for binding in ("PyQt6", "PySide6"):
        if sdk_available(binding):
            print(f"[package] Qt 绑定 = {binding}")
            hidden = ["QtWebEngineWidgets", "QtWebEngineCore", "QtWebChannel",
                      "QtNetwork", "QtCore", "QtGui", "QtWidgets"]
            for name in hidden:
                args += ["--hidden-import", f"{binding}.{name}"]
            return args
    raise SystemExit(
        "装了 `pywebview` 但没有任何 Qt 绑定，冻结出来的窗口会在选后端时失败。\n"
        '    pip install -e "daemon[ui-qt]"   # 它会拉 PyQt6')
    return args


#: 交付形态。两者是同一份代码的两种摆放方式，差别只在**启动时要不要解包**：
#:
#: * `onefile`（默认）—— 一个可执行文件，每次启动把整包解到临时目录再跑。
#: * `onedir` —— 一个目录，直接跑，没有解包这一步。
MODE_ENV = "LITEARM_STUDIO_BUNDLE_MODE"
BUNDLE_MODES = ("onefile", "onedir")


def bundle_mode() -> str:
    """`onefile` / `onedir`；没设就是 `onefile`。

    ⚠ 默认保持 `onefile` 是**有意的**：便携下载（其他 Linux、Windows）拿到的仍然是一个
    文件 —— 优化不该顺手改变用户拿到的东西。要用目录形态的交付（`.deb`）显式指定，
    见 `packaging/deb_build.sh`。

    实测（本机 14 核，`native` 变体，`--help` 只含解包与导入）：

    | | onedir | onefile |
    | --- | --- | --- |
    | 启动解包 | 无 | 48.0 MB / 337 项，每次启动都是 |
    | 解包 + 导入（`--help`，中位） | 578–700 ms | 850–1059 ms |
    | 起到 `/api/health` 通（中位） | 734 ms | 1060 ms |

    差约 **272–359 ms（-32%）**。绝对值随机器负载漂，所以两轮都是两种形态**交替**
    测量的：差值在两轮里都成立，而单看某一轮的绝对值会被别的进程带偏。

    所以目录形态是"装到系统里"该用的形态，而单文件是"下载一个文件就能跑"该用的形态 ——
    两者服务的是不同的场景，不是一个比另一个好。
    """
    forced = os.environ.get(MODE_ENV, "").strip().lower()
    if not forced:
        return "onefile"
    if forced not in BUNDLE_MODES:
        raise SystemExit(f"{MODE_ENV} 只接受 {' / '.join(BUNDLE_MODES)}，实得 {forced!r}")
    return forced


def bundle_mode_args(mode: str) -> list[str]:
    """交给 PyInstaller 的那一个开关。"""
    return ["--onedir"] if mode == "onedir" else ["--onefile"]


def bundle_output(mode: str) -> Path:
    """这个形态的产物路径 —— `onedir` 时是目录里那个可执行文件。"""
    name = EXE_NAME + (".exe" if os.name == "nt" else "")
    return OUT_DIST / name if mode == "onefile" else OUT_DIST / EXE_NAME / name


def bundle_size_mb(mode: str) -> float:
    """产物体积。`onedir` 要把整个目录加起来 —— 只量那个可执行文件会少报一个数量级。"""
    if mode == "onefile":
        return bundle_output(mode).stat().st_size / 1e6
    root = OUT_DIST / EXE_NAME
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file()) / 1e6


def main() -> int:
    if not (UI_DIST / "index.html").is_file():
        raise SystemExit(
            f"界面未构建: {UI_DIST}/index.html 不存在 —— 先执行 `pnpm build` "
            f"(打包必须带上界面, 否则可执行程序只能提供 /api/health)")
    if not (ROOT / "daemon" / "src" / "litearm_studio_daemon").is_dir():
        raise SystemExit(f"找不到 daemon 源码: {DAEMON_SRC}")
    # ⚠ 图标缺失要**在这里**失败，不能交给 PyInstaller：它接受不存在的 `--icon`
    # 路径然后照常打包成功（回到默认图标），于是"图标没换"这种问题只有用户能看到。
    if not ICON.is_file():
        raise SystemExit(
            f"找不到图标: {ICON} —— 它是入库文件；若被误删，用 "
            f"`node scripts/render-icon-png.mjs && node scripts/make-icon.mjs` 重新生成")

    version = resolve_version().lstrip("v")
    # ⚠ 先判参数形态, 再写任何构建产物: 坏参数要在**落地文件之前**就失败, 否则源码树里
    #   会留下一个只属于这次失败构建的 `_build_*` 文件 (下一条注释解释了它为什么要命)。
    activation_url = resolve_activation_url()
    mode = bundle_mode()
    print(f"[package] version = {version}")
    print(f"[package] 交付形态 = {mode}")

    VERSION_FILE.write_text(
        '"""构建时生成 —— 不要提交（见 .gitignore）。"""\n'
        f'__version__ = "{version}"\n',
        encoding="utf-8")

    if activation_url:
        ACTIVATION_URL_FILE.write_text(
            '"""构建时生成 —— 不要提交（见 .gitignore）。"""\n'
            f'__activation_url__ = "{activation_url}"\n',
            encoding="utf-8")
        print(f"[package] activation url = {activation_url}")
    else:
        print("[package] activation url = 内置生产地址 (未注入)")

    shutil.rmtree(WORK, ignore_errors=True)
    OUT_DIST.mkdir(parents=True, exist_ok=True)

    # ⚠ 两个构建产物**必须**在 finally 里删。留在源码树里的后果不是"多一个文件"：
    #   下次源码直接运行会读到上一次打包注入的版本号 / 激活地址，于是"没打包却按打包
    #   的行为跑"—— 而这两处正是最不该被上一次构建污染的地方。
    try:
        args = [
            sys.executable, "-m", "PyInstaller",
            "--noconfirm", "--clean", *bundle_mode_args(mode),
            "--name", EXE_NAME,
            # 可执行文件图标（Windows）；Linux 上被接受但忽略
            "--icon", str(ICON),
            "--paths", str(DAEMON_SRC),
            # 界面: _MEIPASS/dist （与 resolve_ui_dir 的冻结分支一致）
            "--add-data", f"{UI_DIST}{os.pathsep}dist",
            # 夹爪默认标定（calibration.packaged_factory_path）：它是 .json, 不写 import,
            # PyInstaller 静态分析看不见。少了它, 冻结产物在**没有设 LITEGRIP_FACTORY_CALIB**
            # 时会静默退回 litegrip 自带的那份（数字随 SDK 版本变), 而不是控制台自己钉的那份。
            "--collect-data", "litearm_studio_daemon",
            # SDK 不在 PyPI 上, 连数据文件一起收进来（缺了判失败, 见 arm_build_args）
            *arm_build_args(),
            *gripper_build_args(),
            *dfu_build_args(),
            *window_build_args(),
            *activation_build_args(activation_url),
            *uvicorn_build_args(),
            *slimming_args(),
            *hooks_args(),
            "--distpath", str(OUT_DIST),
            "--workpath", str(WORK),
            "--specpath", str(WORK),
            str(ROOT / "packaging" / "launcher.py"),
        ]
        print("[package] " + " ".join(args))
        subprocess.run(args, check=True, cwd=ROOT)

        produced = bundle_output(mode)
        if not produced.is_file():
            raise SystemExit(f"打包结束但没找到产物: {produced}")
        print(f"[package] 产物: {produced} ({bundle_size_mb(mode):.1f} MB)")
    finally:
        VERSION_FILE.unlink(missing_ok=True)
        ACTIVATION_URL_FILE.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
