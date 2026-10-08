"""FastAPI 应用 —— HTTP (静态资源 + 健康检查) 与 WebSocket (`/ws`)。

契约见 REFACTOR_PLAN 3.1 节「消息格式」。本模块**只做传输**: 所有会话逻辑
(连接/命令/运动互斥) 都在 `session.py` 里, 这里只把两边对接起来:

```
浏览器 ──WS 上行──> handle_ws ──> Session.execute() ──> litearm
浏览器 <──WS 下行── broadcast <── Session 监听器 (conn/state)
```

两条纪律:

* **客户端断开不杀会话** —— 计划 2 节原则 4「安全在本地程序里」。`/ws` 的 finally 里
  只摘掉自己的队列与监听器, `session.disconnect()` **不**在那里被调。
* **只监听 127.0.0.1** —— 越线暴露一个能驱动机械臂的接口是安全事故, 不是配置项。
  该判据由 `run()` 强制 (它只管启动; 应用本身不知道该绑哪儿)。
* **`/ws` 只接受同源握手** —— 浏览器对 WebSocket **不做同源限制**, 所以任何网页都能连
  `ws://127.0.0.1:8765/ws` 并驱动机械臂。判据在 `handle_ws` 的第一行 (见
  `origin_allowed`): 没有 Origin 头 = 非浏览器客户端, 放行; 有 Origin 就必须同源,
  且 Host 必须是 loopback (后者挡 DNS rebinding)。
"""
from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import socket
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, List, Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.responses import Response
from starlette.types import Scope

from . import __version__, logread, obs
from .errors import error_to_dict
from .statemap import jsonable
from .session import ENERGY_DOWN_COMMANDS, Session

log = logging.getLogger("litearm_studio_daemon.server")

#: `run()` 允许绑定的地址白名单 —— 只监听本机 (计划 2 节架构: "Studio 本地程序,
#: 仅监听 127.0.0.1")。想开给局域网没有开关, 只能改代码 (刻意的)。
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

#: 开发期前端 (vite) 的源。生产形态下页面由本进程自己伺服, 于是 Origin 与 Host 必然
#: 相同, 不需要这条; 只有 dev 时页面在 vite 的端口上、而 `/ws` 被代理到本进程, 两者才
#: 可能不同 (是否改写 Host 取决于代理实现) ⇒ 显式放行, 免得把开发环境挡在门外。
DEV_ORIGINS = frozenset({"http://localhost:5173", "http://127.0.0.1:5173"})

#: 单条命令的等待上限 (秒) —— 兜底, 防止某条 SDK 调用在**命令执行器**上永久卡住
#: (那样后续所有命令都会陪等)。取 60s: `home`/`movej` 在真机上最坏十几秒
#: (`move_timeout` 默认 15s), `enable` 的重试上界约 3.3s。
COMMAND_TIMEOUT_S = 60.0

#: `gripper.zero` 的等待上限 (秒) —— 它按定义要跑几十秒 (顶两次机械限位),
#: 所以不能套用 60s 那条兜底。客户端同样不能给它设 60s 超时 (§4.2)。
GRIPPER_ZERO_TIMEOUT_S = 300.0

#: 多久广播一次日志流的位置 (`log_meta`: 序号 + 丢帧数)。取 2s 的理由: 丢帧与断流都是
#: 页面**自己发现不了**的事, 而 2s 短到"操作员还没开始困惑", 又长到不占可观的带宽
#: (一条几十字节)。它只在有客户端时发。
LOG_META_INTERVAL_S = 2.0


@dataclass
class _Client:
    """一个 WS 客户端 —— 自己的发送队列 + 自己的发送锁。

    ⚠ 队列是**必须**的: 状态广播可能来自会话的轮询线程, 而 `WebSocket.send_json`
    是 async 的。队列让广播变成 `put_nowait` (线程安全、非阻塞), 真正的 `await send`
    只发生在该客户端自己的 `_pump` 任务里 —— 慢客户端丢帧而不是拖住广播。
    """
    q: asyncio.Queue
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    #: 因队列满而被丢掉的 log 帧数。页面据此知道"这段空白是丢帧, 不是没发生"。
    dropped_logs: int = 0
    #: 这个客户端已经收到的最后一条 log 帧序号 (由 `_pump` 更新)。序号是页面判断
    #: "我漏了东西没有"的唯一证据 —— 空白与"什么都没发生"长得一模一样。
    last_log_seq: int = 0


def _is_loopback(host: str) -> bool:
    return host in LOOPBACK_HOSTS


def _hostname_of(netloc: str) -> str:
    """`localhost:8765` / `[::1]:8765` → `localhost` / `::1`。"""
    text = (netloc or "").strip().lower()
    if text.startswith("["):
        return text[1:].split("]", 1)[0]
    return text.rsplit(":", 1)[0] if ":" in text else text


def origin_allowed(origin: str, host: str, extra: Iterable[str] = ()) -> bool:
    """跨源 WebSocket 的准入判据 —— 浏览器不做同源限制, 所以判据只能在这里。

    两条一起才够, 少一条都是假修:

    * **同源** (Origin 的 netloc == Host) 挡的是"别的站点直接连本机端口";
    * **Host 必须是 loopback** 挡的是 **DNS rebinding** —— 那种攻击下 Origin 与 Host
      都是攻击者的域名, 同源判据会**通过**, 只有 Host 白名单能拦下。

    `extra` 是显式放行的源 (开发期的 vite)。判据只对**带 Origin 的握手**生效: 没有
    Origin 头说明是非浏览器客户端 (脚本 / 原生工具) —— 浏览器一定会发, 所以放行它不
    扩大威胁面 (本地进程本来就能直接开串口)。
    """
    if origin in DEV_ORIGINS or origin in extra:
        return True
    try:
        parts = urlsplit(origin)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return False
    if parts.netloc.lower() != (host or "").strip().lower():
        return False
    return _hostname_of(host) in LOOPBACK_HOSTS


