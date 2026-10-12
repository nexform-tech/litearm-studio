"""哪些名字算"桌面栈" —— 冻结产物里不该出现的那一份。

谁读这个文件：`packaging/hooks/hook-gi.py`（按这份规则**拦收集**）与
`packaging/build.py`（按同一份规则**检查产物**）。两边共用一份是有意的：一旦"拦"和"查"
各拿一份清单，就会出现"拦住了但查不出来"或反过来的空档，而这类退化的特点正是**没有任何
报错** —— 包只是又白白多带一份，或者在某个没验过的发行版上打不开窗口（issue #123）。

谁不需要读：改界面、改机械臂协议的人。这里只有名字与理由。

**为什么"不收"是对的。** 窗口后端借目标机的 WebKitGTK（`libwebkit2gtk` 94 MB 从不进包，
由 `.deb` 的 `Depends: gir1.2-webkit2-4.1` 要过来），那套依赖会把 GTK/GLib/GIO 的库、
typelib、gdk-pixbuf 加载器、GIO 模块与图标主题一起装上。包里再放一份，带的是**与系统同名
的 soname**，在进程里会盖住系统的：22.04 的 `libglib-2.0.so.0`(2.72) 盖住 24.04 的
(2.80)，24.04 的系统 `libgudev`（WebKitGTK 要用）于是找不到 `g_once_init_enter_pointer`，
WebKit 加载失败、窗口开不出来。完整经过见 `hook-gi.py` 的模块文档。
"""

from __future__ import annotations

import re
from typing import Optional, Tuple

#: 冻结产物**不**自带的共享库，按 soname（basename）匹配。
#:
#: 名单里有几个看起来与桌面无关的名字（`libmount`、`libblkid`、`libselinux`、`libpcre`），
#: 它们不是抄错了：PyInstaller 是用 `ldd` 解析依赖的，拿到的是**整条传递闭包** —— 分析
#: `gi/_gi.so` 时连 `libglib` 自己的依赖也一起报上来。`libglib` 被挡掉之后，它的这些依赖
#: 就成了"包里没有任何东西需要的孤儿"，**却照样同名盖住系统的**。所以这份清单要覆盖
#: 被排除那些库自己的依赖，不能只写"根"。
#:
#: 只列根 + 已知的这几条，不去动态算闭包：动态算会连 `libffi` 一起排掉，而 Python 自己的
#: `ctypes` 要用它。名单必须有人看着，`packaging/tests/test_build.py` 钉住其中关键的那些。
#:
#: ⚠ `libgirepository-1.0.so.1` **不在**这份清单里，是有意的：它是包内那份 PyGObject
#: （`gi/_gi.so`）自己的加载器，桌面栈没有任何东西会去用它，所以留着它既不盖住谁，又替
#: 便携产物堵住一个洞 —— 目标机上它只跟着 `python3-gi` 或某条 Recommends 来，而
#: `apt install --no-install-recommends gir1.2-webkit2-4.1` 的机器上没有它（实测：那样装的
#: 24.04 会在 `import gi` 就 `ImportError: libgirepository-1.0.so.1`）。
STACK_LIBRARIES: Tuple[str, ...] = (
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
    # glib 自己的依赖（`ldd` 的传递闭包把它们带进来，见上）。
    r"libpcre\.so.*",
    r"libpcre2-8\.so.*",
    r"libmount\.so.*",
    r"libblkid\.so.*",
    r"libselinux\.so.*",
)

#: 这些路径前缀下的东西是桌面栈的运行期数据/插件，同样由目标机提供。
#: 名字取自上游那几条 `hook-gi.repository.*` 往产物里放东西的位置。
STACK_PATH_PREFIXES: Tuple[str, ...] = (
    "gi_typelibs/",           # 那十三个 typelib（Gtk/Gdk/GLib/GIO/Pango/Atk/cairo…）
    "gio_modules/",           # TLS/代理后端（libgiognutls、libproxy…）
    "lib/gdk-pixbuf/",        # 图片加载器与为它们生成的缓存
    "share/icons/",           # 图标主题
    "share/themes/",          # GTK 主题
    "share/mime/",            # 内容类型缓存
    "share/glib-2.0/",        # GIO schema
    "share/fontconfig/",      # 字体配置
    "share/locale/",          # GTK/GLib 的翻译
    "etc/fonts/",             # 字体配置（etc 那一半）
    "etc/gtk-3.0/",           # GTK 配置（etc 那一半）
)

#: 以这些结尾的文件同样是桌面栈的（typelib 可能落在别的目录下）。
STACK_PATH_SUFFIXES: Tuple[str, ...] = (".typelib",)


def strikes(name: str) -> Optional[str]:
    """这一步产物的成员名算不算桌面栈？算就返回一句"为什么"，不算返回 `None`。

    `name` 用产物里的相对路径（目录形态形如 `_internal/lib/libglib-2.0.so.0`，单文件形态
    形如 `lib/libglib-2.0.so.0`），两种前缀都由调用方归一化后再进来。
    """
    base = name.rsplit("/", 1)[-1]
    for pattern in STACK_LIBRARIES:
        if re.fullmatch(pattern, base):
            return f"{base} 会被目标机的同名库盖住（或反过来盖住它）"
    for suffix in STACK_PATH_SUFFIXES:
        if name.endswith(suffix):
            return f"{name} 是桌面栈的 typelib"
    for prefix in STACK_PATH_PREFIXES:
        if name.startswith(prefix):
            return f"{name} 是桌面栈的运行期数据/模块"
    return None
