"""PyInstaller 入口 —— 冻结后没有 `console_scripts`, 这里直接调 CLI。

⚠ 不要在 `__main__.py` 上直接打包: 它靠 `if __name__ == "__main__"` 触发, 而
PyInstaller 会把入口脚本当 `__main__` 执行, 行为虽然能对, 但多一层隐式约定。
这里显式 import + `SystemExit(main())`, 与 entry point 完全同构。

⚠ **这里比 entry point 多做一件事, 而且只能在这里做**: 兜住未捕获的异常。Windows
产物是 GUI 子系统的 exe (见 `build.console_build_args`), 没有控制台 —— 一个未捕获的
异常在那里等于"双击了, 什么都没发生": PyInstaller 往一个 `None` 的 stderr 上打
traceback, 然后进程消失。`fatal.report_exception` 把它变成一句人读得懂的话 (最后几行
traceback + 日志文件路径) 加上一个对话框。源码直跑不走这条路, 那里 traceback 本来就
该原样冒出来。

`Exception` 而不是 `BaseException`: `SystemExit` (argparse 的 `--help` / 参数错误) 与
`KeyboardInterrupt` 必须照常穿过 —— 前者是正常退出路径, 后者 `main()` 自己已经处理。
"""
from __future__ import annotations

from litearm_studio_daemon import fatal
from litearm_studio_daemon.__main__ import main

if __name__ == "__main__":
    try:
        code = main()
    except Exception as exc:  # noqa: BLE001 - 理由见模块文档
        fatal.report_exception(exc)
        raise SystemExit(1) from exc
    raise SystemExit(code)