def _is_energy_down_frame(raw: str) -> bool:
    """这条上行帧是不是降能量方向的安全命令 (要绕开有序队列, 立刻处理)。

    ⚠ 解析失败 / 形状不对一律当**普通帧** —— 交给 `_on_upstream` 回 BadMessage,
    坏 JSON 没必要走旁路。这里只偷看 `t`/`m` 两个字段, 真正的校验仍在 `_on_upstream`。

    ⚠ 夹爪的 `gripper.stop` 也在这条旁路上 (§4.2): 它同样"永远可达" —— 排在一条
    3 秒的闭合命令后面就不是急停了。夹爪的 `gripper.disable` **不走**旁路: 文档
    明确要求它是普通排队命令。
    """
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return False
    if not isinstance(msg, dict) or msg.get("t") != "cmd":
        return False
    method = msg.get("m")
    return method in ENERGY_DOWN_COMMANDS or method == "gripper.stop"


#: `pick_free_http_port` 从 `start` 起最多试几个端口。⚠ 复用探测
#: (`instance.find_running`) **必须扫同一个范围**: 上一个实例可能因为 8765 被别的程序
#: 占着而挪到了 8766, 只问 `start` 会漏掉它 (issue #75)。
HTTP_PORT_TRIES = 50


def pick_free_http_port(host: str = "127.0.0.1", start: int = 8765,
                        tries: int = HTTP_PORT_TRIES) -> int:
    """从 `start` 起找一个能绑的端口 —— 被占用就 +1, 逐个试。找不到抛 `OSError`。

    ⚠ 这里是**先探测再交给 uvicorn**, 中间有一个极小的竞态窗口 (探到空 → 别人抢走)。
    可接受: 真撞上时 uvicorn 会自己报 `address already in use`, 而我们相对于"直接在
    端口冲突时崩掉"已经好了一大截 (计划要求: 被占用就自动换一个并打印实际端口)。
    """
    for port in range(int(start), int(start) + int(tries)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
            except OSError:
                continue
            return port
    raise OSError(f"{host}:{start}..{start + tries - 1} 都不可用")


def resolve_ui_dir(ui_dir: Optional[str], *,
                   repo_dist: Optional[Path] = None) -> Optional[Path]:
    """静态目录: 显式 `--ui-dir` 优先, 其次**冻结包里的界面**, 否则退回仓库 `dist/`。
    **不存在就返回 None**。

    计划要求「默认找仓库的 `dist/`, 不存在就跳过, 不要报错」—— 于是这里**不抛异常**,
    也**不创建**目录 (前端还没构建时, 守护进程照样要能起来, `/api/health` 照样能用)。

    ⚠ 冻结 (PyInstaller onefile) 后 `__file__` 指向解包目录, 仓库相对路径
    (`parents[3]/dist`) 必然不存在 —— 打包时界面放在 `_MEIPASS/dist`
    (见 `packaging/build.py` 的 `--add-data`), 所以这里要先认它。
    """
    if ui_dir:
        p = Path(ui_dir).expanduser()
        return p if p.is_dir() else None
    bundled = _bundled_ui_dir()
    if bundled is not None:
        return bundled
    base = repo_dist if repo_dist is not None else Path(__file__).resolve().parents[3] / "dist"
    return base if base.is_dir() else None


def _bundled_ui_dir() -> Optional[Path]:
    """冻结包里内嵌的界面目录 (`_MEIPASS/dist`); 非冻结或不存在时 `None`。"""
    base = getattr(sys, "_MEIPASS", None)
    if not base:
        return None
    p = Path(base) / "dist"
    return p if p.is_dir() else None


class Daemon:
    """会话 + 客户端集合 —— 一个进程一个实例 (`create_app` 把它封进 FastAPI)。

    单独成类是为了让 HTTP/WS 之外的东西 (广播、批量发送) 能被单测直接调, 不必起服务。
    """

    def __init__(self, session: Session, *, gripper: Optional[Any] = None,
                 version: str = __version__,
                 ui_dir: Optional[Path] = None,
                 allow_origins: Iterable[str] = ()) -> None:
        self.session = session
        #: 夹爪会话 (§3) —— 与臂会话并列, 各推各的帧、各走各的命令白名单。
        #: `None` = 本进程没有夹爪 (非 Linux, 或 `--no-gripper`)。
        self.gripper = gripper
        self.version = version
        self.ui_dir = ui_dir
        #: **额外**放行的跨源源 (命令行 `--allow-origin`)。`DEV_ORIGINS` 由
        #: `origin_allowed` 自己认, 不在这里重复。
        self.allow_origins = frozenset(allow_origins)
        self.clients: List[_Client] = []
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        #: 已广播的结构化记录条数 (单调递增, 也是 `log` 帧的 `seq`)。
        self._log_seq = 0
        #: 因某个客户端队列满而丢掉的 log 帧数 (全局累计)。
        self._log_dropped = 0
        #: 夹爪看门狗的心跳任务 (见 `_gripper_heartbeat_loop`)。
        self.heartbeat_task: Optional[asyncio.Task] = None
        #: 日志流位置的播报任务 (见 `_log_meta_loop`) —— 与夹爪无关, 总是起。
        self.log_meta_task: Optional[asyncio.Task] = None
        # 会话事件 (可能来自轮询线程/执行器线程) → 事件循环的桥
        session.add_listener(self._on_session_event)
        if gripper is not None:
            gripper.add_listener(self._on_gripper_event)
        # 结构化记录 → `log` 帧 (issue #79 第 2 点)。文件仍是权威历史, 这一路只让页面
        # 实时跟上; 没有客户端时 `_on_log_record` 立刻返回, 不排任何东西。
        obs.set_sink(self._on_log_record)

    # ------------------------------------------------------------ 会话事件 → WS
    def _on_session_event(self, event: dict) -> None:
        """会话监听器 —— **可能在任何线程上被调用**, 故只做线程安全的投递。"""
        self.broadcast_threadsafe(event)

    def _on_gripper_event(self, event: dict) -> None:
        """夹爪会话监听器 —— 同样只做线程安全的投递。"""
        self.broadcast_threadsafe(event)

    # ------------------------------------------------------------ 夹爪心跳
    def stamp_gripper_heartbeat(self) -> None:
        """告诉夹爪会话"还有客户端在"。"""
        if self.gripper is not None:
            self.gripper.heartbeat()

    async def _gripper_heartbeat_loop(self,
                                      interval: float = 0.5) -> None:  # pragma: no cover
        """只要有客户端连着就一直喂心跳。

        ⚠ 这正是"关掉的标签页不能继续夹着东西"在守护进程侧的落点: 浏览器与守护进程
        之间没有别的心跳通道, 而**连接本身**就是"操作员还在"的证据。客户端全走光之后
        夹爪会在 `GUI_WATCHDOG_S` 内降能量, 但它**不会**因此结束会话 —— 刷新页面回来
        还能继续用 (臂那边"客户端断开不杀会话"是同一条纪律)。
        """
        while True:
            await asyncio.sleep(interval)
            if self.clients:
                self.stamp_gripper_heartbeat()

    async def _log_meta_loop(self,
                             interval: float = LOG_META_INTERVAL_S) -> None:  # pragma: no cover
        """定期播报日志流的位置 (序号与丢帧数)。

        ⚠ 与夹爪的心跳**分开**: 那段心跳只在有夹爪会话时才起, 而日志流在**每个**
        平台上都有 (非 Linux、`--no-gripper` 都没有夹爪)。把播报挂在它身上, 等于在
        一半的部署里根本不报 —— 页面于是永远分不清"断了一段"与"什么都没发生"。

        ⚠ 也**不能只在接入时报一条**: 队列满导致的丢帧发生在连接**之后**。
        """
        while True:
            await asyncio.sleep(interval)
            if self.clients:
                self.broadcast({"t": "log_meta", **self._log_meta()})

    # ------------------------------------------------------------ 结构化记录 → WS
    def _on_log_record(self, record: dict) -> None:
        """一条结构化记录 → 每个客户端的 `log` 帧。

        ⚠ **可能在任何线程上被调用** (状态轮询 / 命令执行器 / DFU 线程), 所以这里只做
        线程安全的投递, 与 `_on_session_event` 同形。没有客户端时立刻返回: 记录已经进
        文件了, 没人看的时候不必为它排队。
        """
        if not self.clients:
            return
        self._log_seq += 1
        self.broadcast_threadsafe({"t": "log", "seq": self._log_seq, "record": record})

    def _log_meta(self) -> dict:
        """流的位置 —— 页面据此知道"我漏了没有、漏了多少"。

        `seq` 是**最后一条已广播**的序号; `dropped` 是全局累计的丢帧数; `clients` 是
        "这条元信息会送到几个客户端" —— 握手时它还没有把自己算进去 (注册在后), 于是
        那一条如实报 0。页面重新连上时拿 `seq` 比对本地最大值, 就能发现自己缺了一段。
        """
        return {"t": "log_meta", "seq": self._log_seq,
                "dropped": self._log_dropped, "clients": len(self.clients)}

    def broadcast_threadsafe(self, message: dict) -> None:
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self.broadcast, message)
        except RuntimeError:  # 事件循环已停 —— 没有收件人, 丢掉即可
            log.debug("事件循环已关闭, 丢弃一条 %s", message.get("t"))

    def broadcast(self, message: dict) -> None:
        """给**每个**客户端入队一条帧 (在事件循环线程上调用)。"""
        for c in list(self.clients):
            try:
                c.q.put_nowait(message)
            except asyncio.QueueFull:
                # 慢客户端丢**状态**帧就好 (下一拍就有新的); conn/res 丢了会让前端
                # 一直转圈, 所以那两类宁可挤掉队列里最旧的一条状态。
                if message.get("t") in ("conn", "res"):
                    try:
                        c.q.get_nowait()
                        c.q.put_nowait(message)
                    except Exception:  # noqa: BLE001
                        pass
                elif message.get("t") == "log":
                    # ⚠ 日志帧丢了**要留下痕迹**: 文件里那条记录仍然在, 但页面上会
                    # 出现一段空白, 而"空白"与"什么都没发生"长得一模一样。计数同时落在
                    # 客户端与全局上, 由 `log_meta` 如实上报。
                    #
                    # ⚠ **不许在这里 emit 一条记录**: 队列满时再发一条会走同一条路,
                    # 于是自己把自己再丢一次, 变成死循环。
                    c.dropped_logs += 1
                    self._log_dropped += 1

    # ------------------------------------------------------------ WS 单客户端
    async def handle_ws(self, ws: WebSocket) -> None:
        # ⚠ **先判准入再 accept**: 未 accept 就 close ⇒ Starlette 直接回 403, 不建连接。
        #   没有 Origin 头 = 非浏览器客户端 (脚本 / 原生工具), 放行 —— 见 `origin_allowed`。
        origin = ws.headers.get("origin")
        if origin is not None and not origin_allowed(
                origin, ws.headers.get("host", ""), self.allow_origins):
            log.warning("拒绝跨源 WebSocket: origin=%r host=%r",
                        origin, ws.headers.get("host"))
            obs.warning(obs.WS_REJECTED, body=f"拒绝跨源 WebSocket: {origin}",
                        fields={"origin": origin, "host": ws.headers.get("host", "")})
            await ws.close(code=1008)          # 1008 = policy violation
            return
        await ws.accept()
        #: 一条 WS 连接 = 一条 trace (见 `obs.trace`), 于是"点连接 → 握手 → 命令 →
        #: 断链"在日志里能按同一次操作串起来。⚠ 它必须是**这个连接自己的局部量** ——
        #: 存到 `self` 上会被第二个客户端覆盖, 于是两条连接的记录互相串线。
        trace_id = obs.new_trace_id()
        #: 会话命令的入口, 已带上这条连接的 trace。
        #:
        #: ⚠ 刻意**不**给 `Session.execute` 加一个 `trace=` 参数: `execute` 是命令的
        #: 唯一漏斗, 而测试会给它塞一个签名固定的假件 (见
        #: `test_ws_estop_does_not_wait_for_a_command_in_flight`) —— 多一个调用参数
        #: 会让那种注入静默失效, 变成一条看不到的回归。包一层的效果一样, 且只影响
        #: "从浏览器来的命令", 正是 trace 想描述的那批。
        execute = self._traced_execute(trace_id)
        obs.debug(obs.WS_CONNECTED, body="浏览器客户端已接入",
                  fields={"origin": origin or "", "clients": len(self.clients) + 1},
                  trace_id=trace_id)
        client = _Client(q=asyncio.Queue(maxsize=256))
        #: 普通上行帧的**有序**队列 —— 单条 worker 顺序消费, 保证「先发的先执行」
        #: (前端有依赖顺序的连招: set_speed 之后再 movej)。
        queue: asyncio.Queue[str] = asyncio.Queue()
        #: 降能量方向的安全帧**不进队列** —— 直接起任务, 于是不必等在途运动结束。
        #: 这是「急停永远可达」在传输层的另一半 (另一半是 `Session` 的专用执行器):
        #: 原来的 `await self._on_upstream(...)` 会把 `receive_text` 也一起挡住,
        #: 连急停帧都读不出来。
        bypass: set[asyncio.Task] = set()
        pump: Optional[asyncio.Task] = None
        worker: Optional[asyncio.Task] = None
        registered = False

        def _bypass_done(task: asyncio.Task) -> None:
            bypass.discard(task)
            if not task.cancelled() and task.exception() is not None:
                # 客户端可能已经走了 ⇒ 回帧失败很正常, 记 debug 即可, 不许炸事件循环。
                log.debug("旁路安全命令处理异常", exc_info=task.exception())

        try:
            # ⚠ **先把两条握手帧写完, 再把客户端注册进 `self.clients`**: 一旦注册,
            # 50Hz 的状态广播就能经 `_pump` 插进 `hello`/`conn` 之间, 握手顺序
            # (计划 3.1) 就不再保证。代价只是握手这几毫秒里的广播不进这个队列 ——
            # 下一拍 (20ms) 就有新的, 新窗口不会因此空一下。
            await self._send_direct(ws, client, {
                "t": "hello", "daemon": self.version, "sdk": self.session.sdk_version,
            })
            await self._send_direct(ws, client, {"t": "conn", **self.session.arm_info()})
            # ⚠ 流的元信息必须**在握手这一段**发出去 (客户端注册与 `_pump` 启动之前):
            # 一旦注册, 50Hz 状态与日志就会插进来, 于是"一接入就知道流走到哪儿"这件事
            # 变成"可能先收到一条日志、再收到 meta"。页面记下 `seq` 之后才能判断
            # "中间丢过帧没有" —— 所以它必须是最早的信息之一。
            await self._send_direct(ws, client, {"t": "log_meta", **self._log_meta()})
            if self.gripper is not None:
                # 夹爪的握手帧与臂同构: `gripper_conn` 是它连接态的唯一真相 (§4.1)。
                await self._send_direct(ws, client, {
                    "t": "gripper_conn", **self.gripper.conn_info(),
                })
                # 有人连上了 ⇒ 夹爪看门狗不该在这个窗口里把电放掉。
                self.stamp_gripper_heartbeat()
            if self.session.connected:
                # 已连接时补一条当前状态 —— 新开的窗口不该等到下一拍才画出 3D。
                st = self.session.state()
                if st is not None:
                    await self._send_direct(ws, client, {
                        "t": "state", "stamp": 0.0, "state": st,
                    })
            if self.gripper is not None:
                # 同理: 已连接的夹爪补一条状态, 否则新窗口要等 20ms 才画出读数。
                gs = self.gripper.state()
                if self.gripper.connected() and gs is not None:
                    await self._send_direct(ws, client, {
                        "t": "gripper_state", "stamp": 0.0, "state": gs,
                    })
            self.clients.append(client)
            registered = True
            pump = asyncio.create_task(self._pump(ws, client))
            worker = asyncio.create_task(
                self._drain(ws, client, queue, trace_id, execute))
            while True:
                raw = await ws.receive_text()
                # 上行帧是最强的"操作员还在"证据, 连上之后立刻补一次 (连接本身也算)。
                self.stamp_gripper_heartbeat()
                if _is_energy_down_frame(raw):
                    task = asyncio.create_task(
                        self._on_upstream(ws, client, raw, trace_id, execute))
                    bypass.add(task)
                    task.add_done_callback(_bypass_done)
                else:
                    await queue.put(raw)
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001 - 一个客户端坏了不该影响别人
            log.debug("WS 客户端异常结束", exc_info=True)
        finally:
            # ⚠ **只**摘掉这个客户端自己 —— 不碰会话 (计划 2 节原则 4)。
            if registered:
                try:
                    self.clients.remove(client)
                except ValueError:
                    pass
                obs.debug(obs.WS_DISCONNECTED, body="浏览器客户端已离开",
                          fields={"clients": len(self.clients),
                                  "dropped_logs": client.dropped_logs},
                          trace_id=trace_id)
                if client.dropped_logs:
                    # 队列满时丢掉的 log 帧在这里结账: 页面会看到一条明确的
                    # "丢了 N 条", 而不是一段无法解释的空白。
                    obs.warning(obs.LOG_DROPPED,
                                body=f"慢客户端导致 {client.dropped_logs} 条日志帧被丢弃",
                                fields={"dropped": client.dropped_logs},
                                trace_id=trace_id)
            for task in bypass:
                task.cancel()
            if worker is not None:
                worker.cancel()
            if pump is not None:
                pump.cancel()

    def _traced_execute(self, trace_id: Optional[str]) -> Callable[..., Any]:
        """`session.execute`, with this connection's trace bound around the call.

        A context var rather than a parameter: `execute` is injected by tests with a
        fixed signature, and threading a new argument through it would turn a
        legitimate injection into a TypeError that only shows up as "the command
        failed". See the note at the call site.

        ⚠ 快照必须在**这里**取, 不能指望 `asyncio.to_thread` 帮忙: `to_thread`
        复制的是 `to_thread` 被调用的那一刻的上下文, 而那时我们还没进这段包装
        (包装是在工作线程里才被调用的) ⇒ 复制到的是"没有 trace"的那一份。这里显式
        `copy_context()` 再在包装内 `run`, trace 才真的跟着命令走到执行器线程上。
        """
        snapshot = contextvars.copy_context()

        def run(method: str, params: Optional[dict] = None, *,
                on_event: Optional[Callable[[dict], Any]] = None) -> Any:
            def call() -> Any:
                return self.session.execute(method, params, on_event=on_event,
                                            trace=trace_id)
            return snapshot.copy().run(call)
        return run

    async def _drain(self, ws: WebSocket, client: _Client,
                     queue: "asyncio.Queue[str]",
                     trace_id: Optional[str] = None,
                     execute: Optional[Callable[..., Any]] = None) -> None:
        """顺序消费普通上行帧 (单条 worker ⇒ 保序)。"""
        while True:
            raw = await queue.get()
            await self._on_upstream(ws, client, raw, trace_id, execute)

    async def _send_direct(self, ws: WebSocket, client: _Client, message: dict) -> None:
        async with client.lock:
            await ws.send_text(json.dumps(message, ensure_ascii=False,
                                          allow_nan=False, default=str))

    async def _pump(self, ws: WebSocket, client: _Client) -> None:
        while True:
            message = await client.q.get()
            if message.get("t") == "log":
                seq = message.get("seq")
                if isinstance(seq, int):
                    client.last_log_seq = seq
            async with client.lock:
                await ws.send_text(json.dumps(message, ensure_ascii=False,
                                              allow_nan=False, default=str))

    async def _on_upstream(self, ws: WebSocket, client: _Client, raw: str,
                           trace_id: Optional[str] = None,
                           execute: Optional[Callable[..., Any]] = None) -> None:
        """上行帧分发 —— 格式不对就回一条 `res` 错误, 不静默吞。"""
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            obs.warning(obs.UPSTREAM_INVALID, body="上行帧不是合法 JSON",
                        fields={"reason": "invalid_json", "bytes": len(raw)},
                        trace_id=trace_id)
            await self._send_direct(ws, client, {
                "t": "res", "id": None, "ok": False,
                "err": {"kind": "BadMessage", "msg": "不是合法 JSON"},
            })
            return
        if not isinstance(msg, dict):
            obs.warning(obs.UPSTREAM_INVALID, body="上行帧顶层不是 JSON 对象",
                        fields={"reason": "not_an_object",
                                "type": type(msg).__name__},
                        trace_id=trace_id)
            await self._send_direct(ws, client, {
                "t": "res", "id": None, "ok": False,
                "err": {"kind": "BadMessage", "msg": "顶层需是 JSON 对象"},
            })
            return
        kind = msg.get("t")
        if kind == "connect":
            # `port` (可选) = 顶栏下拉里选的那个口。缺省/空串 ⇒ 交给会话自己解析
            # (`--port` → 上次连上的口 → 自动发现, 见 `Session._connect_candidates`)。
            # ⚠ 只在这一帧上生效, 落地成"这次连接的目标", 不改 `--port`。
            raw_port = msg.get("port")
            if raw_port is not None and not isinstance(raw_port, str):
                await self._send_direct(ws, client, {
                    "t": "res", "id": msg.get("id"), "ok": False,
                    "err": {"kind": "BadMessage", "msg": "connect 的 port 需是字符串"},
                })
                return
            # 幂等, 且**立刻**回: 握手在命令执行器上跑, 进度由 `conn` 帧报。
            # ⚠ 已连着时指一个**不同**的口 ⇒ `Session.connect` 抛
            #   `PortChangeWhileConnectedError`; 这里必须把它变成 `ok:false` 的应答,
            #   否则帧发出去就没人接 (静默丢弃正是这个功能要修的缺陷)。用与
            #   `_run_command` 同一条 `error_to_dict` 通道, 不另造错误形状。
            try:
                started = self.session.connect(raw_port, trace=trace_id)
            except Exception as e:  # noqa: BLE001 - 任何失败都回一条结构化 err
                obs.warning(obs.UPSTREAM_INVALID,
                            body=f"connect 被拒: {type(e).__name__}: {e}",
                            fields={"reason": "connect_refused",
                                    "port": raw_port or "",
                                    "error_kind": type(e).__name__},
                            trace_id=trace_id)
                await self._send_direct(ws, client, {
                    "t": "res", "id": msg.get("id"), "ok": False,
                    "err": error_to_dict(e),
                })
                return
            await self._send_direct(ws, client, {
                "t": "res", "id": msg.get("id"), "ok": True, "v": {"started": started},
            })
            return
        if kind == "disconnect":
            stopped = self.session.disconnect()
            await self._send_direct(ws, client, {
                "t": "res", "id": msg.get("id"), "ok": True, "v": {"stopped": stopped},
            })
            return
        if kind != "cmd":
            obs.warning(obs.UPSTREAM_INVALID, body=f"未知上行消息类型 {kind!r}",
                        fields={"reason": "unknown_type", "t": str(kind)},
                        trace_id=trace_id)
            await self._send_direct(ws, client, {
                "t": "res", "id": msg.get("id"), "ok": False,
                "err": {"kind": "BadMessage", "msg": f"未知消息类型 {kind!r}"},
            })
            return
        await self._run_command(ws, client, msg, trace_id, execute)

    async def _run_command(self, ws: WebSocket, client: _Client, msg: dict,
                           trace_id: Optional[str] = None,
                           execute: Optional[Callable[..., Any]] = None) -> None:
        """`{"t":"cmd","id":1,"m":"enable","p":{}}` → `res` 帧 (计划 3.1)。"""
        mid = msg.get("id")
        method = msg.get("m")
        params = msg.get("p") or {}
        if not isinstance(method, str) or not method:
            await self._send_direct(ws, client, {
                "t": "res", "id": mid, "ok": False,
                "err": {"kind": "BadMessage", "msg": "cmd 需要 m 字段"},
            })
            return
        if not isinstance(params, dict):
            await self._send_direct(ws, client, {
                "t": "res", "id": mid, "ok": False,
                "err": {"kind": "BadMessage", "msg": "p 需是对象"},
            })
            return

        # 夹爪与臂共用同一个命令 id 空间, 但**不共用**命令表 (§4.2): `gripper.`
        # 前缀是唯一的分流判据, 于是臂的白名单一个字节没变。
        if method.startswith("gripper."):
            await self._run_gripper_command(ws, client, mid, method, params, trace_id)
            return

        # `Session.execute` 是**阻塞**的 (它在单线程执行器上等 SDK 调用), 所以这里
        # 必须丢到线程里, 否则整个事件循环 (含状态推送/急停) 会被一条 movej 憋住。
        # `Session.execute` 内部先做准入判定 (白名单/运动互斥/连接态), 那几步在提交
        # 之前完成 —— 于是"在途时第二条运动命令"是**立刻**被拒, 不是排队后被拒。
        run = execute if execute is not None else self.session.execute
        try:
            value = await asyncio.wait_for(
                asyncio.to_thread(run, method, params,
                                  on_event=self.broadcast_threadsafe),
                timeout=COMMAND_TIMEOUT_S)
        except asyncio.TimeoutError:
            obs.error(obs.COMMAND_TIMEOUT,
                      body=f"{method} 超过 {COMMAND_TIMEOUT_S:.0f}s 未返回",
                      fields={"method": method, "timeout_s": COMMAND_TIMEOUT_S,
                              "scope": "arm"},
                      trace_id=trace_id)
            await self._send_direct(ws, client, {
                "t": "res", "id": mid, "ok": False,
                "err": {"kind": "CommandTimeoutError",
                        "msg": f"{method} 超过 {COMMAND_TIMEOUT_S:.0f}s 未返回",
                        "method": method},
            })
            return
        except Exception as e:  # noqa: BLE001 - 任何失败都回一条结构化 err
            await self._send_direct(ws, client, {
                "t": "res", "id": mid, "ok": False,
                "err": error_to_dict(e, method=method),
            })
            return
        await self._send_direct(ws, client, {
            "t": "res", "id": mid, "ok": True, "v": jsonable(value),
        })

    async def _run_gripper_command(self, ws: WebSocket, client: _Client, mid: Any,
                                   method: str, params: dict,
                                   trace_id: Optional[str] = None) -> None:
        """`gripper.*` → `GripperSession.execute` → `res` 帧。

        ⚠ 与臂那条路的区别是**超时**: 夹爪命令不阻塞 (它们入队就返回), 唯一例外的
        `gripper.zero` 要顶两次机械限位, 几十秒是正常的 —— 所以它有自己的上限,
        而客户端也被要求不要给它设 60s 超时 (§4.2)。
        """
        if self.gripper is None:
            await self._send_direct(ws, client, {
                "t": "res", "id": mid, "ok": False,
                "err": {"kind": "GripperNotConnectedError",
                        "msg": "本进程没有夹爪会话 (非 Linux 平台或 --no-gripper)",
                        "method": method},
            })
            return
        timeout = (GRIPPER_ZERO_TIMEOUT_S if method == "gripper.zero"
                   else COMMAND_TIMEOUT_S)
        try:
            value = await asyncio.wait_for(
                asyncio.to_thread(self.gripper.execute, method, params),
                timeout=timeout)
        except asyncio.TimeoutError:
            obs.error(obs.COMMAND_TIMEOUT,
                      body=f"{method} 超过 {timeout:.0f}s 未返回",
                      fields={"method": method, "timeout_s": timeout,
                              "scope": "gripper"},
                      trace_id=trace_id)
            await self._send_direct(ws, client, {
                "t": "res", "id": mid, "ok": False,
                "err": {"kind": "CommandTimeoutError",
                        "msg": f"{method} 超过 {timeout:.0f}s 未返回",
                        "method": method},
            })
            return
        except Exception as e:  # noqa: BLE001 - 任何失败都回一条结构化 err
            await self._send_direct(ws, client, {
                "t": "res", "id": mid, "ok": False,
                "err": error_to_dict(e, method=method),
            })
            return
        await self._send_direct(ws, client, {
            "t": "res", "id": mid, "ok": True, "v": jsonable(value),
        })


