"""LiteArm Studio 本地程序 (守护进程)。

对外只有三样东西: 本模块的 `create_app` (FastAPI 应用)、`Session` (会话)、
以及 `__main__` 的命令行入口。前端契约见
`litearm-studio/docs/REFACTOR_PLAN.md` 3.1~3.4 节。
"""
from __future__ import annotations

#: 守护进程自己的版本 —— 就是 `hello` 帧里那个 `daemon` 字段 (计划 3.1)。
#: ⚠ 与 `pyproject.toml` 的 `version` **不是**同一个东西: 那个是 semantic-release 的
#: 占位符 (由 CI 在发布工作区改写), 而前端拿到的应该是"这份代码"的版本。本仓库
#: AGENTS.md §3 明令不得手改 manifest 里的 version 字段, 故两者分开维护;
#: `tests/test_server.py::test_hello_frame_reports_versions` 钉住这里的值非空。
__version__ = "0.1.0"

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
