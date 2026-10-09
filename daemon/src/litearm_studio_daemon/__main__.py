"""命令行入口 —— `litearm-studio-daemon [--fake] [--port P] [--http-port N] …`

计划 2 节「设备发现」与交付形态的落点: 一个本地程序, 双击/一条命令起, 监听本机,
**由本进程自己开一个应用窗口** (`window` 模块), 因此关掉窗口就是退出整个程序。
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path
from typing import List, Optional

from . import __version__, activation, obs
from .instance import find_running, focus as focus_running
from .obs import handlers as obs_handlers
from .obs import schema as obs_schema
from .server import HTTP_PORT_TRIES, _is_loopback, serve
from .session import Session
from .window import WindowUnavailable


def _log_level(value: str) -> str:
    """Normalise a ``--log-level`` spelling to a schema severity name.

    Accepts what a person would type (`debug`, `warning`) as well as the schema's
    own spelling (`WARN`), and rejects anything else at parse time — a silently
    ignored level is how "why is DEBUG not working" gets asked.
    """
    name = obs_schema.normalize_severity(value, default="")
    if name not in obs_schema.SEVERITY_NUMBERS:
        raise argparse.ArgumentTypeError(f"未知日志级别 {value!r}")
    return name


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="litearm-studio-daemon",
        description="LiteArm Studio 本地程序 —— 单臂会话 + 状态推送 + 命令执行")
    p.add_argument("--fake", action="store_true",
                   help="用 SDK 的假传输 (litearm.testing.FakeTransport) 起会话, 不碰真硬件")
    p.add_argument("--fake-unactivated", dest="fake_activated", action="store_false",
                   help="配合 --fake: 让假设备是**未激活**的那台, 于是授权面板与注册表单都能看到"
                        " (使能会被固件拒 ERR{0x10,0x08}, 与真机一致)")
    p.add_argument("--port", metavar="PORT", default=None,
                   help="串口设备路径 (覆盖自动发现; 界面上的端口下拉优先于它;"
                        " --fake 下无意义)")
    p.add_argument("--host", default="127.0.0.1",
                   help="监听地址 (只允许本机; 默认 127.0.0.1)")
    p.add_argument("--http-port", type=int, default=8765, metavar="N",
                   help="HTTP/WS 端口 (默认 8765; 被占用会自动换一个并打印实际端口)")
    p.add_argument("--ui-dir", metavar="DIR", default=None,
                   help="前端静态目录 (默认找仓库的 dist/; 不存在就只提供健康检查与 /ws)")
    p.add_argument("--no-open", action="store_true",
                   help="不开应用窗口, 无界面运行 (服务照常监听, 界面可用浏览器连该地址);"
                        "默认由本进程自己开窗口, 关掉窗口即退出整个程序")
    p.add_argument("--keep-enabled", action="store_true",
                   help="退出时不失能 (默认退出前会 disable 降能量; 仅在明确知道"
                        "机械臂会由别的方式保持时才用)")
    p.add_argument("--no-reconnect", action="store_true",
                   help="链路断了不自动重连 (默认会重新解析 CDC 设备并重建会话,"
                        "窗口 60s; 窗口内没接上会如实上报, 由你决定要不要手工连)")
    p.add_argument("--no-gripper", action="store_true",
                   help="不起夹爪会话 (默认在 Linux 上会起; 夹爪只监听同一个 CAN 总线)")
    p.add_argument("--can-channel", metavar="DEV", default=None,
                   help="夹爪所在的 SocketCAN 接口 (默认用上次记录的通道, 首次为 can0)")
    p.add_argument("--no-can-setup", action="store_true",
                   help="不尝试用 pkexec 拉起 CAN 接口 (接口由你或 systemd 管理时用;"
                        "也用于测试)")
    p.add_argument("--activation-url", metavar="URL",
                   default=os.environ.get("LITEARM_ACTIVATION_URL")
                   or activation.DEFAULT_ACTIVATION_URL,
                   help="激活服务地址 (默认 %(default)s; 传空字符串 = 不提供在线激活;"
                        "也可用环境变量 LITEARM_ACTIVATION_URL)")
    p.add_argument("--allow-origin", metavar="ORIGIN", action="append", default=[],
                   help="额外放行的跨源 WebSocket 来源, 可重复 (例如 "
                        "http://localhost:8000)。默认只接受与 Host 同源的握手; "
                        "浏览器对 WebSocket 不做同源限制, 所以放行一个来源等于让"
                        "该来源的页面能驱动机械臂 —— 只在你确知用途时才加。")
    p.add_argument("--verbose", "-v", action="store_true", help="打印调试日志")

    # ── 结构化日志 (issue #79 / #80) ─────────────────────────────────────────
    # 日志文件是**权威历史**: 页面可以因为端口漂移换掉 IndexedDB 库 (issue #80),
    # 这个文件不会。默认目录按平台惯例 (见 `obs.handlers.default_log_dir`)。
    p.add_argument("--log-dir", metavar="DIR", default=None,
                   help="结构化日志目录 (默认按平台惯例: Linux 为 "
                        "$XDG_STATE_HOME/litearm-studio; 也可用环境变量 "
                        f"{obs_handlers.LOG_DIR_ENV})")
    p.add_argument("--log-level", metavar="LEVEL", default="INFO",
                   type=_log_level, choices=sorted(obs_schema.SEVERITY_NUMBERS),
                   help="写入日志文件的最低级别: TRACE/DEBUG/INFO/WARN/ERROR/FATAL "
                        "(默认 INFO; DEBUG 会记下每条命令)")
    p.add_argument("--log-max-bytes", metavar="N", type=int,
                   default=obs_handlers.DEFAULT_MAX_BYTES,
                   help="单个日志文件的上限字节数, 超过即轮转 (默认 %(default)s)")
    p.add_argument("--log-backups", metavar="N", type=int,
                   default=obs_handlers.DEFAULT_BACKUPS,
                   help="轮转后保留的旧文件数 (默认 %(default)s)")
    p.add_argument("--log-stdout", action="store_true",
                   help="把同样的 JSONL 记录也写到 stderr —— 前台运行或交给 "
                        "Fluent Bit / 容器运行时采集时用; 不改变文件行为")
    return p


#: 这些选项一旦被显式改过, 本次启动就**不复用**在跑的实例 —— 它们描述的是"这次要一个
#: 什么样的会话/界面", 而复用一个已经存在的实例等于把它们静默丢掉。这条纪律与 #74 定下
#: 的"显式指定的选择不做退让"是同一条: 操作员指了 `--port /dev/ttyACM1`, 界面却停在上一个
#: 进程握着的 ACM0 上, 正是最坏的失败形状。
#:
#: ⚠ 桌面条目 (`packaging/deb.py`) 不带任何参数, 走的就是复用那条路; 这些开关是给命令行
#: 与台架用的。`fake` 也在里面, 所以 `_reuse_the_running_instance` 只可能以 `fake=False`
#: 去探测: 开发构建的版本号彼此相同 (见 `instance` 模块文档末段), 让 `--fake` 复用等于把
#: 上一个 checkout 的旧代码端给正在改代码的人。
_SESSION_SHAPING = (
    "fake", "fake_activated", "port", "ui_dir", "keep_enabled", "no_reconnect",
    "no_gripper", "can_channel", "no_can_setup", "activation_url", "allow_origin",
)


def _reuse_the_running_instance(args: argparse.Namespace,
                                defaults: argparse.Namespace) -> Optional[int]:
    """已经有同一个构建在跑就复用它 (返回 0); 否则返回 `None`, 由调用者照常启动。

    见 `instance` 模块文档: 串口是独占的, 第二个进程连不上机械臂, 而操作员读到的是硬件
    故障。这里先问一圈环回端口上有没有同一个构建, 有就把它的**窗口抬到前面**。

    ⚠ 与旧版不同: 这里**不再开一个浏览器窗口指向旧实例**。现在窗口由那个实例自己拥有
    (见 `window` 模块), 一个进程一个窗口, 所以第二次启动做的是把它抬起来 —— 这就是桌面
    程序点两次图标的规范行为, 也避免出现"两个窗口指向同一个会话"。旧实例是无界面运行
    的 (`--no-open`) 时没有窗口可抬, 此时如实把地址打出来让操作员自己开。

    ⚠ **必须在任何有副作用的构造之前调用** —— `build_gripper_session` 会真的去连 CAN。
    """
    if any(getattr(args, name) != getattr(defaults, name) for name in _SESSION_SHAPING):
        return None
    url = find_running(args.host, args.http_port, HTTP_PORT_TRIES,
                       version=__version__, fake=False)
    if url is None:
        return None
    print(f"[litearm-studio-daemon] 已有实例在运行, 复用它: {url}")
    if args.no_open:
        # 显式要求无界面 ⇒ 不碰任何窗口。地址仍然打出来, 操作员想开就自己开。
        print(f"[litearm-studio-daemon] 界面在 {url} (--no-open: 没有开窗)")
    elif focus_running(url):
        print("[litearm-studio-daemon] 已把它的窗口抬到前面")
    else:
        print(f"[litearm-studio-daemon] 它没有窗口可抬起 (无界面运行?); 界面在 {url}")
    return 0


def build_gripper_session(args: argparse.Namespace):
    """Build the gripper session, or ``None`` when this build has none.

    The gripper is **absent, not disabled**, where it cannot work (D10): the SDK
    needs ``fcntl`` and ``PF_CAN`` and raises at import on Windows, so there is
    nothing to configure and no button that would only fail.  ``--fake`` is the
    exception — the simulator is pure Python and runs anywhere, which is what
    makes the page testable on a machine with no CAN bus at all.

    ⚠ The **construction** is inside the ``try`` as well, not just the import.
    ``from .gripper.session import GripperSession`` does not touch the SDK (the
    real backend is imported lazily, ``gripper/session.py``); the SDK import
    happens when the session builds its backend, which is the constructor call.
    Guarding only the import therefore let a missing SDK escape as an
    ``ImportError`` out of ``main`` — the daemon did not start at all on Linux,
    arm included, which is the opposite of "absent, not disabled".
    """
    if args.no_gripper:
        return None
    if not (args.fake or sys.platform.startswith("linux")):
        logging.getLogger("litearm_studio_daemon").info(
            "夹爪只在 Linux 上提供 (需要 PF_CAN); 本平台为 %s, 已跳过", sys.platform)
        return None
    try:
        from .gripper.session import GripperSession

        return GripperSession(fake=args.fake, channel=args.can_channel,
                              can_setup=not args.no_can_setup)
    except ImportError:
        # The SDK is genuinely not installed: expected off Linux, and a deliberate
        # "no gripper here" on a Linux box that has not cloned it.  No traceback —
        # this is a configuration answer, not a fault.
        logging.getLogger("litearm_studio_daemon").warning(
            "没有夹爪 SDK (litegrip)，本次不提供夹爪；见 daemon/README 的「依赖」一节")
        return None
    except Exception:  # noqa: BLE001 - 其它任何失败同样只是"这次没有夹爪"
        logging.getLogger("litearm_studio_daemon").warning(
            "无法加载夹爪模块；本次不提供夹爪", exc_info=True)
        return None


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    #: 一份"什么都没指定"的对照 —— 复用判据要拿它逐项比较 (见 `_SESSION_SHAPING`)。
    defaults = parser.parse_args([])
    # 结构化日志 (issue #79): 文件是权威历史, 页面只是它的一个视图。**排在任何有副作用
    # 的构造之前** —— 启动失败本身也要留下一条能读的记录。
    log_dir = Path(args.log_dir).expanduser() if args.log_dir else None
    obs.configure(log_dir=log_dir, version=__version__, level=args.log_level,
                  max_bytes=args.log_max_bytes, backups=args.log_backups,
                  stderr=args.log_stdout)
    # 人读的那条仍走 stdlib: uvicorn / SDK 的 logging 不该被塞进 JSONL, 那会在同一个
    # 文件里混进两种格式, 让 Fluent Bit 之类的采集器解析失败。
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    if not _is_loopback(args.host):
        # 早退: 与其把异常抛到 uvicorn 那一层, 不如在这里把理由说清楚。
        print(f"只允许监听本机 (127.0.0.1), 拒绝 --host {args.host!r}", file=sys.stderr)
        obs.error(obs.STARTUP_REFUSED, body="拒绝监听非本机地址",
                  fields={"host": args.host, "reason": "non_loopback_host"})
        return 2
    if not args.fake and not args.fake_activated:
        # 组合无意义时明确报错, 而不是静默忽略: 用户以为"未激活的假设备"起来了,
        # 实际上会去连真硬件 (或者连不上), 排障时这是最费时间的一种失败。
        print("--fake-unactivated 只在 --fake 下有意义 (它说的是**假设备**的状态)",
              file=sys.stderr)
        obs.error(obs.STARTUP_REFUSED, body="--fake-unactivated 未配合 --fake",
                  fields={"reason": "invalid_option_combination"})
        return 2
    obs.info(obs.DAEMON_STARTED, body=f"守护进程启动 (LiteArm Studio {__version__})",
             fields={"fake": bool(args.fake), "http_port": int(args.http_port),
                     "log_dir": str(log_dir or obs_handlers.default_log_dir()),
                     "log_file": str(obs.log_path() or ""),
                     "open_browser": not args.no_open})
    # 已经在跑同一个构建 ⇒ 把窗口指向它, 本进程不起 (issue #75)。这一步排在 Session /
    # 夹爪的构造**之前**: 夹爪的构造会连 CAN, 一旦连上就已经是"第二个会话"了。
    reused = _reuse_the_running_instance(args, defaults)
    if reused is not None:
        return reused
    session = Session(port=args.port, fake=args.fake,
                      fake_activated=args.fake_activated,
                      reconnect=not args.no_reconnect,
                      disable_on_exit=not args.keep_enabled,
                      activation_url=args.activation_url)
    gripper = build_gripper_session(args)
    try:
        asyncio.run(serve(session, gripper=gripper, host=args.host,
                          http_port=args.http_port, ui_dir=args.ui_dir,
                          open_browser=not args.no_open,
                          allow_origins=args.allow_origin))
    except WindowUnavailable as exc:
        # ⚠ **不静默退回无界面**: 那正是"操作员以为程序关了、进程还握着串口"这个缺陷的
        # 形状。没有界面就说清楚为什么, 并且告诉他怎么显式地无界面运行。
        print(f"[litearm-studio-daemon] {exc}", file=sys.stderr)
        obs.error(obs.STARTUP_REFUSED, body="没有可用的 webview 后端, 拒绝以无界面方式继续",
                  fields={"reason": "window_unavailable"})
        return 3
    except KeyboardInterrupt:
        return 0
    finally:
        # 进程退出前把缓冲刷出去: 少了这一步, 最后几条 (往往是"为什么退出") 会丢。
        obs.flush()
        obs.shutdown()
    return 0


if __name__ == "__main__":  # pragma: no cover - 由 `main()` 覆盖
    raise SystemExit(main())
