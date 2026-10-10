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


# ------------------------------------------- 图标主题 (安装体积里最大的一项, 可控)


def test_our_hook_directory_is_handed_to_pyinstaller() -> None:
    """`--additional-hooks-dir` 必须挂在构建参数上，而且指向真实存在的钩子目录。

    少了它**不会有任何报错**：PyInstaller 自带的 `hook-gi.repository.Gtk` 又把构建机上的
    整套图标主题收进产物，`.deb` 白白大 66 MB。这种"没有反馈的退化"只能靠测试钉住。
    """
    args = build.hooks_args()

    assert args[0] == "--additional-hooks-dir"
    hooks_dir = pathlib.Path(args[1])
    assert hooks_dir == build.HOOKS_DIR
    assert hooks_dir.is_dir(), "钩子目录不见了 —— 包会悄悄变大"
    assert (hooks_dir / "hook-gi.repository.Gtk.py").is_file()


def _load_gtk_hook():
    """按路径加载我们那条钩子 —— 文件名带 `.`，不是个能 import 的名字。

    PyInstaller 不在测试环境里（CI 只装 `daemon[test]`），所以调用方会让这个函数
    `importorskip`，在 CI 上跳过 —— 它跑的地方是打包/发布环境。
    """
    pytest.importorskip("PyInstaller")
    spec = importlib.util.spec_from_file_location(
        "litearm_gtk_hook", ROOT / "packaging" / "hooks" / "hook-gi.repository.Gtk.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_gtk_hook_collects_only_the_icon_themes_we_can_justify() -> None:
    """图标主题只留 Adwaita 与 hicolor，其余（构建机的桌面主题）一律拦下。

    ⚠ 拦的只有图标主题：typelib、fontconfig、mime、翻译这些是 GTK 真需要的运行期数据，
    少一条就是冻结产物里少一个能力，所以逐条钉住"放行"。
    """
    hook = _load_gtk_hook()

    assert hook.KEEP_ICON_THEMES == ("Adwaita", "hicolor")

    for entry in (
        # (来源, 目的) —— `hook_api.add_datas` 交出去时两头会被对调，两种顺序都要认。
        ("share/icons/Adwaita/16/x.svg", "/usr/share/icons/Adwaita/16/x.svg"),
        ("/usr/share/icons/hicolor/16/x.svg", "share/icons/hicolor/16/x.svg"),
        ("share/fontconfig/fonts.conf", "/usr/share/fontconfig/fonts.conf"),
        ("share/mime/globs", "/usr/share/mime/globs"),
        ("share/glib-2.0/schemas/gschemas.compiled", "/usr/share/glib-2.0/schemas/x"),
        ("gi_typelibs/Gtk-3.0.typelib", "/usr/share/gi_typelibs/Gtk-3.0.typelib"),
    ):
        assert hook.keeps(entry), f"这条不该被拦: {entry}"

    for entry in (
        ("share/icons/Humanity/16/x.svg", "/usr/share/icons/Humanity/16/x.svg"),
        ("share/icons/Humanity-Dark/16/x.svg", "/usr/share/icons/Humanity-Dark/16/x.svg"),
        ("share/icons/ubuntu-mono-dark/16/x.svg", "/usr/share/icons/ubuntu-mono-dark/16/x.svg"),
        # `share/icons` 整棵树本身（连主题名都没有）也算"要拦的那一类"。
        ("share/icons/icon-theme.cache", "/usr/share/icons/icon-theme.cache"),
    ):
        assert not hook.keeps(entry), f"这条该被拦: {entry}"


def test_the_gtk_hook_runs_upstream_and_then_filters(monkeypatch) -> None:
    """我们的钩子是把上游那条**跑一遍**再筛，而不是自己重写一遍它的收集逻辑。

    这条盯住那条转发链：上游收的东西进得来（binaries / imports 原样转交），被拦的只有
    图标主题；`hook_config` 之类的属性也要能从筛子里读出来（gi 的版本就是那么读的）。
    """
    hook = _load_gtk_hook()
    seen: dict = {}

    class FakeUpstream:
        @staticmethod
        def hook(sieve) -> None:
            seen["hook_config"] = sieve.hook_config
            sieve.add_datas([
                ("share/icons/Adwaita/16/x.svg", "/usr/share/icons/Adwaita/16/x.svg"),
                ("share/icons/Humanity/16/x.svg", "/usr/share/icons/Humanity/16/x.svg"),
                ("share/mime/globs", "/usr/share/mime/globs"),
            ])
            sieve.add_binaries([("/usr/lib/libgtk-3.so.0", ".")])
            sieve.add_imports("gi.repository.Gdk")

    class FakeApi:
        def __init__(self) -> None:
            self.datas: list = []
            self.binaries: list = []
            self.imports: list = []
            self.hook_config = {"icons": ["IGNORED"]}

        def add_datas(self, datas) -> None:
            self.datas += list(datas)

        def add_binaries(self, binaries) -> None:
            self.binaries += list(binaries)

        def add_imports(self, *module_names) -> None:
            self.imports += list(module_names)

    monkeypatch.setattr(hook, "_load_upstream", lambda: FakeUpstream)
    api = FakeApi()
    hook.hook(api)

    assert api.datas == [
        ("share/icons/Adwaita/16/x.svg", "/usr/share/icons/Adwaita/16/x.svg"),
        ("share/mime/globs", "/usr/share/mime/globs"),
    ]
    assert api.binaries == [("/usr/lib/libgtk-3.so.0", ".")]
    assert api.imports == ["gi.repository.Gdk"]
    assert seen["hook_config"] is api.hook_config
    assert hook.dropped_themes([
        ("share/icons/Humanity/16/x.svg", "/usr/share/icons/Humanity/16/x.svg"),
        ("share/icons/Adwaita/16/x.svg", "/usr/share/icons/Adwaita/16/x.svg"),
    ]) == ["Humanity"]
