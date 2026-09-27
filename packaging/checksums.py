"""给一个目录里的文件写 `SHA256SUMS.txt`（Phase 5 的发布附件校验和）。

```bash
python packaging/checksums.py upload
```

⚠ 单独成脚本而不是在工作流里写内联 shell: 打包 job 同时跑 ubuntu 与 windows,
而 Windows 的默认 shell 是 pwsh —— 内联的 bash heredoc (`python - <<'PY'`) 在那边
直接是语法错误（实测 CI 被它判失败）。这里用纯 Python, 两个 runner 行为一致。
"""
from __future__ import annotations

import hashlib
import pathlib
import sys

# Windows 控制台是 cp1252 —— 与 build.py 同样的理由, 先切 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    target = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "upload")
    if not target.is_dir():
        print(f"[checksums] 目录不存在: {target}", file=sys.stderr)
        return 1
    lines = []
    for path in sorted(target.iterdir()):
        if path.name == "SHA256SUMS.txt" or not path.is_file():
            continue
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}")
    if not lines:
        print(f"[checksums] {target} 里没有可校验的文件", file=sys.stderr)
        return 1
    (target / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
