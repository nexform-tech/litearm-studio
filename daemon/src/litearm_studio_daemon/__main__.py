"""命令行入口 —— `litearm-studio-daemon [--fake] [--port P] [--http-port N] …`

计划 2 节「设备发现」与交付形态的落点: 一个本地程序, 双击/一条命令起, 监听本机,
用浏览器应用模式开窗口 (找不到 Chromium 系就退回普通标签页, 见 `server._open_browser`)。
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from typing import List, Optional

from .server import _is_loopback, serve
from .session import Session


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="litearm-studio-daemon",
        description="LiteArm Studio 本地程序 —— 单臂会话 + 状态推送 + 命令执行")
    p.add_argument("--fake", action="store_true",
                   help="用 SDK 的假传输 (litearm.testing.FakeTransport) 起会话, 不碰真硬件")
    p.add_argument("--port", metavar="PORT", default=None,
                   help="串口设备路径 (覆盖自动发现; --fake 下无意义)")
    p.add_argument("--host", default="127.0.0.1",
                   help="监听地址 (只允许本机; 默认 127.0.0.1)")
    p.add_argument("--http-port", type=int, default=8765, metavar="N",
                   help="HTTP/WS 端口 (默认 8765; 被占用会自动换一个并打印实际端口)")
    p.add_argument("--ui-dir", metavar="DIR", default=None,
                   help="前端静态目录 (默认找仓库的 dist/; 不存在就只提供健康检查与 /ws)")
    p.add_argument("--no-open", action="store_true",
                   help="不自动打开浏览器窗口 (默认尝试以应用模式打开)")
    p.add_argument("--keep-enabled", action="store_true",
                   help="退出时不失能 (默认退出前会 disable 降能量; 仅在明确知道"
                        "机械臂会由别的方式保持时才用)")
    p.add_argument("--verbose", "-v", action="store_true", help="打印调试日志")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    if not _is_loopback(args.host):
        # 早退: 与其把异常抛到 uvicorn 那一层, 不如在这里把理由说清楚。
        print(f"只允许监听本机 (127.0.0.1), 拒绝 --host {args.host!r}", file=sys.stderr)
        return 2
    session = Session(port=args.port, fake=args.fake,
                      disable_on_exit=not args.keep_enabled)
    try:
        asyncio.run(serve(session, host=args.host, http_port=args.http_port,
                          ui_dir=args.ui_dir, open_browser=not args.no_open))
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":  # pragma: no cover - 由 `main()` 覆盖
    raise SystemExit(main())
