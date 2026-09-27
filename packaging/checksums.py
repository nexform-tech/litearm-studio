"""给一个目录里的每个产物写一个 `.sha256` 旁文件（Phase 5 的发布附件校验和）。

```bash
python packaging/checksums.py upload
# upload/litearm-studio-0.6.2-linux-amd64.sha256
# upload/litearm-studio-0.6.2-windows-amd64.exe.sha256
```

⚠ **为什么不是一份聚合的 `SHA256SUMS.txt`**: 打包 job 是 ubuntu / windows 两个
runner 各跑一遍, 每个 runner 只看得见自己那个产物。写同名聚合文件 + `--clobber`
的结果是**后传的覆盖先传的** —— 实测 v0.6.2 的 `SHA256SUMS.txt` 里只剩 Windows
那一行, Linux 的校验和直接丢了。旁文件名字唯一, 不存在互相覆盖。

⚠ 单独成脚本而不是工作流内联 shell: Windows 的默认 shell 是 pwsh, 内联 heredoc
(`python - <<'PY'`) 在那边是语法错误 (实测 CI 被它判失败)。
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
    written = []
    for path in sorted(target.iterdir()):
        if not path.is_file() or path.name.endswith(".sha256"):
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        sidecar = path.with_name(path.name + ".sha256")
        sidecar.write_text(f"{digest}  {path.name}\n", encoding="utf-8")
        written.append(sidecar.name)
        print(f"{digest}  {path.name}")
    if not written:
        print(f"[checksums] {target} 里没有可校验的产物", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
