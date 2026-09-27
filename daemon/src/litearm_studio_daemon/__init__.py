"""LiteArm Studio 本地程序 (守护进程)。

对外只有三样东西: 本模块的 `create_app` (FastAPI 应用)、`Session` (会话)、
以及 `__main__` 的命令行入口。前端契约见
`litearm-studio/docs/REFACTOR_PLAN.md` 3.1~3.4 节。
"""
from __future__ import annotations


def _resolve_version() -> str:
    """守护进程版本 —— 就是 `hello` 帧里那个 `daemon` 字段 (计划 3.1)。

    来源按优先级:

    1. **打包时生成**的 `_build_version.py` —— CI 把 git tag 注入进去 (见
       `packaging/build.py`)。这是发出去的那个版本, 与 release tag 一致。
    2. 已安装发行版的元数据 (`importlib.metadata`) —— 本地 venv / pip 安装时可用。
    3. 兜底 `0.0.0+unknown` (源码直接跑、且没装包时)。

    ⚠ 与 `pyproject.toml` 的 `version` **不是**同一个东西: 那个是 semantic-release
    的占位符 (`0.0.0+semantic-release`), 本仓库 AGENTS.md §3 明令不得手改, 故两者
    分开维护; `tests/test_server.py` 钉住这里的值非空。
    """
    try:
        from ._build_version import __version__ as built  # type: ignore[import-not-found]
        if built:
            return built
    except Exception:  # noqa: BLE001 - 构建产物不存在是正常情况
        pass
    try:
        from importlib.metadata import version as _pkg_version
        return _pkg_version("litearm-studio-daemon")
    except Exception:  # noqa: BLE001 - 没装包 (源码直接跑)
        return "0.0.0+unknown"


__version__ = _resolve_version()

__all__ = ["__version__", "Session", "create_app", "serve"]


def __getattr__(name: str):
    """惰性转发 `Session` / `create_app` / `serve` —— 避免 import 包就拉起 fastapi。"""
    if name == "Session":
        from .session import Session
        return Session
    if name in ("create_app", "serve"):
        from . import server
        return getattr(server, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
