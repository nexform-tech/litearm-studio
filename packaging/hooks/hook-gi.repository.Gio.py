"""冻结产物借目标机那一份 GIO 模块 —— 替代 PyInstaller 自带的同名钩子。

同 `hook-gi.py` 的理由（桌面栈由目标机提供，包里再放一份只会盖住系统的），这一条是其中的
特例：上游除了 typelib（已经被 `hook-gi.py` 堵住）还往产物里放两样**构建机的**东西：

* `gio/modules/*.so` —— TLS 与代理后端。它们的依赖是 `libgnutls`/`libproxy`/`libunistring`
  那一串，正是被排除掉的桌面栈；留一半（模块留、依赖走系统）比整份拿掉更容易出错，而且
  `libunistring.so.2` 这种 soname 在 24.04 上根本不存在（issue #123 列的四条半坏库之一
  就是这个链条）。
* `/usr/share/mime/mime.cache` —— 构建机的内容类型缓存。目标机的 `shared-mime-info` 里有
  同一份，而且 GIO 自己按 `XDG_DATA_DIRS` 找得到。

留下的只有 Python 侧那一个 hiddenimport：Gio 的平台实现是运行时按名字取的，静态分析看不见。
"""

from PyInstaller import compat

hiddenimports = ["gi.repository.Gio" + ("Win32" if compat.is_win else "Unix")]
