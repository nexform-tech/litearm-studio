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
"""
from __future__ import annotations

import asyncio
import json
import logging
import socket
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .errors import error_to_dict
from .statemap import jsonable
from .session import Session

log = logging.getLogger("litearm_studio_daemon.server")

#: `run()` 允许绑定的地址白名单 —— 只监听本机 (计划 2 节架构: "Studio 本地程序,
#: 仅监听 127.0.0.1")。想开给局域网没有开关, 只能改代码 (刻意的)。
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

#: 单条命令的等待上限 (秒) —— 兜底, 防止某条 SDK 调用在**命令执行器**上永久卡住
#: (那样后续所有命令都会陪等)。取 60s: `home`/`movej` 在真机上最坏十几秒
#: (`move_timeout` 默认 15s), `enable` 的重试上界约 3.3s。
COMMAND_TIMEOUT_S = 60.0


@dataclass
class _Client:
    """一个 WS 客户端 —— 自己的发送队列 + 自己的发送锁。

    ⚠ 队列是**必须**的: 状态广播可能来自会话的轮询线程, 而 `WebSocket.send_json`
    是 async 的。队列让广播变成 `put_nowait` (线程安全、非阻塞), 真正的 `await send`
    只发生在该客户端自己的 `_pump` 任务里 —— 慢客户端丢帧而不是拖住广播。
    """
    q: asyncio.Queue
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _is_loopback(host: str) -> bool:
    return host in LOOPBACK_HOSTS


def pick_free_http_port(host: str = "127.0.0.1", start: int = 8765,
                        tries: int = 50) -> int:
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
    """静态目录: 显式 `--ui-dir` 优先, 否则退回仓库 `dist/`。**不存在就返回 None**。

    计划要求「默认找仓库的 `dist/`, 不存在就跳过, 不要报错」—— 于是这里**不抛异常**,
    也**不创建**目录 (前端还没构建时, 守护进程照样要能起来, `/api/health` 照样能用)。
    """
    if ui_dir:
        p = Path(ui_dir).expanduser()
        return p if p.is_dir() else None
    base = repo_dist if repo_dist is not None else Path(__file__).resolve().parents[3] / "dist"
    return base if base.is_dir() else None


class Daemon:
    """会话 + 客户端集合 —— 一个进程一个实例 (`create_app` 把它封进 FastAPI)。

    单独成类是为了让 HTTP/WS 之外的东西 (广播、批量发送) 能被单测直接调, 不必起服务。
    """

    def __init__(self, session: Session, *, version: str = __version__,
                 ui_dir: Optional[Path] = None) -> None:
        self.session = session
        self.version = version
        self.ui_dir = ui_dir
        self.clients: List[_Client] = []
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        # 会话事件 (可能来自轮询线程/执行器线程) → 事件循环的桥
        session.add_listener(self._on_session_event)

    # ------------------------------------------------------------ 会话事件 → WS
    def _on_session_event(self, event: dict) -> None:
        """会话监听器 —— **可能在任何线程上被调用**, 故只做线程安全的投递。"""
        self.broadcast_threadsafe(event)

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

    # ------------------------------------------------------------ WS 单客户端
    async def handle_ws(self, ws: WebSocket) -> None:
        await ws.accept()
        client = _Client(q=asyncio.Queue(maxsize=256))
        self.clients.append(client)
        pump = asyncio.create_task(self._pump(ws, client))
        try:
            # 连接时先 `hello`, 随后立刻 `conn` (计划 3.1 的握手顺序)。
            await self._send_direct(ws, client, {
                "t": "hello", "daemon": self.version, "sdk": self.session.sdk_version,
            })
            await self._send_direct(ws, client, {"t": "conn", **self.session.arm_info()})
            if self.session.connected:
                # 已连接时补一条当前状态 —— 新开的窗口不该等到下一拍才画出 3D。
                st = self.session.state()
                if st is not None:
                    await self._send_direct(ws, client, {
                        "t": "state", "stamp": 0.0, "state": st,
                    })
            while True:
                raw = await ws.receive_text()
                await self._on_upstream(ws, client, raw)
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001 - 一个客户端坏了不该影响别人
            log.debug("WS 客户端异常结束", exc_info=True)
        finally:
            # ⚠ **只**摘掉这个客户端自己 —— 不碰会话 (计划 2 节原则 4)。
            try:
                self.clients.remove(client)
            except ValueError:
                pass
            pump.cancel()

    async def _send_direct(self, ws: WebSocket, client: _Client, message: dict) -> None:
        async with client.lock:
            await ws.send_text(json.dumps(message, ensure_ascii=False,
                                          allow_nan=False, default=str))

    async def _pump(self, ws: WebSocket, client: _Client) -> None:
        while True:
            message = await client.q.get()
            async with client.lock:
                await ws.send_text(json.dumps(message, ensure_ascii=False,
                                              allow_nan=False, default=str))

    async def _on_upstream(self, ws: WebSocket, client: _Client, raw: str) -> None:
        """上行帧分发 —— 格式不对就回一条 `res` 错误, 不静默吞。"""
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            await self._send_direct(ws, client, {
                "t": "res", "id": None, "ok": False,
                "err": {"kind": "BadMessage", "msg": "不是合法 JSON"},
            })
            return
        if not isinstance(msg, dict):
            await self._send_direct(ws, client, {
                "t": "res", "id": None, "ok": False,
                "err": {"kind": "BadMessage", "msg": "顶层需是 JSON 对象"},
            })
            return
        kind = msg.get("t")
        if kind == "connect":
            # 幂等, 且**立刻**回: 握手在命令执行器上跑, 进度由 `conn` 帧报。
            started = self.session.connect()
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
            await self._send_direct(ws, client, {
                "t": "res", "id": msg.get("id"), "ok": False,
                "err": {"kind": "BadMessage", "msg": f"未知消息类型 {kind!r}"},
            })
            return
        await self._run_command(ws, client, msg)

    async def _run_command(self, ws: WebSocket, client: _Client, msg: dict) -> None:
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

        # `Session.execute` 是**阻塞**的 (它在单线程执行器上等 SDK 调用), 所以这里
        # 必须丢到线程里, 否则整个事件循环 (含状态推送/急停) 会被一条 movej 憋住。
        # `Session.execute` 内部先做准入判定 (白名单/运动互斥/连接态), 那几步在提交
        # 之前完成 —— 于是"在途时第二条运动命令"是**立刻**被拒, 不是排队后被拒。
        try:
            value = await asyncio.wait_for(
                asyncio.to_thread(self.session.execute, method, params,
                                  on_event=self.broadcast_threadsafe),
                timeout=COMMAND_TIMEOUT_S)
        except asyncio.TimeoutError:
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


def create_app(session: Session, *, version: str = __version__,
               ui_dir: Optional[str] = None,
               repo_dist: Optional[Path] = None) -> FastAPI:
    """建 FastAPI 应用 (不含绑定/启动 —— 那是 `run()` 的事)。

    `/api/health` 返回版本与连接状态; 给了静态目录就把它挂在 `/` 上
    (没有就跳过, 不报错)。
    """
    resolved = resolve_ui_dir(ui_dir, repo_dist=repo_dist)
    daemon = Daemon(session, version=version, ui_dir=resolved)
    app = FastAPI(title="LiteArm Studio Daemon", version=version, docs_url=None,
                  redoc_url=None, openapi_url=None)
    # 让 `handle_ws` 拿得到事件循环 (会话事件要从别的线程投递进来)。
    app.state.daemon = daemon

    app.add_api_route("/api/health", lambda: JSONResponse(_health(daemon)),
                      methods=["GET"])

    @app.websocket("/ws")
    async def _ws(ws: WebSocket) -> None:      # pragma: no cover - 由 TestClient 覆盖
        await daemon.handle_ws(ws)

    @app.on_event("startup")
    async def _remember_loop() -> None:        # pragma: no cover - 生命周期钩子
        daemon.loop = asyncio.get_running_loop()

    if resolved is not None:
        # ⚠ 挂在**最后**: 路由 (含 `/ws`) 优先于静态目录的兜底匹配。
        app.mount("/", StaticFiles(directory=str(resolved), html=True), name="ui")
        log.info("静态目录: %s", resolved)
    else:
        log.info("没有静态目录 (前端未构建?) —— 只提供 /api/health 与 /ws")
    return app


def _health(daemon: Daemon) -> dict:
    info = daemon.session.arm_info()
    return {
        "ok": True,
        "daemon": daemon.version,
        "sdk": daemon.session.sdk_version,
        "connected": daemon.session.connected,
        "motionBusy": daemon.session.motion_in_flight(),
        "clients": len(daemon.clients),
        "ui": (str(daemon.ui_dir) if daemon.ui_dir is not None else None),
        # 连接细节 (与 `conn` 帧同源, 前端不必为"看端口"单开一条 WS)
        "conn": info,
    }


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


async def serve(session: Session, *, host: str = "127.0.0.1", http_port: int = 8765,
                ui_dir: Optional[str] = None, open_browser: bool = True,
                version: str = __version__) -> None:
    """起 uvicorn (前台阻塞到退出)。

    ⚠ **只监听 127.0.0.1** —— 这里强制判据, 越线直接报错退出。
    """
    import uvicorn

    if not _is_loopback(host):
        raise ValueError(
            f"拒绝监听 {host!r}: 本程序只允许绑定本机 (127.0.0.1) —— "
            f"它能把机械臂的使能/运动接口暴露给整个网络。")
    port = pick_free_http_port(host, http_port)
    if port != http_port:
        print(f"[litearm-studio-daemon] 端口 {http_port} 被占用, 改用 {port}")
    app = create_app(session, version=version, ui_dir=ui_dir)
    config = uvicorn.Config(app, host=host, port=port, log_level="info",
                            ws_ping_interval=20.0, ws_ping_timeout=20.0)
    server = uvicorn.Server(config)
    url = f"http://{host}:{port}/"
    print(f"[litearm-studio-daemon] 监听 {url}  (WebSocket: ws://{host}:{port}/ws)")
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
        session.close()
