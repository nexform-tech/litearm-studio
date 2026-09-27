"""把 daemon + SDK + 界面打成一个单文件可执行程序（计划 Phase 5）。

用法（**仓库根目录**执行，且 `pnpm build` 已经产出 `dist/`）：

```bash
python packaging/build.py
# 产物：packaging/dist/litearm-studio-daemon[.exe]
```

三件事：

* **版本来源唯一**：优先环境变量 `LITEARM_STUDIO_VERSION`（CI 传 git tag），否则
  `git describe --tags`，再否则 `0.0.0+dev`。写进 `_build_version.py`（构建产物，
  不入库，见 `.gitignore`）—— 这样 `hello.daemon` 报的就是发出去的那个 tag，
  而不是 manifest 里的 `0.0.0+semantic-release` 占位符。
* **把界面打进包**：`dist/` 以 `--add-data` 放到 `_MEIPASS/dist`，
  `server.resolve_ui_dir()` 认识这个冻结路径（免手工 `--ui-dir`）。
* **把 SDK 打进包**：`litearm` 不在 PyPI 上，必须随包内嵌（含 `pyserial`）。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DAEMON_SRC = ROOT / "daemon" / "src"
UI_DIST = ROOT / "dist"
OUT_DIST = ROOT / "packaging" / "dist"
WORK = ROOT / "packaging" / "build"
VERSION_FILE = DAEMON_SRC / "litearm_studio_daemon" / "_build_version.py"
EXE_NAME = "litearm-studio-daemon"


def resolve_version() -> str:
    """tag > git describe > 兜底。统一的去 `v` 前缀口径由调用方决定。"""
    env = os.environ.get("LITEARM_STUDIO_VERSION", "").strip()
    if env:
        return env
    try:
        described = subprocess.check_output(
            ["git", "describe", "--tags", "--always"], cwd=ROOT, text=True,
            stderr=subprocess.DEVNULL).strip()
        return described or "0.0.0+dev"
    except Exception:  # noqa: BLE001 - 没有 git 也能构建（只是版本不精确）
        return "0.0.0+dev"


def main() -> int:
    if not (UI_DIST / "index.html").is_file():
        raise SystemExit(
            f"界面未构建: {UI_DIST}/index.html 不存在 —— 先执行 `pnpm build` "
            f"(打包必须带上界面, 否则可执行程序只能提供 /api/health)")
    if not (ROOT / "daemon" / "src" / "litearm_studio_daemon").is_dir():
        raise SystemExit(f"找不到 daemon 源码: {DAEMON_SRC}")

    version = resolve_version().lstrip("v")
    VERSION_FILE.write_text(
        '"""构建时生成 —— 不要提交（见 .gitignore）。"""\n'
        f'__version__ = "{version}"\n',
        encoding="utf-8")
    print(f"[package] version = {version}")

    shutil.rmtree(WORK, ignore_errors=True)
    OUT_DIST.mkdir(parents=True, exist_ok=True)

    args = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile",
        "--name", EXE_NAME,
        "--paths", str(DAEMON_SRC),
        # 界面: _MEIPASS/dist （与 resolve_ui_dir 的冻结分支一致）
        "--add-data", f"{UI_DIST}{os.pathsep}dist",
        # SDK 不在 PyPI 上, 连数据文件一起收进来
        "--collect-all", "litearm",
        "--collect-all", "serial",
        # uvicorn 的 loop/protocol 实现是动态导入的, PyInstaller 静态分析看不见
        "--collect-submodules", "uvicorn",
        "--collect-submodules", "websockets",
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops.auto",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.lifespan.on",
        "--distpath", str(OUT_DIST),
        "--workpath", str(WORK),
        "--specpath", str(WORK),
        str(ROOT / "packaging" / "launcher.py"),
    ]
    print("[package] " + " ".join(args))
    subprocess.run(args, check=True, cwd=ROOT)

    produced = OUT_DIST / (EXE_NAME + (".exe" if os.name == "nt" else ""))
    if not produced.is_file():
        raise SystemExit(f"打包结束但没找到产物: {produced}")
    print(f"[package] 产物: {produced} ({produced.stat().st_size / 1e6:.1f} MB)")
    # 构建产物没有意义留在源码树里: 版本文件删掉, 免得被误提交/误当作已打包。
    VERSION_FILE.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
