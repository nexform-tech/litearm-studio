"""Tests for `packaging/build.py`, the builder of the frozen bundle.

The module is loaded by path instead of imported for the same reason as `test_deb.py`:
its directory is called `packaging`, which would shadow the PyPI package of that name.

Only the argument builders are covered here. `main()` shells out to PyInstaller, which
belongs to the release job, not to a unit test.
"""
from __future__ import annotations

import importlib.util
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
BUILD_PY = ROOT / "packaging" / "build.py"


def _load_build_module():
    spec = importlib.util.spec_from_file_location("litearm_studio_build", BUILD_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = _load_build_module()


def _installed(monkeypatch, *names: str, gtk: bool = False, backend=None) -> None:
    """Pretend exactly `names` are importable, whatever is really on this machine.

    `gtk_available()` is stubbed too: otherwise the backend these tests get depends on
    whether the machine running the suite happens to have PyGObject, and the suite would
    take a different path on a developer box than in CI.
    """
    monkeypatch.setattr(build, "sdk_available", lambda name: name in names)
    monkeypatch.setattr(build, "gtk_available", lambda: gtk)
    if backend is None:
        monkeypatch.delenv(build.WINDOW_BACKEND_ENV, raising=False)
    else:
        monkeypatch.setenv(build.WINDOW_BACKEND_ENV, backend)


def test_window_build_args_collects_the_qt_backend(monkeypatch):
    """The window must survive freezing, or the product's "closing it quits" is gone.

    `qtpy` picks its binding at runtime and pywebview imports the Qt modules from inside
    a `try`, so neither is visible to static analysis. Both have to be named explicitly —
    a frozen build that silently lacks them opens no window at all.
    """
    _installed(monkeypatch, "webview", "qtpy", "PyQt6")
    args = build.window_build_args()

    assert "--collect-all" in args and "webview" in args
    assert "qtpy" in args
    # pywebview 的 Qt 后端经 qtpy 间接 import 这几个, 静态分析跟不到。
    for module in ("PyQt6.QtWebEngineWidgets", "PyQt6.QtWebEngineCore", "PyQt6.QtWidgets"):
        assert module in args


def test_window_build_args_uses_the_system_gtk_when_it_is_there(monkeypatch):
    """有 GTK 就走 GTK —— 这条决定包是 ~63 MB 还是 ~243 MB。

    借系统的 WebKitGTK 意味着产物里**不能**再塞一个 Qt；GTK 那条链由 PyInstaller 的
    `hook-gi.repository.*` 收，WebKit2 没有钩子，它的库与 typelib 由 `.deb` 的
    `Depends` 提供。
    """
    _installed(monkeypatch, "webview", "qtpy", "PyQt6", gtk=True)
    args = build.window_build_args()

    assert "gi" in args
    assert "gi.repository.WebKit2" in args
    assert not any("PyQt6" in arg for arg in args), "两个后端都收会把包撑回 Qt 的体积"


def test_windows_and_macos_use_the_kernel_the_os_already_has(monkeypatch):
    """那两个平台没有 GTK/Qt 的取舍 —— WebView2 / WKWebView 是系统自带的。

    ⚠ 这条同时钉住一个回归：把后端判据写成"只有 gtk 和 qt 两种"会让 Windows 构建
    **直接失败**（那里两个都没有），而它本来什么都不用装。
    """
    monkeypatch.setattr(build.sys, "platform", "win32")
    _installed(monkeypatch, "webview", "pythonnet", "clr_loader")

    args = build.window_build_args()

    assert "webview" in args
    assert "pythonnet" in args  # 它是动态加载的, 静态分析看不见
    assert not any("PyQt6" in arg for arg in args)


def test_the_backend_can_be_forced_by_environment(monkeypatch):
    """`LITEARM_STUDIO_WINDOW_BACKEND` 能盖过自动判据 —— 发布流水线要用它把产物钉死。"""
    _installed(monkeypatch, "webview", "qtpy", "PyQt6", gtk=True, backend="qt")
    assert any("PyQt6" in arg for arg in build.window_build_args())

    _installed(monkeypatch, "webview", "qtpy", "PyQt6", gtk=True, backend="gtk")
    assert any("gi.repository.WebKit2" in arg for arg in build.window_build_args())


def test_a_bogus_backend_name_is_refused(monkeypatch):
    """写错的开关要**报错**, 不能静默按默认值走 —— 那会发出一份不是你要的产物。"""
    _installed(monkeypatch, "webview", gtk=True, backend="gtk4")
    with pytest.raises(SystemExit) as excinfo:
        build.window_build_args()
    assert build.WINDOW_BACKEND_ENV in str(excinfo.value)


def test_forcing_gtk_without_gtk_installed_fails_the_build(monkeypatch):
    """强制 GTK 但这台机器上没装 ⇒ 判失败, 而不是打出一个开不了窗口的产物。"""
    _installed(monkeypatch, "webview", backend="gtk", gtk=False)
    with pytest.raises(SystemExit) as excinfo:
        build.window_build_args()
    assert "python3-gi" in str(excinfo.value)


def test_window_build_args_prefers_qt_when_both_bindings_are_present(monkeypatch):
    """装了两个 Qt 绑定时不要混着收 —— 那会把两个 ~200MB 的 Qt 一起塞进产物。"""
    _installed(monkeypatch, "webview", "qtpy", "PyQt6", "PySide6")
    args = build.window_build_args()

    assert any("PyQt6" in arg for arg in args)
    assert not any("PySide6" in arg for arg in args)


def test_arm_build_args_collects_the_sdk_and_its_serial_dependency(monkeypatch):
    _installed(monkeypatch, "litearm", "serial")

    assert build.arm_build_args() == ["--collect-all", "litearm", "--collect-all", "serial"]


def test_arm_build_args_refuses_to_package_an_armless_build(monkeypatch):
    """缺 `litearm` 时**判失败**, 而不是打出一个连不上臂的产物。

    那种产物比一次构建失败难查得多: PyInstaller 把解析不到的 `import litearm` 当
    WARNING 放行, 于是包能启动、一连机械臂才 `ModuleNotFoundError`。与 litegrip /
    pyusb / pywebview 三条同一条口径。
    """
    _installed(monkeypatch, "litegrip", "usb")
    with pytest.raises(SystemExit) as excinfo:
        build.arm_build_args()

    assert "litearm" in str(excinfo.value)
    assert "make sdk" in str(excinfo.value)


def test_window_build_args_refuses_to_package_a_windowless_build(monkeypatch):
    """缺 pywebview 时**判失败**, 而不是打出一个开不了窗口的产物。

    一个能启动、能连机械臂、一开窗就退出码 3 的 `.deb` 比一次构建失败难查得多
    (与 litegrip / pyusb 那两条同一条口径)。
    """
    _installed(monkeypatch, "litearm", "serial")
    with pytest.raises(SystemExit) as excinfo:
        build.window_build_args()
    assert "daemon[ui" in str(excinfo.value)


def test_window_build_args_refuses_a_webview_without_any_binding(monkeypatch):
    """装了 pywebview、却没装任何 Qt 绑定 ⇒ 冻结后的窗口在选后端时才会失败, 太晚。"""
    _installed(monkeypatch, "webview", "qtpy")
    with pytest.raises(SystemExit) as excinfo:
        build.window_build_args()
    assert "daemon[ui" in str(excinfo.value)


def test_window_build_args_refuses_a_qt_binding_without_qtpy(monkeypatch):
    """`QtPy` 是独立包, pywebview 的基础依赖里**没有**它。

    所以"装了 PyQt6"不等于 Qt 后端能起来 —— pywebview 的 `platforms/qt.py` 第一行就是
    `from qtpy import ...`。实测踩过一次: 产物构建成功, 一启动就报"没有可用的 webview
    后端"。这条把它钉在构建期。
    """
    _installed(monkeypatch, "webview", "PyQt6")
    with pytest.raises(SystemExit) as excinfo:
        build.window_build_args()
    assert "qtpy" in str(excinfo.value)


# ------------------------------------------------------- 冻结产物的瘦身 (包体积/启动)

def _values_after(args: list[str], flag: str) -> list[str]:
    return [args[i + 1] for i, value in enumerate(args[:-1]) if value == flag]


def test_the_optional_implementations_we_never_use_are_excluded() -> None:
    """钉住那几条 `--exclude-module`，每条都对应一处实测出来的死重。

    `uvloop` 尤其重要，而且**不能靠删参数解决**：`_pyinstaller_hooks_contrib` 的
    `hook-uvicorn.py` 无条件执行 `collect_submodules('uvicorn')`，于是
    `uvicorn.loops.uvloop` 进包、它顶上那句 `import uvloop` 又把 16 MB 的 uvloop 拉进来。
    实测：它是整包里解包体积最大的单项（16.0 MB / 69 MB）。
    """
    excluded = _values_after(build.slimming_args(), "--exclude-module")
    for name in ("uvloop", "watchfiles", "yaml", "setuptools", "pkg_resources"):
        assert name in excluded, f"{name} 不再被排除 —— 包会白白变大"


def test_a_real_runtime_capability_is_not_sacrificed_for_size() -> None:
    """`httptools` 同样是"可选实现"，但它**必须留着**。

    排掉它 uvicorn 会退回纯 Python 的 h11（能跑），省下的只有 1.1 MB —— 拿一个真实的
    运行时能力去换 1.1 MB 是笔坏买卖。这条把那次取舍钉住，免得下一次"瘦身"顺手砍掉它。
    """
    excluded = _values_after(build.slimming_args(), "--exclude-module")
    assert "httptools" not in excluded


def test_the_dynamically_chosen_uvicorn_implementations_are_still_imported() -> None:
    """uvicorn 是按**字符串**选实现的（`config.py` 的 `loop_factory` / `*_protocol` /
    `lifespan` 字段与 `LOGGING_CONFIG`），静态分析看不见 —— 漏一个就是在冻结产物里少一条
    运行期能力。WebSocket 那条尤其要命：界面的状态推送、命令、日志全走它。
    """
    hidden = _values_after(build.uvicorn_build_args(), "--hidden-import")
    for name in (
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
        "uvicorn.protocols.websockets.websockets_sansio_impl",
    ):
        assert name in hidden, f"{name} 没被点名 —— 冻结产物会在运行时少掉这条路径"


# ------------------------------------------------------ 交付形态 (单文件 / 目录)

def test_the_bundle_shape_defaults_to_onefile_and_refuses_nonsense(monkeypatch) -> None:
    """默认必须是 `onefile`。

    便携下载（其他 Linux、Windows）拿到的仍然是一个文件 —— 性能优化不该顺手把用户拿到的
    东西从"一个文件"换成"一个目录"。要目录形态的交付（`.deb`）必须显式指定。
    """
    monkeypatch.delenv(build.MODE_ENV, raising=False)
    assert build.bundle_mode() == "onefile"
    assert build.bundle_mode_args("onefile") == ["--onefile"]

    monkeypatch.setenv(build.MODE_ENV, "onedir")
    assert build.bundle_mode() == "onedir"
    assert build.bundle_mode_args("onedir") == ["--onedir"]

    monkeypatch.setenv(build.MODE_ENV, "single-file")
    with pytest.raises(SystemExit) as excinfo:
        build.bundle_mode()
    assert "onefile" in str(excinfo.value)


def test_the_directory_shape_reports_the_size_of_the_whole_tree(monkeypatch, tmp_path) -> None:
    """目录形态的体积要连 `_internal/` 一起算。

    只量那个可执行文件会少报一个数量级（实测 7.2 MB 对 48.0 MB），而"产物多大"正是
    这份日志里给人看的那个数。
    """
    monkeypatch.setattr(build, "OUT_DIST", tmp_path)
    tree = tmp_path / build.EXE_NAME
    (tree / "_internal").mkdir(parents=True)
    (tree / build.EXE_NAME).write_bytes(b"x" * 7000)
    (tree / "_internal" / "libpython.so").write_bytes(b"y" * 3000)

    assert build.bundle_size_mb("onedir") == pytest.approx(0.01)


# ----------------------------- 桌面栈: 包不带, 由目标机提供 (修 Ubuntu 24.04, issue #123)


def test_our_hook_directory_is_handed_to_pyinstaller() -> None:
    """`--additional-hooks-dir` 必须挂在构建参数上，而且指向真实存在的钩子目录。

    少了它**不会有任何报错**：PyInstaller 自带的六十多条 `hook-gi.repository.*` 又把构建机
    那一整套桌面栈收进产物 —— `.deb` 白白大几十 MB，而且在 Ubuntu 24.04 上那份
    `libglib-2.0.so.0`(2.72) 会盖住系统的 (2.80)，系统 WebKitGTK 加载失败、窗口开不出来
    (issue #123)。这种"没有反馈的退化"只能靠测试钉住。
    """
    args = build.hooks_args()

    assert args[0] == "--additional-hooks-dir"
    hooks_dir = pathlib.Path(args[1])
    assert hooks_dir == build.HOOKS_DIR
    assert hooks_dir.is_dir(), "钩子目录不见了 —— 桌面栈会回到产物里"
    # 那件事的全部: `hook-gi` 堵住汇合点, 另外两条换掉"除了汇合点还会多塞东西"的上游钩子。
    for name in ("hook-gi.py", "hook-gi.repository.Gio.py", "hook-gi.repository.GdkPixbuf.py"):
        assert (hooks_dir / name).is_file(), f"{name} 不见了"


def _load_hook(name: str):
    """按路径加载 `packaging/hooks/` 里的一条钩子。

    路径加载而不是 `import`：`hook-gi.repository.Gio` 不是个能 import 的名字（gi 的钩子都
    按 `hook-<模块名>.py` 命名，PyInstaller 自己也是按路径读的）。PyInstaller 不在测试环境
    里（CI 只装 `daemon[test]`），所以这里 `importorskip` —— 这几条跑在打包/发布环境。
    """
    pytest.importorskip("PyInstaller")
    spec = importlib.util.spec_from_file_location(
        "litearm_probe_" + name.replace(".", "_"), ROOT / "packaging" / "hooks" / name)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_gi_hook_stops_the_whole_desktop_stack() -> None:
    """`hook-gi.py` 堵住那三条"桌面栈进产物"的路 —— 库、typelib、构建机的运行期数据。

    ⚠ 加载它会给本进程里的 PyInstaller 打上全局补丁（打包时正是这个效果），所以这是一条
    "副作用型"的测试；别的测试都不碰 PyInstaller 那几个收集函数。
    """
    hook = _load_hook("hook-gi.py")
    from PyInstaller.depend import dylib
    from PyInstaller.utils.hooks import gi as gi_hooks

    # 1. typelib 与它引用的共享库 —— 那六十多条 `hook-gi.repository.*` 的唯一出口。
    assert gi_hooks.GiModuleInfo.collect_typelib_data(object()) == ([], [], [])

    # 2. 构建机 `/usr/share`、`/etc` 下抄下来的运行期数据（图标主题、GIO schema、翻译…）。
    assert gi_hooks.collect_system_data_files("/usr/share/icons") == []
    assert gi_hooks.collect_glib_share_files("icons") == []
    assert gi_hooks.collect_glib_translations("gtk30") == []

    # 3. `gi/_gi*.so` 自己的 DT_NEEDED —— 它绕过所有钩子，只有排除表拦得住。
    for soname in ("libglib-2.0.so.0", "libgobject-2.0.so.0", "libgtk-3.so.0",
                   "libgdk-3.so.0", "libgdk_pixbuf-2.0.so.0", "libcairo.so.2",
                   "libpango-1.0.so.0"):
        assert dylib.exclude_list.check_library(soname), f"{soname} 没被排除 —— 它会盖住系统的"

    # ⚠ 只排桌面栈。两条边界:
    #   * 顺手排掉 Python 自己要用的库, 等于让产物在最小安装上起不来;
    #   * `libgirepository-1.0.so.1` 是我们**包内**那份 PyGObject 的加载器 (桌面栈不消费它),
    #     目标机上它只跟着 `python3-gi` 或某条 Recommends 来 —— 排掉它, 用
    #     `--no-install-recommends` 装 GTK 的机器会在 `import gi` 就起不来。
    for soname in ("libssl.so.3", "libz.so.1", "libbz2.so.1.0", "libffi.so.8",
                   "libgirepository-1.0.so.1"):
        assert not dylib.exclude_list.check_library(soname), f"{soname} 不该被排除"


def test_the_gdk_pixbuf_hook_drops_the_builders_loaders(monkeypatch) -> None:
    """gdk-pixbuf 的加载器与为它们生成的缓存不进产物 —— 它们的依赖正是被排除的那些库。

    这条同时盯住转发链：上游收的 `binaries`/`datas` 收下不发，`hiddenimports` 与
    `hook_config` 之类的属性照旧穿过去（上游要读 hook 配置）。
    """
    hook = _load_hook("hook-gi.repository.GdkPixbuf.py")
    seen: dict = {}

    class FakeUpstream:
        @staticmethod
        def hook(sink) -> None:
            seen["hook_config"] = sink.hook_config
            sink.add_datas([("lib/gdk-pixbuf/loaders.cache", "/usr/share/loaders.cache")])
            sink.add_binaries([("/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/"
                                "libpixbufloader-svg.so", "lib/gdk-pixbuf/loaders")])
            sink.add_imports("gi.repository.GdkPixbuf")

    class FakeApi:
        def __init__(self) -> None:
            self.datas: list = []
            self.binaries: list = []
            self.imports: list = []
            self.hook_config = {"languages": ["en"]}

        def add_datas(self, datas) -> None:
            self.datas += list(datas)

        def add_binaries(self, binaries) -> None:
            self.binaries += list(binaries)

        def add_imports(self, *module_names) -> None:
            self.imports += list(module_names)

    monkeypatch.setattr(hook, "_load_upstream", lambda: FakeUpstream)
    api = FakeApi()
    hook.hook(api)

    assert api.datas == [], "构建机的加载器缓存不该进产物"
    assert api.binaries == [], "构建机的加载器不该进产物"
    assert api.imports == ["gi.repository.GdkPixbuf"]  # Python 侧照旧
    assert seen["hook_config"] is api.hook_config  # 属性读取要能穿过去


def test_the_gio_hook_only_keeps_the_platform_module() -> None:
    """GIO 模块与构建机的 mime.cache 由目标机提供，只留下运行时按名字取的那个 hiddenimport。

    上游那条钩子是在**模块级**算这些的（没有 `hook()`），所以替身也只在模块级声明一件事。
    """
    hook = _load_hook("hook-gi.repository.Gio.py")

    assert hook.hiddenimports == ["gi.repository.GioUnix"]