def _reserved_path(path: str) -> bool:
    """`path` 是**相对挂载点**的路径 (即 `StaticFiles.get_path` 的产物), 见下。"""
    parts = path.split(os.sep)
    if parts[0] in ("api", "ws"):
        return True
    # 末段带扩展名 ⇒ 它是资源不是前端路由 (路由都是 `/control` 这种光杆)。
    return "." in parts[-1]


class _SpaStaticFiles(StaticFiles):
    """静态目录挂载 + SPA 兜底: 磁盘上不存在的前端路由回落到 `index.html`。

    前端用 `BrowserRouter` (history API), `/control` `/log` `/settings` 在磁盘上
    没有对应文件。`StaticFiles(html=True)` 只把**目录**请求补成 `index.html`, 所以
    只有 `/` 是好的, 其余路径直接 404 —— 在任一页面按 F5 会白屏成 FastAPI 的
    JSON 错误 (issue #30)。这里在 404 时改回 `index.html`, 交给前端路由。

    两类路径**不**兜底, 保持原本的 404:

    * `/api/*` 与 `/ws` —— 接口路径打错字不能变成 200 的 HTML, 否则调用方拿到一个
      "看起来成功"的响应, 比干脆断掉更难查。
    * 末段带扩展名的路径 (`.js` / `.css` / `.svg` / 字体 …) —— 那是资源。不排除的话,
      陈旧缓存里的 `index.html` 去要一个已被清掉的 `assets/index-<旧 hash>.js` 会拿到
      200 的 HTML, 浏览器只报一句含糊的 MIME 错; 留着 404 才能一眼看出是资源没了。
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code != 404 or _reserved_path(path):
                raise
            return await super().get_response("index.html", scope)


def create_app(session: Session, *, gripper: Optional[Any] = None,
               version: str = __version__,
               ui_dir: Optional[str] = None,
               repo_dist: Optional[Path] = None,
               allow_origins: Iterable[str] = ()) -> FastAPI:
    """建 FastAPI 应用 (不含绑定/启动 —— 那是 `run()` 的事)。

    `/api/health` 返回版本与连接状态; 给了静态目录就把它挂在 `/` 上
    (没有就跳过, 不报错)。`allow_origins` 是**额外**放行的跨源, 见 `origin_allowed`。
    """
    resolved = resolve_ui_dir(ui_dir, repo_dist=repo_dist)
    daemon = Daemon(session, gripper=gripper, version=version, ui_dir=resolved,
                    allow_origins=allow_origins)
    app = FastAPI(title="LiteArm Studio Daemon", version=version, docs_url=None,
                  redoc_url=None, openapi_url=None)
    # 让 `handle_ws` 拿得到事件循环 (会话事件要从别的线程投递进来)。
    app.state.daemon = daemon

    app.add_api_route("/api/health", lambda: JSONResponse(_health(daemon)),
                      methods=["GET"])

    # ── 日志历史回读 (issue #79 第 5 点 / #80) ──────────────────────────────
    #
    # ⚠ 这两条路由服务的才是**权威历史**: daemon 的 JSONL 文件。页面自己那份 IndexedDB
    # 缓存会随 origin 漂移 (issue #80), 而这里的路径由 `--log-dir` 决定, 与端口无关。
    # 倒读与游标在 `logread.py` 里。
    reader = logread.LogReader()

    @app.api_route("/api/logs", methods=["GET"])
    async def _logs(limit: int = logread.DEFAULT_LIMIT,
                    before: Optional[str] = None,
                    level: Optional[str] = None,
                    kind: Optional[str] = None,
                    event: Optional[str] = None,
                    q: Optional[str] = None) -> JSONResponse:
        result = await asyncio.to_thread(
            reader.history,
            limit=limit,
            before=logread.Cursor.parse(before),
            keep=logread.combine(
                logread.severity_filter(level),
                logread.kind_filter(kind),
                logread.event_filter(event),
                logread.query_filter(q),
            ),
        )
        return JSONResponse({
            "records": result["records"],
            "cursor": result["cursor"],
            "more": result["more"],
            "fileCount": result["fileCount"],
            "dir": str(reader.directory) if reader.directory is not None else None,
        })

    @app.api_route("/api/logs/events", methods=["GET"])
    async def _log_events() -> JSONResponse:
        """事件目录 + 实际出现过的条数 —— 页面拿它做标签与筛选, 不自己维护一份名单."""
        return JSONResponse(await asyncio.to_thread(reader.events))

    @app.websocket("/ws")
    async def _ws(ws: WebSocket) -> None:      # pragma: no cover - 由 TestClient 覆盖
        await daemon.handle_ws(ws)

    @app.on_event("startup")
    async def _remember_loop() -> None:        # pragma: no cover - 生命周期钩子
        daemon.loop = asyncio.get_running_loop()
        daemon.log_meta_task = asyncio.create_task(daemon._log_meta_loop())
        if daemon.gripper is not None:
            daemon.heartbeat_task = asyncio.create_task(daemon._gripper_heartbeat_loop())

    @app.on_event("shutdown")
    async def _stop_heartbeat() -> None:       # pragma: no cover - 生命周期钩子
        for name in ("heartbeat_task", "log_meta_task"):
            task = getattr(daemon, name)
            if task is not None:
                task.cancel()
                setattr(daemon, name, None)

    if resolved is not None:
        # ⚠ 挂在**最后**: 路由 (含 `/ws`) 优先于静态目录的兜底匹配。
        app.mount("/", _SpaStaticFiles(directory=str(resolved), html=True), name="ui")
        log.info("静态目录: %s", resolved)
    else:
        log.info("没有静态目录 (前端未构建?) —— 只提供 /api/health 与 /ws")
    return app


def _health(daemon: Daemon) -> dict:
    info = daemon.session.arm_info()
    out = {
        "ok": True,
        "daemon": daemon.version,
        "sdk": daemon.session.sdk_version,
        #: 本次会话是不是假传输。复用判据要用它 (`instance.is_same_instance`): 在一条
        #: `--fake` 的调试进程旁边启动真机版, 复用会让操作员对着假设备操作。
        "fake": daemon.session.fake,
        "connected": daemon.session.connected,
        "motionBusy": daemon.session.motion_in_flight(),
        "clients": len(daemon.clients),
        "ui": (str(daemon.ui_dir) if daemon.ui_dir is not None else None),
        # 连接细节 (与 `conn` 帧同源, 前端不必为"看端口"单开一条 WS)
        "conn": info,
    }
    # 夹爪与臂并列上报, 判据是"本进程有没有夹爪会话" —— 没有就如实说没有,
    # 而不是编一个 disconnected 出来 (那会让前端以为接上就能用)。
    if daemon.gripper is not None:
        out["gripper"] = daemon.gripper.conn_info()
    else:
        out["gripper"] = None
    return out


def _open_browser(url: str) -> None:
    """尝试以**浏览器应用模式**开一个无地址栏窗口 (`chrome/msedge --app=<url>`)。

    找不到 Chromium 系浏览器时退回 `webbrowser.open` (普通标签页) —— 功能不受影响
    (计划 7 节风险表的既定降级)。**不引新依赖**: 只查 PATH 上常见的几个可执行名,
    找不到就降级; 任何失败都被吞掉并记日志 (开不了窗口不该让守护进程起不来)。
    """
    import shutil
    import subprocess
    import webbrowser

    for exe in ("google-chrome", "google-chrome-stable", "chromium",
                "chromium-browser", "microsoft-edge", "microsoft-edge-stable",
                "msedge", "brave-browser"):
        path = shutil.which(exe)
        if not path:
            continue
        try:
            subprocess.Popen([path, f"--app={url}"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            log.info("以应用模式打开窗口: %s --app=%s", exe, url)
            return
        except Exception:  # noqa: BLE001 - 换下一个候选
            log.debug("应用模式打开失败: %s", exe, exc_info=True)
    try:
        webbrowser.open(url)
        log.info("未找到 Chromium 系浏览器 —— 已用默认浏览器打开 %s", url)
    except Exception:  # noqa: BLE001
        log.warning("无法自动打开浏览器, 请手动访问 %s", url)


async def serve(session: Session, *, gripper: Optional[Any] = None,
                host: str = "127.0.0.1", http_port: int = 8765,
                ui_dir: Optional[str] = None, open_browser: bool = True,
                version: str = __version__,
                allow_origins: Iterable[str] = ()) -> None:
    """起 uvicorn (前台阻塞到退出)。

    ⚠ **只监听 127.0.0.1** —— 这里强制判据, 越线直接报错退出。
    """
    import uvicorn

    if not _is_loopback(host):
        raise ValueError(
            f"拒绝监听 {host!r}: 本程序只允许绑定本机 (127.0.0.1) —— "
            f"它能把机械臂的使能/运动接口暴露给整个网络。")
    if int(http_port) == 0:
        # ⚠ 端口 0 会让 `pick_free_http_port` 返回 0, 而 uvicorn 把 0 解释成
        # "内核挑一个" —— 于是我们打印的 URL 是 `:0`, 窗口打不开。测试用 0 是为了
        # 拿一个真端口; 这种请求必须由内核来满足, 所以这里不代它挑。
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind((host, 0))
            http_port = int(probe.getsockname()[1])
        log.info("端口 0: 内核挑定 %d", http_port)
    port = pick_free_http_port(host, http_port)
    if port != http_port:
        print(f"[litearm-studio-daemon] 端口 {http_port} 被占用, 改用 {port}")
        # ⚠ 端口漂移是 issue #80 的**触发条件**: 它换掉页面 origin, 于是换掉 IndexedDB
        # 库。记录里留下这一条, 事后才解释得清"历史为什么看起来没了"。
        obs.warning(obs.DAEMON_STARTED,
                    body=f"端口 {http_port} 被占用, 改用 {port} (页面 origin 因此改变)",
                    fields={"requested_port": int(http_port), "port": int(port),
                            "origin_changed": True})
    app = create_app(session, gripper=gripper, version=version, ui_dir=ui_dir,
                     allow_origins=allow_origins)
    config = uvicorn.Config(app, host=host, port=port, log_level="info",
                            ws_ping_interval=20.0, ws_ping_timeout=20.0)
    server = uvicorn.Server(config)
    url = f"http://{host}:{port}/"
    print(f"[litearm-studio-daemon] 监听 {url}  (WebSocket: ws://{host}:{port}/ws)")
    # `resolve_ui_dir` 是纯函数 (只看磁盘), 所以再算一次比把路径从 `create_app`
    # 里传出来更省事, 也不会与它给出的答案不一致。
    ui_path = resolve_ui_dir(ui_dir)
    obs.info(obs.DAEMON_STARTED, body=f"守护进程开始监听 {url}",
             fields={"host": host, "port": int(port), "version": version,
                     "ui_dir": str(ui_path) if ui_path is not None else "",
                     "gripper": gripper is not None})
    if open_browser:
        # 等 uvicorn 真起来再开窗口; 用一个后台任务, 免得阻塞服务本身。
        async def _later() -> None:
            while not server.started:
                await asyncio.sleep(0.05)
            await asyncio.to_thread(_open_browser, url)

        asyncio.create_task(_later())
    try:
        await server.serve()
    finally:
        # 客户端全断之后才走到这里 (Ctrl-C / 窗口关闭触发的退出) ⇒ 会话在这时收尾。
        # ⚠ 夹爪**总是**失能退出: `--keep-enabled` 只对臂有效 (§5.1 第 5 条) ——
        # 一个还夹着东西的夹爪不该因为"保存使能"而留在原地。
        if gripper is not None:
            try:
                gripper.close()
            except Exception:  # noqa: BLE001 - 收尾失败不该盖住真正的退出原因
                log.warning("关闭夹爪会话时出错 (已忽略)", exc_info=True)
        session.close()
