"""只收我们真正需要的那两套图标主题 —— 替代 PyInstaller 自带的同名钩子。

`packaging/build.py` 用 `--additional-hooks-dir` 把这个目录塞在最前面。PyInstaller 每个
模块只留一条钩子、同名的用户钩子优先，所以这一条**就是**上游那条的替身，而不是补充。

**为什么值得替。** 上游那条在没配 hooksconfig 时执行 `collect_glib_share_files('icons')`，
把**构建机**上装着的整套图标主题原样收进产物。ubuntu-22.04 上是 Humanity(展开后
54.7 MB)、ubuntu-mono-light/dark、Humanity-Dark、HighContrast…：v0.22.2 的 `.deb` 里
光图标主题一项就是 71 MB，占 203 MB 安装体积的三分之一还多。而本程序的界面是 webview
里的一片 HTML——它画自己的图标；GTK 侧用到主题的只有窗口控件和文件对话框，那是
**目标机**的桌面本来就会提供的东西。

**怎么替的。** 这里不抄上游的代码——PyInstaller 的钩子是 GPL，抄进本仓是许可问题——
而是把上游那条钩子**原样执行一遍**（见 `_load_upstream()`），接住它要收的东西，筛掉
多余的图标主题，再把剩下的交回去。上游以后多收什么，这一条都自动跟上：唯一被改动的
只有下面那份白名单。

留下的两套各有理由：

* `Adwaita` —— GTK 自己的兜底主题。目标机上什么主题都没有时（首启、最小安装、非
  Ubuntu 桌面的发行版），窗口控件与对话框的图标仍然画得出来。
* `hicolor` —— XDG 规定的应用图标基准主题，任何一次图标查找的最后兜底。

⚠ 少收不等于少能力：用户当前用的主题（Ubuntu 上默认是 Humanity）由**系统**提供，
GTK 通过 XDG 数据目录照样找得到它；包里这 71 MB 是构建机的那一份，与目标机无关。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any, List, Tuple

import PyInstaller
from PyInstaller.utils.hooks import logger

#: 留下的图标主题。其余一律不收 —— 理由见模块文档。
KEEP_ICON_THEMES = ("Adwaita", "hicolor")

#: 上游那条钩子。按文件路径加载，因为 `hook-gi.repository.Gtk` 不是个能 import 的名字。
UPSTREAM_HOOK = Path(PyInstaller.__file__).parent / "hooks" / "hook-gi.repository.Gtk.py"


def keeps(entry: Tuple[Any, ...]) -> bool:
    """这条 datas 记录留不留：只拦图标主题，别的（typelib、fontconfig、mime、翻译）全放行。

    记录的形态是 `(来源, 目的)` 两元组（`hook_api.add_datas` 交出去时会被换成
    `(目的, 来源)`，所以两头都看一眼）。图标主题在两边都长成 `.../share/icons/<主题>/...`。
    """
    for value in entry[:2]:
        parts = Path(str(value)).parts
        if "icons" not in parts:
            continue
        index = parts.index("icons")
        theme = parts[index + 1] if len(parts) > index + 1 else ""
        return theme in KEEP_ICON_THEMES
    return True


class _Sieve:
    """接住上游钩子要收的东西，先存在这里，等筛过再交给真正的 `hook_api`。

    上游钩子只用到 `add_datas` / `add_binaries` / `add_imports` 三个方法（外加 `hook_config`
    之类的属性），所以这里接住这三个、其余原样转发即可 —— 不需要知道它以后会用什么。
    """

    def __init__(self, hook_api: Any) -> None:
        self._api = hook_api
        self.datas: List[Tuple[Any, ...]] = []

    def add_datas(self, datas: Any) -> None:
        self.datas += list(datas)

    def add_binaries(self, binaries: Any) -> None:
        self._api.add_binaries(binaries)

    def add_imports(self, *module_names: str) -> None:
        self._api.add_imports(*module_names)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._api, name)


def _load_upstream() -> Any:
    """上游那条钩子（`UPSTREAM_HOOK`）加载成模块。"""
    spec = importlib.util.spec_from_file_location("_litearm_upstream_gtk_hook", UPSTREAM_HOOK)
    if spec is None or spec.loader is None:  # pragma: no cover - 只有装坏了的 PyInstaller 会走到
        raise SystemExit(f"[hooks] 读不到上游的 GTK 钩子: {UPSTREAM_HOOK}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def dropped_themes(datas: List[Tuple[Any, ...]]) -> List[str]:
    """被拦下的主题名（只为打日志、给测试看）。"""
    names = set()
    for entry in datas:
        if keeps(entry):
            continue
        for value in entry[:2]:
            parts = Path(str(value)).parts
            if "icons" in parts:
                index = parts.index("icons")
                if len(parts) > index + 1:
                    names.add(parts[index + 1])
    return sorted(names)


def hook(hook_api: Any) -> None:
    sieve = _Sieve(hook_api)
    _load_upstream().hook(sieve)

    kept = [entry for entry in sieve.datas if keeps(entry)]
    dropped = dropped_themes(sieve.datas)
    if dropped:
        logger.info(
            "图标主题: 只收 %s，丢弃构建机上的 %s（%d 项数据）",
            "/".join(KEEP_ICON_THEMES), "/".join(dropped), len(sieve.datas) - len(kept))
    hook_api.add_datas(kept)
