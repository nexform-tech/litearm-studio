"""冻结产物借目标机那一份 GTK/GLib —— 替代 PyInstaller 自带的同名钩子。

`packaging/build.py` 用 `--additional-hooks-dir` 把这个目录放在最前面，而 PyInstaller 每个
模块只留一条钩子、同名的用户钩子优先 —— 所以这一条**就是**上游 `hook-gi.py` 的替身，
不是给它打补丁。

**为什么替。** PyInstaller 那六十多条 `hook-gi.repository.*` 会把**构建机**的整个桌面栈
收进产物：GTK/GDK/GLib/GIO/Pango/Atk/cairo/harfbuzz 的共享库、它们的 typelib，以及
gdk-pixbuf 的加载器、GIO 的模块。而 Linux 的 GTK 窗口后端**本来就借目标机的 WebKitGTK**
（`libwebkit2gtk` 94 MB 从不进包，由 `.deb` 的 `Depends: gir1.2-webkit2-4.1` 要过来），
那套依赖会把上面这些库与 typelib 一起装上 —— 于是包里那一份是纯副本，却带着**与系统同名
的 soname**，在进程里盖住系统的。这正是 Ubuntu 24.04 打不开窗口的原因：22.04 的
`libglib-2.0.so.0`(2.72) 盖住 24.04 的 (2.80)，24.04 的 `libgudev`（系统 WebKitGTK 要用）
需要 2.72 不导出的 `g_once_init_enter_pointer`，WebKitGTK 于是加载失败、pywebview 找不到
后端、守护进程退出（issue #123）。

**怎么替。** 逐条替换那六十多条等于把一份清单抄两遍，还会跟着 PyInstaller 的版本漂。
这里改堵住它们的**汇合点** —— 每一条最终只做三件事：

1. `GiModuleInfo.collect_typelib_data()` —— typelib 与它引用的共享库（Gtk/Gdk/Gio/GLib/
   GObject/Pango/Atk/cairo/harfbuzz/xlib 这一层）。堵在这里，六十多条里任何一条都收不到
   东西，也不必跟着上游的新模块改。
2. `collect_system_data_files` / `collect_glib_share_files` —— 图标主题、mime、GIO
   schema、翻译这些从**构建机**的 `/usr/share`、`/etc` 抄下来的运行期数据。
3. `PyInstaller.depend.dylib` 的排除表 —— 上面两条挡的是"钩子主动收"的那一半；
   `gi/_gi.so` 与 `gi/_gi_cairo.so` 自己的 `DT_NEEDED`（`libglib-2.0.so.0`、`libgobject`、
   `libgirepository`、`libcairo`…）是 PyInstaller **分析二进制依赖**时收的，绕过所有钩子。
   排除表是唯一能拦它的地方（PyInstaller 没有做这件事的命令行开关）。

`hook-gi.repository.{Gio,GdkPixbuf}.py` 是同一条理由的两个特例：那两条除了上面三件事，
还直接往产物里塞 GIO 模块与 gdk-pixbuf 加载器（构建机那一份），而它们的依赖正是被排除的
那些库 —— 留一半比整份拿掉更容易出错，所以那两条也整体换掉。

⚠ **少收不等于少能力**：这些东西全都由目标机的 `Depends` 提供（`gir1.2-webkit2-4.1` →
`gir1.2-gtk-3.0` → `libgtk-3-0`、`libglib2.0-0`、`adwaita-icon-theme`、`glib-networking`…），
`.deb` 与便携产物用的是同一套。便携产物因此也要求目标机装了 GTK3 + WebKitGTK 4.1 ——
它一直有这个要求（WebKit2 的 typelib 从来没有进过包），只是以前包里那半份把这件事遮住了。
见 `docs/INSTALL.md` § 3.4。
"""

from __future__ import annotations

from typing import Any, List

from PyInstaller.depend import dylib
from PyInstaller.utils.hooks import gi as gi_hooks
from PyInstaller.utils.hooks import logger

