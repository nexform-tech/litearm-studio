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
* **夹爪 SDK 按平台收**：`litegrip` 需要 `fcntl` / `PF_CAN`，Windows 上装了也
  import 不了 —— 那里的构建**不收它**，产物里夹爪是缺席的（D10）。Linux 上缺它
  则**直接判失败**：一个"忘了装 SDK"的 Linux 产物会静默地没有夹爪，而那是发布物
  必须具备的能力。
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

# ⚠ Windows 控制台默认是 cp1252: 打中文会抛 `UnicodeEncodeError`, 让**整个构建步骤**
# 判失败 —— 实测 CI 上 PyInstaller 已经成功, 却死在后一句 `print` 上。先切 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001 - 非标准流/老解释器就保持原样
        pass

ROOT = Path(__file__).resolve().parents[1]
DAEMON_SRC = ROOT / "daemon" / "src"
UI_DIST = ROOT / "dist"
OUT_DIST = ROOT / "packaging" / "dist"
WORK = ROOT / "packaging" / "build"
VERSION_FILE = DAEMON_SRC / "litearm_studio_daemon" / "_build_version.py"
EXE_NAME = "litearm-studio-daemon"
# Windows 可执行文件的图标。不传 `--icon` 时 PyInstaller 会用它自带的默认图标 ——
# 发出去的程序在资源管理器/任务栏里就是那个通用图标，而不是我们的标识。
# Linux 的 ELF 不嵌图标，这个参数在 Linux 上只是被 PyInstaller 接受后忽略。
ICON = ROOT / "assets" / "litearm.ico"


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


#: 夹爪 SDK 的平台判据。与 daemon 侧的 `__main__.build_gripper_session` 同一条口径：
#: Linux 上提供，别处缺席。这里用 `sys.platform` 而不是 `os.name`，因为判据是
#: PF_CAN（POSIX 内核特性）而不是"是不是 Windows"。
GRIPPER_PLATFORMS = ("linux",)


def sdk_available(name: str) -> bool:
    """这个包在当前解释器里装了吗（不 import 它 —— import 会执行模块代码）。"""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):  # pragma: no cover - 名字被别的包挡住
        return False


def gripper_build_args() -> list[str]:
    """夹爪 SDK 的 PyInstaller 参数, 或一句"为什么没有它"。

    `--collect-all litegrip` 是必须的：包里除了 .py 还有三份 JSON（两个模板与出厂
    标定）和 `py.typed`，只收模块的话 `load_template()` 找不到文件会抛。
    """
    on_gripper_platform = sys.platform.startswith(GRIPPER_PLATFORMS)
    if not on_gripper_platform:
        print(f"[package] {sys.platform}: 夹爪缺席 (需要 PF_CAN), 不收 litegrip")
        return []
    if not sdk_available("litegrip"):
        raise SystemExit(
            "找不到夹爪 SDK `litegrip`，但这是 Linux 构建 —— 发布出来的 Linux 产物"
            "会**没有夹爪**。请先克隆并安装它（仓库 nexform-tech/litegrip-python，"
            "钉住的版本见 release.yml）：\n"
            "    git clone https://github.com/nexform-tech/litegrip-python.git\n"
            "    pip install ./litegrip-python")
    print("[package] 收集夹爪 SDK litegrip（含模板与出厂标定）")
    return ["--collect-all", "litegrip"]


def main() -> int:
    if not (UI_DIST / "index.html").is_file():
        raise SystemExit(
            f"界面未构建: {UI_DIST}/index.html 不存在 —— 先执行 `pnpm build` "
            f"(打包必须带上界面, 否则可执行程序只能提供 /api/health)")
    if not (ROOT / "daemon" / "src" / "litearm_studio_daemon").is_dir():
        raise SystemExit(f"找不到 daemon 源码: {DAEMON_SRC}")
    # ⚠ 图标缺失要**在这里**失败，不能交给 PyInstaller：它接受不存在的 `--icon`
    # 路径然后照常打包成功（回到默认图标），于是"图标没换"这种问题只有用户能看到。
    if not ICON.is_file():
        raise SystemExit(
            f"找不到图标: {ICON} —— 它是入库文件；若被误删，用 "
            f"`node scripts/render-icon-png.mjs && node scripts/make-icon.mjs` 重新生成")

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
        # 可执行文件图标（Windows）；Linux 上被接受但忽略
        "--icon", str(ICON),
        "--paths", str(DAEMON_SRC),
        # 界面: _MEIPASS/dist （与 resolve_ui_dir 的冻结分支一致）
        "--add-data", f"{UI_DIST}{os.pathsep}dist",
        # SDK 不在 PyPI 上, 连数据文件一起收进来
        "--collect-all", "litearm",
        "--collect-all", "serial",
        *gripper_build_args(),
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
