"""会话与命令执行 —— 计划 2 节那四条设计原则的落点。

职责边界 (与 `server.py` 的分工):

* 本模块**只**管会话: `Arm` 的持有、连接/断开、状态轮询、命令白名单与串行执行、
  运动互斥。它不认得 HTTP/WebSocket/JSON —— 唯一的对外通道是
  `arm_info()` / `state()` / `execute()` 三个方法与一个**监听器**回调
  (把 `conn` / `state` / 错误事件推给上层)。
* `server.py` 只做传输: 把监听器事件变成 WS 帧, 把 WS 上行变成 `execute()` 调用。

四条原则各自的落点:

1. **唯一上游** —— 只有本模块 import `litearm`; 前端永不碰串口。
2. **状态与命令分离** —— `_poll_loop` 以 50Hz 读 `arm.get_state().value` (SDK 的
   **缓存帧**, 不发串口帧), 与 `_executor` 上跑的慢命令 (movej 可能十几秒) 互不阻塞。
3. **命令串行** —— 所有 SDK 调用都在 `ThreadPoolExecutor(max_workers=1)` 上跑;
   运动互斥 (`motion_in_flight`) 在**提交之前**判定, 在途时新运动命令**立刻被拒**
   (不排队)。
4. **安全在本地程序里** —— 客户端断开**不**杀会话; `estop`/`disable` 这种降能量动作
   只需会话存在, 不依赖浏览器是否活着。
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional

import litearm
from litearm import Arm

from . import statemap
from .errors import MotionBusyError, NotConnectedCommandError, UnknownCommandError

log = logging.getLogger("litearm_studio_daemon.session")

#: 状态轮询周期 (秒) —— 20ms = 50Hz。**必须自己节流**: SDK 那条路径读的是缓存帧,
#: 不节流的话轮询线程会以 GIL 允许的最高速率空转 (实测能把整套用例拖慢一个量级)。
#: ⚠ 循环体里的 sleep 只保证"周期**不小于**本值" (工作耗时叠加在上面), 这与
#: "不要依赖帧到达速率"是同一个口径 —— 我们是主动方, 不跟固件的 100Hz 对齐。
POLL_PERIOD_S = 0.02

#: 状态推送节流 (秒) —— 100ms = 10Hz。计划 2 节只说"状态变化时推 state";
#: 50Hz 全灌进 WS 会把浏览器和 WS 缓冲一起打满, 而 3D 面板 10Hz 已经够顺。
#: ⚠ **状态串变化 / 故障变化一律立即推** (见 `_poll_loop`), 节流只管"同样内容重复推"。
STATE_PUSH_INTERVAL_S = 0.1

#: 运动类命令 —— 这三条在途时, 新的运动命令立刻被拒 (计划 2 节原则 3)。
#: ⚠ `estop`/`disable`/`zero_g_stop` **不在此列**: 降能量方向的动作永远可达,
#: 这正是原则 4 要的 (急停不能因为"运动互斥"而被挡住)。
MOTION_COMMANDS = frozenset({"home", "movej", "movel"})

#: 命令白名单 —— (方法名 → 中文说明)。**唯一**的准入判据: 表里没有的一律
#: `UnknownCommandError`, 不接受任意方法调用 (计划 3.2)。
COMMANDS: Dict[str, str] = {
    "enable": "使能全关节 (arm.enable)",
    "disable": "失能 (arm.disable)",
    "estop": "急停, 降能量方向永远可达 (arm.emergency_stop)",
    "clear_faults": "清故障 (arm.clear_faults)",
    "reset": "复位 (arm.reset)",
    "home": "固件低速度回零 (arm.home)",
    "movej": "关节运动 (arm.movej)",
    "movel": "笛卡尔直线 (arm.move_l)",
    "set_speed": "全局调速 0-100 (arm.set_speed)",
    "get_tcp": "当前末端位姿 (arm.get_tcp)",
    "ik": "逆解 (arm.ik)",
    "zero_g_start": "进入拖动示教 (arm.zero_g_start)",
    "zero_g_stop": "退出拖动示教 (arm.zero_g_stop)",
    # ---- 关节级参数 (控制页的滑条量程 / 设置页的增益与限位都要用) ----
    "get_joint_params": "读回全部关节参数: kp/kd/tau_max/软限位 (逐轴 N 次往返)",
    "set_joint_param": "改写单关节 MIT 刚度/阻尼/力矩钳幅 (RAM, 须 save_params 才持久化)",
    "set_joint_limits": "改写单关节软限位 (RAM, 须 save_params 才持久化)",
    "save_params": "把当前参数持久化到 flash (固件要求失能态)",
}


def find_cdc_port() -> Optional[str]:
    """SDK 的 CDC 自动发现 (`find_cdc_port`), 找不到时返回 `None`。

    单独包一层是为了让**测试**能替换它 (会话构造时 port 为空 ⇒ 走这里),
    而不必去 monkeypatch SDK 自己的模块名。
    """
    return litearm.find_cdc_port()


def build_fake_transport_factory():
    """`--fake` 模式的注入工厂 —— 延迟 import, 免得生产运行也拖着 `litearm.testing`。

    签名契约 (`litearm-python/tests/conftest.py` 的 `fake_transport_factory` 与
    `Arm.connect()` 里的调用点 `(self._transport_factory or SerialTransport)(p)`):
    工厂只接收**一个位置参数** = 端口字符串。

    ⚠ 固件版本字面量取 `Litearm1.8.0-7J` + `n=7`: `connect()` 会校验版本约定
    (`Litearm<主.次.修>-{7J|1J}`) 且 `1.8.0 >= MIN_FW (1.5.0)`; `n=7` 让桩固件
    在装配时就把关节数定成 7 (整臂), 于是 `movej` 的 arity 校验一次到位。
    """
    from litearm.testing import FakeTransport

    def factory(port: str) -> Any:
        return FakeTransport(port=port, timeout=0.2, fw="Litearm1.8.0-7J", n=7)

    return factory


class Session:
    """单臂会话 —— 线程安全 (状态用一把 `RLock` 圈住)。"""

    def __init__(self, *, port: Optional[str] = None, fake: bool = False,
                 port_finder: Optional[Callable[[], Optional[str]]] = None,
                 poll_period: float = POLL_PERIOD_S,
                 state_push_interval: float = STATE_PUSH_INTERVAL_S,
                 sdk_version: str = litearm.__version__) -> None:
        #: 构造时给的端口 —— 空 = 连接时用 `port_finder` (= SDK `find_cdc_port`) 自动发现。
        #: ⚠ `--port` 只是**覆盖**自动发现 (计划 2 节「设备发现」), 所以这里允许 None。
        self._port = port or None
        self._fake = bool(fake)
        self._port_finder = port_finder or find_cdc_port
        self._poll_period = float(poll_period)
        self._state_push_interval = float(state_push_interval)
        self.sdk_version = sdk_version

        self._lock = threading.RLock()
        self._arm: Optional[Arm] = None
        #: 实际连上的端口 —— **不是** `Arm.port`: SDK 的 `Arm` **没有**公开 `port`
        #: (端口在传输层对象上)。所以本会话自己记下这次连的是哪个口, 供 `conn` 帧
        #: 与 `/api/health` 显示。⚠ 上一版直接读 `arm.port`, 那会在**连接收尾**抛
        #: AttributeError, 而收尾跑在没人读取的 Future 上 ⇒ 静默失败。
        self._resolved_port: Optional[str] = None
        self._status = "disconnected"          # disconnected|connecting|connected|error
        self._last_error: Optional[str] = None
        self._state: Any = None                # 最近一帧 RobotState
        self._state_dict: Optional[dict] = None
        self._state_stamp = 0.0
        self._last_emit_key: Any = None
        self._last_emit_at = 0.0
        self._zero_g_since: Optional[float] = None
        #: 运动在飞计数 (不是 bool: 同一瞬间可能既有在途、又有刚提交的)
        self._motion_count = 0

        self._listeners: List[Callable[[dict], None]] = []
        #: **所有** SDK 调用都在这条单线程上跑 ⇒ 天然串行 (计划 2 节原则 3)。
        #: `thread_name_prefix` 便于排障时一眼看出是谁。
        self._executor = ThreadPoolExecutor(max_workers=1,
                                            thread_name_prefix="litearm-cmd")
        self._stop = threading.Event()
        self._poll_thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------ 监听器
    def add_listener(self, cb: Callable[[dict], None]) -> None:
        """注册事件监听 (`hello` 之外的 `conn` / `state` 事件都走这里)。

        监听器在**推送线程**上被调用 ⇒ 必须是快返回的 (server.py 那边只是
        `queue.put_nowait`)。任何监听器抛出的异常都被吞掉并记日志 —— 一个断掉的
        客户端不许把状态轮询线程带走。
        """
        with self._lock:
            self._listeners.append(cb)

    def remove_listener(self, cb: Callable[[dict], None]) -> None:
        with self._lock:
            try:
                self._listeners.remove(cb)
            except ValueError:
                pass

    def _broadcast(self, event: dict) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for cb in listeners:
            try:
                cb(event)
            except Exception:  # noqa: BLE001 - 监听器故障不许影响会话
                log.warning("状态监听器抛出异常 (已忽略)", exc_info=True)

    # ------------------------------------------------------------------ 对外查询
    @property
    def fake(self) -> bool:
        return self._fake

    @property
    def connected(self) -> bool:
        with self._lock:
            return self._arm is not None and self._status == "connected"

    def motion_in_flight(self) -> bool:
        """「运动在飞」这个布尔量 —— 计划 2 节原则 3 要求对外暴露。"""
        with self._lock:
            return self._motion_count > 0

    def arm_info(self) -> dict:
        """`conn` 帧 / `/api/health` 的公共部分 (计划 3.1)。"""
        with self._lock:
            arm = self._arm
            return {
                "status": self._status,
                # ⚠ 取自**本会话记下的实际端口**: SDK 的 `Arm` 没有公开 `port`
                # (端口在传输层), 上一版这里的 `getattr(arm, "port", None)` 恒为
                # None ⇒ 自动发现时前端永远看不到端口名。
                "port": self._resolved_port,
                "firmware": getattr(arm, "firmware", "") or "",
                "n": int(getattr(arm, "n", 0) or 0),
                "cart": bool(getattr(arm, "_cart_supported", False)),
                "error": self._last_error,
            }

    def state(self) -> Optional[dict]:
        """最近一帧归一化状态 (`state` 帧的 `state` 字段); 还没有帧时 `None`。"""
        with self._lock:
            return None if self._state_dict is None else dict(self._state_dict)

    # ------------------------------------------------------------------ 连接/断开
    def connect(self) -> bool:
        """连接 (幂等) —— 已连接时**是 no-op**, 返回 `True`。

        真在跑时: 状态先落 `connecting` 并推一条 `conn`, 再在命令执行器上建会话
        (握手可能几秒), 成功后定关节数、起状态轮询线程、推 `connected`。

        失败**不抛栈**: 会话落到 `error` 并推一条带 `error` 文案的 `conn`, 返回 `False`
        (前端要看到的是"为什么没连上", 不是进程崩)。
        """
        with self._lock:
            if self._arm is not None and self._status == "connected":
                return True
            if self._status == "connecting":
                return False
            self._status = "connecting"
            self._last_error = None
        self._broadcast({"t": "conn", **self.arm_info()})

        def _open() -> None:
            try:
                target = self._port
                factory = None
                if self._fake:
                    # ⚠ 注入工厂时**必须**同时给占位端口: SDK 的 `find_cdc_port()`
                    # 空值检查排在注入点**之前** (见 `Arm.__init__` 的说明), 没有端口会
                    # 在走到工厂之前就抛 TransportError。
                    target = target or "fake"
                    factory = build_fake_transport_factory()
                elif not target:
                    # 真机 + 没给 --port ⇒ 交给 SDK 自己发现。**在连接时**才发现:
                    # 启动时发现会让"插上臂再点连接"这种用法失效。
                    target = self._port_finder()
                    if not target:
                        raise litearm.TransportError(
                            "未发现 STM32 CDC 设备 (VID:PID 1d50:606f); 请插好设备或用 --port 指定")
                arm = Arm(port=target, transport_factory=factory).connect()
            except Exception as e:  # noqa: BLE001 - 连接失败是**预期结局**之一
                self._connect_failed(e, None)
                return
            with self._lock:
                self._arm = arm
                self._status = "connected"
                self._last_error = None
                self._resolved_port = target
            # ⚠ 收尾这一段也**必须**在自己的 try 里: 它跑在**没人读取的 Future** 上,
            # 抛出去就是静默失败。实测过一次 AttributeError (`arm.port`, SDK 的 `Arm`
            # 没有这个属性): 前端看到 `connected`, 却永远收不到状态帧, 日志里一个错
            # 都没有 —— 排障时这是最坏的一种失败。故这里一律转成 error 态报出来。
            try:
                log.info("已连接: port=%s firmware=%s n=%d cart=%s",
                         target, arm.firmware, arm.n,
                         getattr(arm, "_cart_supported", None))
                self._broadcast({"t": "conn", **self.arm_info()})
                self._start_polling()
            except Exception as e:  # noqa: BLE001
                log.exception("连接收尾失败 (已转为 error 态)")
                self._connect_failed(e, arm)

        self._executor.submit(_open)
        return True

    def disconnect(self) -> bool:
        """断开 (幂等) —— 未连接时是 no-op 并返回 `False`。

        收尾顺序: 停状态轮询 → 停 SDK 会话。`close()` 自己幂等, 且它内部会先收
        零重力保活线程再关链路 (SDK `Arm.close()` 的既定顺序, 不重复一遍)。
        """
        with self._lock:
            if self._arm is None:
                self._status = "disconnected"
                self._last_error = None
                self._resolved_port = None
                return False
        self._stop_polling()
        arm = self._take_arm()
        if arm is not None:
            self._executor.submit(self._close_arm, arm)
        with self._lock:
            self._state = None
            self._state_dict = None
            self._state_stamp = 0.0
            self._last_emit_key = None
            self._zero_g_since = None
            self._motion_count = 0
            self._status = "disconnected"
            self._last_error = None
            self._resolved_port = None
        self._broadcast({"t": "conn", **self.arm_info()})
        return True

    def _take_arm(self) -> Optional[Arm]:
        with self._lock:
            arm, self._arm = self._arm, None
            return arm

    @staticmethod
    def _close_arm(arm: Arm) -> None:
        try:
            arm.close()
        except Exception:  # noqa: BLE001 - 收尾失败不该炸掉进程
            log.warning("关闭会话时抛出异常 (已忽略)", exc_info=True)

    def _connect_failed(self, exc: BaseException, arm: Optional[Arm]) -> None:
        """连接（或连接收尾）失败 —— 落 `error` 态并推一条带原因的 `conn`。

        ⚠ **必须把异常转成状态, 不许让它逃出去**: 本方法跑在命令执行器的那条 Future
        上, 而那条 Future 没人读取 —— 逃出去就是静默失败 (前端停在 connecting, 日志
        一片安静)。
        """
        if arm is not None:
            self._close_arm(arm)
        with self._lock:
            self._arm = None
            self._status = "error"
            self._last_error = f"{type(exc).__name__}: {exc}"
            self._resolved_port = None
        log.warning("连接失败: %s", self._last_error)
        self._broadcast({"t": "conn", **self.arm_info()})

    def close(self) -> None:
        """整个守护进程收尾 (幂等) —— 停轮询、停执行器、关会话。

        ⚠ `estop`/`disable` 是否要在退出前调, 由**调用方**决定: 本方法不做任何
        降能量以外的推断 (那会把"关窗口"变成"随时可能失能"的惊悚行为)。
        """
        self._stop.set()
        self._stop_polling()
        self._executor.shutdown(wait=True)
        arm = self._take_arm()
        if arm is not None:
            self._close_arm(arm)
            with self._lock:
                self._status = "disconnected"

    # ------------------------------------------------------------------ 状态轮询
    def _start_polling(self) -> None:
        self._stop_polling()
        self._stop.clear()
        th = threading.Thread(target=self._poll_loop, name="litearm-state-poll",
                              daemon=True)
        with self._lock:
            self._poll_thread = th
        th.start()

    def _stop_polling(self) -> None:
        with self._lock:
            th, self._poll_thread = self._poll_thread, None
        if th is not None and th.is_alive() and th is not threading.current_thread():
            th.join(timeout=1.0)

    def _poll_loop(self) -> None:
        """50Hz 状态轮询 —— **只读 SDK 缓存帧, 不发串口帧**。

        三条纪律:

        * **自己节流**: 每条循环末尾按 `_poll_period` 补睡到周期, 不依赖帧到达速率;
        * **拿不到状态不抛栈、不刷日志**: `get_state()` 取不到帧时返回 `Msg(value=None)`,
          链路断了会抛 `TransportError` —— 两种都只是"这一拍没有状态", 静默跳过。
          真要报的故障由固件 flags 表达 (随状态帧上来), 不在这里重复刷屏;
        * **节流推送**: 状态**内容**变了 (或故障面变了) 立即推; 否则按
          `_state_push_interval` 限频 (50Hz 全灌 WS 没有意义)。
        """
        while not self._stop.is_set():
            t0 = time.monotonic()
            event = None
            try:
                event = self._poll_once(t0)
            except Exception:  # noqa: BLE001 - 轮询线程绝不能死
                log.debug("状态轮询这一拍失败 (已跳过)", exc_info=True)
            if event is not None:
                self._broadcast(event)
            rest = self._poll_period - (time.monotonic() - t0)
            if rest > 0:
                # 用 Event.wait 而不是 sleep: 关闭时能被立刻唤醒, 不必等满一拍。
                self._stop.wait(rest)

    def _poll_once(self, now: float) -> Optional[dict]:
        arm = self._arm
        if arm is None:
            return None
        try:
            state = arm.get_state().value
        except Exception:  # noqa: BLE001 - 见 `_poll_loop` 的三条纪律
            return None
        if state is None:
            return None
        with self._lock:
            self._state = state
            self._state_stamp = now
            self._state_dict = statemap.state_to_dict(
                state,
                enabled=bool(getattr(state, "enabled", False)),
                zero_g_active=self._zero_g_active_locked(),
                motion_in_flight=self._motion_count > 0,
            )
            doc = dict(self._state_dict)
            # 推送判据: "内容变了" = 派生状态串 / 故障面 / 逐轴误差 任一变化。
            # 只看 state 串会漏掉"同一模式下温度/误差在变"这类该让面板刷新的事。
            key = (doc["state"], doc["faulted"], doc["cartBusy"], tuple(doc["errs"]))
            changed = key != self._last_emit_key
            due = (now - self._last_emit_at) >= self._state_push_interval
            if not (changed or due):
                return None
            self._last_emit_key = key
            self._last_emit_at = now
        return {"t": "state", "stamp": round(now, 4), "state": doc}

    def _zero_g_active_locked(self) -> bool:
        """**调用方须持 `self._lock`** —— 零重力会话是否激活。

        两条判据取或:

        * 会话记录 (`zero_g_start` 收到过、`zero_g_stop` 之后才清) 且**仍在保活窗口内**
          —— 窗口宽于 SDK 的保活周期 (默认 40ms) 一个量级, 免得 50Hz 轮询与 25Hz 保活
          正好错开时闪成 "非零重力";
        * `Arm._zg_thread` 还活着 (SDK 侧的权威证据)。读的是 SDK 的**私有**属性 ——
          公开面上没有"零重力是否激活"这个查询 (`zero_g_active` 是方法不是属性),
          ⚠ 这是一处已知的私有依赖, 由 `tests/test_session_fake.py` 钉住; SDK 若改了
          这里, 那条用例会红而不是静默失效。
        """
        window = max(0.5, self._poll_period * 25)
        if self._zero_g_since is not None and (time.monotonic() - self._zero_g_since) < window:
            return True
        arm = self._arm
        th = getattr(arm, "_zg_thread", None) if arm is not None else None
        return bool(th is not None and th.is_alive())

    # ------------------------------------------------------------------ 命令执行
    def execute(self, m: str, p: Optional[dict] = None, *,
                on_event: Optional[Callable[[dict], None]] = None) -> Any:
        """执行一条白名单命令 —— **阻塞**直到 SDK 调用返回 (调用方负责丢线程/线程池)。

        准入判据按顺序 (前三条**在提交之前**判定, 所以是"立刻被拒"而不是"排队再拒"):

        1. 会话已连接 (`NotConnectedCommandError`);
        2. `m` 在白名单里 (`UnknownCommandError`);
        3. 运动互斥 (`MotionBusyError`) —— 在途时新的运动命令立刻被拒, **不排队**。

        通过之后提交到单线程执行器, 由它保证与其它 SDK 调用严格串行。
        返回值是 SDK 原生返回值 (已按需取 `.value` / 转 dict), 由 server 层压成 JSON。
        """
        params = dict(p or {})
        with self._lock:
            arm = self._arm
            if arm is None or self._status != "connected":
                raise NotConnectedCommandError("会话未连接 —— 请先连接设备")
            if m not in COMMANDS:
                raise UnknownCommandError(m, sorted(COMMANDS))
            if m in MOTION_COMMANDS and self._motion_count > 0:
                raise MotionBusyError(m)
            if m in MOTION_COMMANDS:
                # 运动命令一起步就占坑: 提交是同步的, 所以"在途"从这一刻起成立,
                # 于是同一瞬间来的第二条运动命令必然看到 (而不会两条都过审)。
                self._motion_count += 1

        try:
            return self._executor.submit(self._run_command, arm, m, params,
                                         on_event).result()
        finally:
            if m in MOTION_COMMANDS:
                with self._lock:
                    self._motion_count = max(0, self._motion_count - 1)

    def _run_command(self, arm: Arm, m: str, p: dict,
                     on_event: Optional[Callable[[dict], None]]) -> Any:
        """在命令执行器线程上跑一条 SDK 调用 (串行域内)。"""
        try:
            if m == "enable":
                arm.enable()
                return None
            if m == "disable":
                arm.disable()
                return None
            if m == "estop":
                arm.emergency_stop()
                return None
            if m == "clear_faults":
                arm.clear_faults()
                return None
            if m == "reset":
                arm.reset()
                return None
            if m == "home":
                return _state_result(arm.home())
            if m == "movej":
                return _state_result(arm.movej(_q(p), _speed(p)))
            if m == "movel":
                # 位姿统一用 SDK 原生的 6 元组 `[x, y, z, rx, ry, rz]` (计划 3.4)。
                return statemap.jsonable(arm.move_l(_pose(p), _speed(p)))
            if m == "set_speed":
                arm.set_speed(_percent(p))
                return int(p["percent"])
            if m == "get_tcp":
                # ⚠ 2.0 起读一帧的 getter 返回 `Msg` 信封, 读值要 `.value`
                # (这里**不进** `_state_result`: 位姿就是位姿, 与状态帧无关)。
                return statemap.jsonable(arm.get_tcp().value)
            if m == "ik":
                # 逆解恒为**模型 7 轴** (固件 KIN_N=7), 与关节数解耦 ⇒ 原样回。
                return statemap.jsonable(arm.ik(_pose(p)))
            if m == "zero_g_start":
                arm.zero_g_start()
                self._note_zero_g(True, on_event)
                return None
            if m == "zero_g_stop":
                arm.zero_g_stop()
                self._note_zero_g(False, on_event)
                return None
            if m == "get_joint_params":
                # ⚠ SDK 的 `all_joint_params()` 是 **N 次往返的聚合** (每轴一发一收),
                # 在本执行器线程上串行, 不会与别的 SDK 调用交错。
                return [_joint_param_dict(jp) for jp in arm.params.all_joint_params()]
            if m == "set_joint_param":
                arm.params.set_joint_param(_idx(p), _num(p, "kp"), _num(p, "kd"),
                                           _num(p, "tau_max"))
                return None
            if m == "set_joint_limits":
                arm.params.set_joint_limits(_idx(p), _num(p, "q_min"), _num(p, "q_max"))
                return None
            if m == "save_params":
                # 固件要求失能态才允许擦写 flash; 这里**不代劳** `disable()` —— 替调用方
                # 决定"什么时候可以下电"是安全决策, 该由界面/操作员来做。
                arm.save_params()
                return None
            # 白名单与实现**各写一遍**是刻意的: 只在准入处查表的话, 表里加一条而忘了
            # 实现会静默返回 None (前端看到"成功"却什么都没发生)。
            raise UnknownCommandError(m, sorted(COMMANDS))
        except Exception as e:  # noqa: BLE001 - 命令失败是预期结果, 由 server 转成 err
            log.info("命令 %s 失败: %s: %s", m, type(e).__name__, e)
            raise

    def _note_zero_g(self, active: bool, on_event: Optional[Callable[[dict], None]]) -> None:
        """落零重力会话记录, 并让状态立刻反映它 (不必等下一帧状态)。

        `on_event` 是执行器线程 → 事件循环的旁路 (server 层用它把"命令引起的状态变化"
        立刻推给客户端)。
        """
        with self._lock:
            self._zero_g_since = time.monotonic() if active else None
            doc = None if self._state is None else statemap.state_to_dict(
                self._state,
                enabled=bool(getattr(self._state, "enabled", False)),
                zero_g_active=active,
                motion_in_flight=self._motion_count > 0)
            if doc is not None:
                self._state_dict = doc
                self._last_emit_key = None          # 强制下一拍推一条
        if on_event is not None and doc is not None:
            try:
                on_event({"t": "state", "stamp": round(time.monotonic(), 4),
                          "state": doc})
            except Exception:  # noqa: BLE001
                log.debug("零重力状态事件推送失败", exc_info=True)


# ---------------------------------------------------------------------- 参数校验
# 三条"立刻拒"的本地预检 (长度/类型/范围) 与 SDK 侧重复 —— 这是**故意的**: SDK 那层
# 的报错要等命令真被执行器取起来才发生 (慢), 而长度不对这类错根本没有下发价值。
# 但值域判据以 SDK 为准 (这里只做 O(1) 能判的), 避免两处漂移出两套语义。


def _q(p: dict) -> List[float]:
    q = p.get("q")
    if not isinstance(q, (list, tuple)) or not q:
        raise ValueError("movej 需要 q: [关节角…]")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in q):
        raise ValueError("movej 的 q 必须是数值数组")
    return [float(v) for v in q]


def _pose(p: dict) -> List[float]:
    pose = p.get("pose")
    if not isinstance(pose, (list, tuple)) or len(pose) != 6:
        raise ValueError("位姿需 6 元组 [x, y, z, rx, ry, rz]")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in pose):
        raise ValueError("位姿必须是 6 个数值")
    return [float(v) for v in pose]


def _speed(p: dict) -> float:
    """速度 —— 缺省时**不填**, 让 SDK 用自己的默认值 (`movej`/`move_l` 的 `speed=1.0`)。

    ⚠ `move_l` 的 `speed` 是**单条轨迹倍率** 0..1; 全局调速是另一条命令
    (`set_speed`, 整数百分比 0..100 —— `set_speed(1)` 是 1% 速度)。
    """
    if "speed" not in p or p["speed"] is None:
        return 1.0
    v = p["speed"]
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError("speed 需数值")
    v = float(v)
    if not 0.0 <= v <= 1.0:
        raise ValueError("speed 需 0..1 (单条轨迹倍率; 全局调速用 set_speed 的 0..100)")
    return v


def _percent(p: dict) -> int:
    v = p.get("percent")
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError("percent 需整数百分比 0..100")
    if not 0 <= v <= 100:
        raise ValueError("percent 需 0..100")
    return int(v)


def _idx(p: dict) -> int:
    """0 基关节号 —— 与 SDK 的 `params.*` 口径一致 (UI 显示时才 +1 成 J1..Jn)。"""
    v = p.get("idx")
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError("idx 需整数 (0 基关节号)")
    if v < 0:
        raise ValueError("idx 需 >= 0")
    return v


def _num(p: dict, key: str) -> float:
    v = p.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{key} 需数值")
    return float(v)


def _joint_param_dict(jp: Any) -> dict:
    """`JointParam` → 线上 dict。

    ⚠ 键名用 **snake_case** (与 SDK 的 dataclass 字段同名), 不跟状态帧那套 camelCase
    —— 这里的键就是 SDK 的字段名, 改成 camelCase 只会让两边对不上。
    """
    return {
        "idx": int(jp.idx),
        "kp": float(jp.kp),
        "kd": float(jp.kd),
        "tau_max": float(jp.tau_max),
        "q_min": float(jp.q_min),
        "q_max": float(jp.q_max),
    }


def _state_result(state: Any) -> Optional[dict]:
    """把 `movej`/`home` 的 `RobotState` 返回值折成一个小 JSON —— **不是**完整状态帧。

    完整状态帧由 50Hz 轮询那条路推 (`state` 事件), 这里只回"这条命令收尾时臂是什么
    样" (到位判据的收尾帧), 免得每个 `res` 都驮几百字节。
    """
    if state is None:
        return None
    return {
        "q": [statemap._r6(j.q) for j in state.joints],
        "dq": [statemap._r6(j.dq) for j in state.joints],
        "enabled": bool(state.enabled),
        "faulted": bool(state.faulted),
    }
