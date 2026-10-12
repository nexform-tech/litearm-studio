"""冻结产物借目标机那一份 gdk-pixbuf 加载器 —— 替代 PyInstaller 自带的同名钩子。

同 `hook-gi.py` 的理由，这一条是其中的特例：上游除了 typelib（已经被 `hook-gi.py` 堵住）
还会把**构建机**的 `gdk-pixbuf-2.0/2.10.0/loaders/*.so` 连同为它们生成的 `loaders.cache`
一起收进产物。那些加载器的依赖正是被排除掉的桌面栈（`libtiff.so.5`、`librsvg-2.so.2`、
`libwebp`、`libjpeg`…），`libtiff.so.5` 在 24.04 上不存在 —— 这正是 issue #123 说的
"TIFF 预览没了"那一条：加载器留、依赖走系统，是个只会半坏的组合。

目标机装了 GIO/GTK 就带着 gdk-pixbuf 自己的加载器与缓存（`.deb` 的 `Depends` 保证这一点），
所以这里把上游那条**原样跑一遍**（不抄它的代码 —— 它是 GPL，抄进本仓是许可问题），
只把它的 `binaries`/`datas` 收下不交，`hiddenimports` 照旧转交。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any, List, Tuple

import PyInstaller

#: 上游那条钩子。按文件路径加载，因为它不是个能 import 的名字。
UPSTREAM_HOOK = Path(PyInstaller.__file__).parent / "hooks" / "hook-gi.repository.GdkPixbuf.py"


class _BinariesAndDatasDropped:
    """接住上游要收的东西：`binaries`/`datas` 留下不发，其余原样转发。

    上游只用到 `add_datas` / `add_binaries` / `add_imports` 三个方法（外加
    `hook_config` 之类的属性读取），所以接住这三个、其余原样转发即可。
    """

    def __init__(self, hook_api: Any) -> None:
        self._api = hook_api
        self.dropped = 0

    def add_datas(self, datas: Any) -> None:
        self.dropped += len(list(datas))

    def add_binaries(self, binaries: Any) -> None:
        self.dropped += len(list(binaries))

    def add_imports(self, *module_names: str) -> None:
        self._api.add_imports(*module_names)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._api, name)


def _load_upstream() -> Any:
    spec = importlib.util.spec_from_file_location("_litearm_upstream_gdkpixbuf_hook", UPSTREAM_HOOK)
    if spec is None or spec.loader is None:  # pragma: no cover - 只有装坏了的 PyInstaller 会走到
        raise SystemExit(f"[hooks] 读不到上游的 GdkPixbuf 钩子: {UPSTREAM_HOOK}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def hook(hook_api: Any) -> None:
    sieve = _BinariesAndDatasDropped(hook_api)
    _load_upstream().hook(sieve)
