"""把 daemon + SDK + 界面打成一个单文件可执行程序（计划 Phase 5）。

用法（**仓库根目录**执行，且 `pnpm build` 已经产出 `dist/`）：

```bash
python packaging/build.py
# 产物：packaging/dist/litearm-studio-daemon[.exe]
```

三件事：

* **版本来源唯一**：优先环境变量 `LITEARM_STUDIO_VERSION`（CI 传 git tag），否则
  `git describe --tags`，再否则 `0.0.0+dev`。写进 `_build_version.py`（构建产物，
  不入库，见 `.gitignore`）—— 这样 `hello.daemon` 报的就是发出去的那个 tag，
  而不是 manifest 里的 `0.0.0+semantic-release` 占位符。
* **把界面打进包**：`dist/` 以 `--add-data` 放到 `_MEIPASS/dist`，
  `server.resolve_ui_dir()` 认识这个冻结路径（免手工 `--ui-dir`）。
* **把 SDK 打进包**：`litearm` 不在 PyPI 上，必须随包内嵌（含 `pyserial`）。
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
            "会**没有夹爪**。请先克隆并安装它（仓库 nexform-tech/litegrip-python，"
            "钉住的版本见 release.yml）：\n"
            "    git clone https://github.com/nexform-tech/litegrip-python.git\n"
            "    pip install ./litegrip-python")
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
    print(f"[package] version = {version}")

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
            "--noconfirm", "--clean", "--onefile",
            "--name", EXE_NAME,
            # 可执行文件图标（Windows）；Linux 上被接受但忽略
            "--icon", str(ICON),
            "--paths", str(DAEMON_SRC),
            # 界面: _MEIPASS/dist （与 resolve_ui_dir 的冻结分支一致）
            "--add-data", f"{UI_DIST}{os.pathsep}dist",
            # SDK 不在 PyPI 上, 连数据文件一起收进来
            "--collect-all", "litearm",
            "--collect-all", "serial",
            *gripper_build_args(),
            *dfu_build_args(),
            *window_build_args(),
            *activation_build_args(activation_url),
            # uvicorn 的 loop/protocol 实现是动态导入的, PyInstaller 静态分析看不见
            "--collect-submodules", "uvicorn",
            "--collect-submodules", "websockets",
            "--hidden-import", "uvicorn.logging",
            "--hidden-import", "uvicorn.loops.auto",
            "--hidden-import", "uvicorn.protocols.http.auto",
            "--hidden-import", "uvicorn.protocols.websockets.auto",
            "--hidden-import", "uvicorn.lifespan.on",
            "--distpath", str(OUT_DIST),
            "--workpath", str(WORK),
            "--specpath", str(WORK),
            str(ROOT / "packaging" / "launcher.py"),
        ]
        print("[package] " + " ".join(args))
        subprocess.run(args, check=True, cwd=ROOT)

        produced = OUT_DIST / (EXE_NAME + (".exe" if os.name == "nt" else ""))
        if not produced.is_file():
            raise SystemExit(f"打包结束但没找到产物: {produced}")
        print(f"[package] 产物: {produced} ({produced.stat().st_size / 1e6:.1f} MB)")
    finally:
        VERSION_FILE.unlink(missing_ok=True)
        ACTIVATION_URL_FILE.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