#: 冻结产物**不**自带的桌面栈共享库，按 soname（basename）匹配。
#:
#: 只列"根"：排除一个根之后，PyInstaller 不会再顺着它的 `DT_NEEDED` 往下列，所以
#: `libcairo` → `libpixman`/`libfontconfig`、`libgtk-3` → `libepoxy`、`libgdk_pixbuf` →
#: `librsvg`、GIO 模块 → `libgnutls`/`libproxy` 这些传递依赖会跟着一起消失，不必（也不该）
#: 逐条抄。
#:
#: 名字取自桌面那十三个 typelib 的 `shared-library` 字段与 `gi/_gi*.so` 的 `DT_NEEDED`；
#: `packaging/tests/test_build.py` 钉住其中关键的那几个。加了新的一条就该问：目标机的
#: `Depends` 会不会把它装上来？不会的话，它就不属于这份清单。
#: ⚠ `libgirepository-1.0.so.1` **不在这份清单里**，是有意的：它是我们**包内**那份
#: PyGObject（`gi/_gi.so`）自己的加载器，桌面栈没有任何东西会去用它，所以留着它既不盖住谁，
#: 又替便携产物堵住一个洞 —— 目标机上它只跟着 `python3-gi` 或某条 Recommends 来，
#: 而 `apt install --no-install-recommends gir1.2-webkit2-4.1` 的机器上没有它
#: （实测：那样装的 24.04 会在 `import gi` 就 `ImportError: libgirepository-1.0.so.1`）。
#: 它跟着目标机的 `libglib`/`libgobject`（都在上面那条清单里）跑，ABI 只往上走，所以安全。
STACK_LIBRARIES = (
    r"libglib-2\.0\.so.*",
    r"libgobject-2\.0\.so.*",
    r"libgio-2\.0\.so.*",
    r"libgmodule-2\.0\.so.*",
    r"libgtk-3\.so.*",
    r"libgdk-3\.so.*",
    r"libgdk_pixbuf-2\.0\.so.*",
    r"libatk-1\.0\.so.*",
    r"libpango-1\.0\.so.*",
    r"libpangocairo-1\.0\.so.*",
    r"libcairo\.so.*",
    r"libcairo-gobject\.so.*",
    r"libharfbuzz\.so.*",
    r"libX11\.so.*",
)


def _nothing(*_args: Any, **_kwargs: Any) -> List[Any]:
    """上游那几个 `collect_glib_*` 的替身：这台构建机上的那份，一律不收。"""
    return []


def _no_typelib_data(self: Any) -> tuple[list, list, list]:
    """`GiModuleInfo.collect_typelib_data()` 的替身：typelib 与它的库都由目标机提供。

    保留方法签名（这是个方法），返回上游那个三元组里的空版本。
    """
    return [], [], []


class _UpstreamPlusStack(dylib.MatchList):
    """上游那份"不收的系统库"名单，加上本仓的桌面栈 soname。

    `PyInstaller.depend.dylib.exclude_list` 是一个 `MatchList` 实例、没有加条目的接口，
    所以这里包一层：先问上游，再问我们。`include_list` 仍然能盖过两者 —— 那是上游的
    语义，不动它。
    """

    def __init__(self, upstream: Any) -> None:
        super().__init__([])  # MatchList 存的是一份拼好的正则，这里两条各存各的
        self._upstream = upstream
        self._ours = dylib.MatchList(list(STACK_LIBRARIES))

    def check_library(self, libname: str) -> Any:
        return self._upstream.check_library(libname) or self._ours.check_library(libname)


def adopt_the_system_stack() -> None:
    """把"桌面栈不由这个产物提供"落实到上面那三个汇合点上。

    ⚠ **在模块导入时调用**，而不是放进一个 `hook()`：PyInstaller 是按模块惰性加载钩子的，
    模块级代码在依赖图建到 `gi` 那一刻就跑，早于任何 `hook-gi.repository.*` 被加载；
    而 `hook()` 之间的先后没有保证 —— 把这件事挂在导入期，就不必赌自己排在那些钩子前面
    （实测：只靠这一处，产物里 Gtk 的图标/schema/翻译、十三个 typelib 与那一整层共享库
    一样都没进来）。

    可以重复调用（打包的别的路径、测试都可能再叫一次），重复只是不做第二遍。
    """
    gi_hooks.GiModuleInfo.collect_typelib_data = _no_typelib_data
    gi_hooks.collect_system_data_files = _nothing
    gi_hooks.collect_glib_share_files = _nothing

    if not isinstance(dylib.exclude_list, _UpstreamPlusStack):  # 幂等
        dylib.exclude_list = _UpstreamPlusStack(dylib.exclude_list)
    logger.info("桌面栈: 不收 %d 个 soname，改用目标机那一份（见 packaging/hooks/hook-gi.py）",
                len(STACK_LIBRARIES))


adopt_the_system_stack()

#: Python 侧那几个按名字取的 gi 模块 —— 上游那条 `hook-gi.py` 声明的就是这几个
#: （它还会按 PyGObject 的版本追加 `asyncio` 与 `gi._enum`）。
#:
#: ⚠ 这里**照抄**而不是把上游那条加载进来跑一遍，因为它一 import 就读 `pygobject` 的
#: metadata：那会把这半条清单绑死在"构建机的 PyGObject 装好了"上。而这几个模块本来也由
#: `--collect-all gi` 收（它们是 gi 包内的模块与扩展，`collect_all` 收得干净）；列在这里是
#: 那层保障消失时也不会静默少东西。上游将来多收什么，`--collect-all gi` 同样跟得上。
hiddenimports = ["gi._error", "gi._option"]
