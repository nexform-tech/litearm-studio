"""PyInstaller 入口 —— 冻结后没有 `console_scripts`, 这里直接调 CLI。

⚠ 不要在 `__main__.py` 上直接打包: 它靠 `if __name__ == "__main__"` 触发, 而
PyInstaller 会把入口脚本当 `__main__` 执行, 行为虽然能对, 但多一层隐式约定。
这里显式 import + `SystemExit(main())`, 与 entry point 完全同构。
"""
from __future__ import annotations

from litearm_studio_daemon.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
