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
   ⚠ **缓存帧不等于链路还活着**: 设备一断, SDK 的缓存永远回最后一帧好数据。所以
   `_status` 不能只看"上次握手成功" —— 断线判据是**被动状态流的到达时刻**
   (`_poll_once` + `LINK_STALE_AFTER_S`), 后果是落 `error` 态并**自愈**
   (`_note_link_lost` / `_recover_link`)。
3. **命令串行** —— 普通 SDK 调用都在 `ThreadPoolExecutor(max_workers=1)` 上跑;
   运动互斥 (`motion_in_flight`) 在**提交之前**判定, 在途时新运动命令**立刻被拒**
   (不排队)。⚠ **降能量方向的安全命令例外** (`estop`/`disable`): 它们走另一条
   单线程执行器, 与在途运动**并行** —— 否则"永远可达"会被一条阻塞到 `move_timeout`
   的 `movej` 吃掉 (见 `ENERGY_DOWN_COMMANDS`)。
4. **安全在本地程序里** —— 客户端断开**不**杀会话; `estop`/`disable` 这种降能量动作
   只需会话存在, 不依赖浏览器是否活着。
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional, Tuple

import litearm
from litearm import Arm

from . import statemap
from . import activation
from .errors import MotionBusyError, NotConnectedCommandError, UnknownCommandError

log = logging.getLogger("litearm_studio_daemon.session")

#: 状态轮询周期 (秒) —— 20ms = 50Hz。**必须自己节流**: SDK 那条路径读的是缓存帧,
#: 不节流的话轮询线程会以 GIL 允许的最高速率空转 (实测能把整套用例拖慢一个量级)。
#: ⚠ 循环体里的 sleep 只保证"周期**不小于**本值" (工作耗时叠加在上面), 这与
#: "不要依赖帧到达速率"是同一个口径 —— 我们是主动方, 不跟固件的 100Hz 对齐。
POLL_PERIOD_S = 0.02

#: 状态推送节流 (秒) —— 20ms = 50Hz, 与轮询同频。
#:
#: ⚠ 这里**不能**按"10Hz 够用"来定 —— 上一版就是 0.1, 那是个**真回归**: 旧客户端
#: 给 3D 预览单独留了一条直读 SDK 缓存的 60Hz 快通道, 而新架构下前端读不到那个缓存,
#: 只能吃本推送 ⇒ 10Hz 会让 3D 孪生明显发卡, 而"状态与 3D 实时刷新"是这一版的明确目标。
#: 代价可忽略: 回环上一个状态帧约 400B (7 轴), 50Hz ≈ 20KB/s; 且前端自己把 **React
#: 通知**节流在 10Hz (`ArmClient.STATE_NOTIFY_INTERVAL_MS`), 提速率只喂给 3D 那条
#: 快订阅, 不会让整页重渲染。该判据由 `test_state_push_rate_feeds_the_3d_preview` 钉住。
#: ⚠ **状态串变化 / 故障变化一律立即推** (见 `_poll_loop`), 节流只管"同样内容重复推"。
STATE_PUSH_INTERVAL_S = 0.02

#: 链路"没声音"多久即判为断 (秒) —— 判据是**固件那条 100Hz 被动状态流的到达时刻**。
#:
#: 为什么必须由守护进程自己判: `_status` 从前只记"上次握手成功", 而 50Hz 轮询读的是
#: SDK 的**缓存帧** (不发串口帧) ⇒ 设备一拔/一复位, 状态帧不再到达, 缓存却永远回最后一
#: 帧好数据: 顶栏一直绿着、数字冻住, 直到某条命令被拒才发现 (issue #48)。
#:
#: 取 2.0s 的理由 (不是随手取的): 被动流是 100Hz (10ms 一帧), 2s = **连续丢了约 200
#: 帧**。它要同时满足两头 —— 短到操作员几秒内就看见故障, 长到不会把一次调度抖动
#: (负载/GC 造成的几百毫秒停顿) 误判成断线。判据用 SDK 记的**到达时刻**
#: (`Msg.timestamp`), 那是它的读线程在收帧时写的, 所以"本进程这一拍被拖慢"不会误判。
#: ⚠ 唯一的例外是固件整扇区擦写 (那条路会**故意**停流) —— 见 `FLASH_STALL_GRACE_S`。
LINK_STALE_AFTER_S = 2.0

#: 断线自愈的两次尝试间隔 (秒) 与总窗口 (秒)。
#:
#: 窗口**有界**是刻意的: 板子重新枚举通常一两秒就回来, 但"操作员故意拔了线就走开"
#: 不该让守护进程永远在后台攥着这个口。窗口用尽后如实上报 (见 `_recover_link`), 由
#: 操作员决定是否重连 —— 这正是 issue #48 接受的两条出路 ("自愈, 或者明确告诉人")。
RECONNECT_PERIOD_S = 1.0
RECONNECT_WINDOW_S = 60.0

#: 会触发**固件整扇区擦写**的命令 —— 擦写窗口里 CPU 取指停顿, 100Hz 被动状态流会**断**,
#: 但链路是好的。判活必须给这段时间让路, 否则"保存参数"会被读成"设备掉了"。
#:
#: 依据在 SDK 自己的取证里 (`cart.py` 那段 `12.0 s ≈ 3 + 8 + 1`): 固件自述擦写"~1s CPU
#: 全停" (`usb_cmd.c:1272`), 同一件事在另两处按 ~1.86s 记; 而**上界**来自它给擦写开的
#: 看门狗豁免 `hw_watchdog.h:28` —— 整扇区擦除期间 IWDG 被放宽到 **~8s**, 超过它固件自己
#: 就复位了 (那属于"再也回不来", 不是这里要放过的形状)。
FLASH_STALL_COMMANDS = frozenset({"save_params", "reset_factory_params"})

#: 擦写停滞的让路窗口 (秒) —— 取 12s (SDK 那条 `3 + 8 + 1` 的量级: 固件停滞上界 ~8s,
#: 加应答与主机取帧的余量)。
#:
#: ⚠ 为什么从**命令返回之后**才算起: `0x25`/`0x36` 的 ACK 只表示**受理**, 擦写在 main
#: 循环里做 (桩与固件同语义)。所以窗口在派发前先落一次 (命令挂住/在途中擦写已经开始),
#: 命令返回后再落一次 (真正的擦写通常在这一段)。
#: 代价说清楚: 这 12s 内"没人跟臂说话"的断线只能由别的东西发现 (任何一条命令撞上
#: `TransportError` 都会当场判死, 见 `execute`) —— 而擦写要求失能态, 静默 12s 不危险。
FLASH_STALL_GRACE_S = 12.0

#: 运动类命令 —— 这三条在途时, 新的运动命令立刻被拒 (计划 2 节原则 3)。
#: ⚠ `estop`/`disable`/`zero_g_stop` **不在此列**: 降能量方向的动作永远可达,
#: 这正是原则 4 要的 (急停不能因为"运动互斥"而被挡住)。
MOTION_COMMANDS = frozenset({"home", "movej", "movel"})

#: 降能量方向的安全命令 —— 不仅豁免运动互斥, 还**不排在**普通命令的执行器后面。
#:
#: ⚠ 光"不在 `MOTION_COMMANDS` 里"是不够的: 所有 SDK 调用原本共用同一条单线程
#: 执行器, 而 `movej`/`movel`/`home` 会阻塞到`move_timeout` (真机默认 15s) 甚至更久。
#: 于是急停虽然过了互斥判定, 却仍要**排队**等运动结束 —— 实测按住 2s 的 movej 时
#: `estop` 要等 1.8s 才返回。这与计划 3.2「永远可达」直接冲突。这组命令改走
#: `_safety_executor`, 与普通命令**并行**执行。
#: ⚠ SDK 侧本来就为这种并发留了口子: `emergency_stop`/`disable` 明确**不取**
#: `_cart_serial` 锁 (见 litearm-python `arm.py` 的锁序说明), 就是为了让持锁者
#: 阻塞到 `move_timeout` 时它们仍然可达。
#: ⚠ 只收**安全动作**: `zero_g_stop` 虽然也降能量, 但它会改写会话自己的零重力记录
#: (`_note_zero_g`), 与状态轮询共享状态, 不放进这条并行通道。
ENERGY_DOWN_COMMANDS = frozenset({"estop", "disable"})

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
    "reset_factory_params": "恢复出厂参数 (固件要求失能态)",
    # ---- 载荷 / 前馈系数 / 固件自检 (计划第 5 节列为「有对应, 直接接线」) ----
    "set_payload": "设末端载荷质量与质心 (前馈 item 4/5)",
    "set_gravity_scale": "设重力前馈系数 (前馈 vec item 7, 7 值)",
    "set_inertia_scale": "设惯量前馈系数 (前馈 vec item 8, 7 值)",
    "set_gravity_vector": "设重力方向向量 (前馈 scalar item 6, 3 值)",
    "get_ff_vec": "读回前馈向量 (item 7=重力系数 / 8=惯量系数)",
    "get_ff_scalar": "读回前馈标量 (item 4=载荷质量 / 5=质心 / 6=重力向量)",
    "kin_bench": "固件运动学自检 + 链路诊断计数",
    # ---- 授权/激活 (只读那一半; 提交凭据要等凭据格式定稿, 见 docs/ACTIVATION.md) ----
    "license": "读设备授权记录: 是否已激活 + 设备 UID (arm.license) —— "
               "**未激活是一种状态, 不是错误**",
    # ---- 激活 (写入; 在线领凭据) ----
    "activate": "把注册信息提交给激活服务, 拿回本机凭据并写入设备 "
                "(唯一出网的一条命令; 须失能态)",
}


def find_cdc_port() -> Optional[str]:
    """SDK 的 CDC 自动发现 (`find_cdc_port`), 找不到时返回 `None`。

    单独包一层是为了让**测试**能替换它 (会话构造时 port 为空 ⇒ 走这里),
    而不必去 monkeypatch SDK 自己的模块名。
    """
    return litearm.find_cdc_port()


def build_fake_transport_factory(*, activated: bool = True):
    """`--fake` 模式的注入工厂 —— 延迟 import, 免得生产运行也拖着 `litearm.testing`。

    签名契约 (`litearm-python/tests/conftest.py` 的 `fake_transport_factory` 与
    `Arm.connect()` 里的调用点 `(self._transport_factory or SerialTransport)(p)`):
    工厂只接收**一个位置参数** = 端口字符串。

    ⚠ 固件版本字面量取 `Litearm1.8.0-7J` + `n=7`: `connect()` 会校验版本约定
    (`Litearm<主.次.修>-{7J|1J}`) 且 `1.8.0 >= MIN_FW (1.5.0)`; `n=7` 让桩固件
    在装配时就把关节数定成 7 (整臂), 于是 `movej` 的 arity 校验一次到位。

    `activated=False` 把假设备变成**未激活**的一台 (`--fake-unactivated`): 授权记录照回
    (含 UID), 但 `ENABLE` 会被拒 `ERR{0x10,0x08}` —— 于是"未激活"整条界面路径 (授权面板、
    注册表单、使能被拒的提示) 在没有硬件时也能走一遍。
    """
    from litearm.testing import FakeTransport

    def factory(port: str) -> Any:
        tr = FakeTransport(port=port, timeout=0.2, fw="Litearm1.8.0-7J", n=7)
        # ⚠ 桩的 `activated` 默认是 True (它模拟的是一台出厂已授权的板子) —— 这里按需翻掉。
        tr.activated = bool(activated)
        return tr

    return factory


class Session:
    """单臂会话 —— 线程安全 (状态用一把 `RLock` 圈住)。"""

    def __init__(self, *, port: Optional[str] = None, fake: bool = False,
                 fake_activated: bool = True,
                 port_finder: Optional[Callable[[], Optional[str]]] = None,
                 poll_period: float = POLL_PERIOD_S,
                 state_push_interval: float = STATE_PUSH_INTERVAL_S,
                 link_stale_after: float = LINK_STALE_AFTER_S,
                 reconnect: bool = True,
                 reconnect_period: float = RECONNECT_PERIOD_S,
                 reconnect_window: float = RECONNECT_WINDOW_S,
                 disable_on_exit: bool = True,
                 activation_url: str = activation.DEFAULT_ACTIVATION_URL,
                 sdk_version: str = litearm.__version__) -> None:
        #: 构造时给的端口 —— 空 = 连接时用 `port_finder` (= SDK `find_cdc_port`) 自动发现。
        #: ⚠ `--port` 只是**覆盖**自动发现 (计划 2 节「设备发现」), 所以这里允许 None。
        self._port = port or None
        self._fake = bool(fake)
        #: `--fake` 下假设备是不是"已激活的那台"。False = 未激活 (界面能看到注册表单)。
        #: 只在 `--fake` 下有意义; 命令行那边会拒掉"给了它却没给 --fake"的组合。
        self._fake_activated = bool(fake_activated)
        self._port_finder = port_finder or find_cdc_port
        self._poll_period = float(poll_period)
        self._state_push_interval = float(state_push_interval)
        #: 多久没有新状态帧即判链路已断 (见 `LINK_STALE_AFTER_S`)。
        self._link_stale_after = float(link_stale_after)
        #: 断线后是否自愈 (见 `_recover_link`), 以及自愈的节奏与窗口。
        self._reconnect = bool(reconnect)
        self._reconnect_period = float(reconnect_period)
        self._reconnect_window = float(reconnect_window)
        #: 退出时是否降能量 —— 见 `close()` 与 `_deenergize()`。**产品策略**, 默认开。
        self._disable_on_exit = bool(disable_on_exit)
        #: 激活服务地址 (见 `activation.py`)。空 = 未配置: 在线激活会当场说清, 而不是
        #: 转圈等超时。
        self._activation_url = (activation_url or "").strip()
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
        #: 这一次连接**建立**的时刻 —— 与状态帧无关的兜底参照 (见 `_poll_once`):
        #: 连上之后一直收不到任何状态帧, 也要能判成断线。
        self._connected_at = 0.0
        self._last_emit_key: Any = None
        self._last_emit_at = 0.0
        self._zero_g_since: Optional[float] = None
        #: 运动在飞计数 (不是 bool: 同一瞬间可能既有在途、又有刚提交的)
        self._motion_count = 0
        #: 固件擦写停滞的让路截止时刻 (见 `FLASH_STALL_GRACE_S`); 0.0 = 没在让路。
        self._flash_grace_until = 0.0
        #: 断线自愈在途 (`_recover_link`) —— `disconnect()` 靠它把"取消了一次自愈"
        #: 也算成"停掉了东西", 与握手中的 `_connect_gen` 是同一个口径。
        self._recovering = False
        self._recover_thread: Optional[threading.Thread] = None
        #: **连接代次** —— 每次 `connect()` 递增, `disconnect()`/`close()` 也递增。
        #: 握手是异步的 (可能几秒), 而 `disconnect()` 只能看到「这一刻有没有 arm」;
        #: `_open` 在收尾时比对代次, 对不上就丢弃这次连接。没有它, 用户在握手期间按
        #: 「断开」会被握手完成后的 `_open` 覆盖成 `connected` (上一版的真 bug)。
        self._connect_gen = 0

        self._listeners: List[Callable[[dict], None]] = []
        #: **所有** SDK 调用都在这条单线程上跑 ⇒ 天然串行 (计划 2 节原则 3)。
        #: `thread_name_prefix` 便于排障时一眼看出是谁。
        self._executor = ThreadPoolExecutor(max_workers=1,
                                            thread_name_prefix="litearm-cmd")
        #: 降能量方向的安全命令专用 (见 `ENERGY_DOWN_COMMANDS`) —— 单线程保证两条急停
        #: 之间仍串行, 但它**不排队等运动**: 这是「永远可达」的实现点。
        self._safety_executor = ThreadPoolExecutor(max_workers=1,
                                                   thread_name_prefix="litearm-safety")
        self._stop = threading.Event()
        self._poll_thread: Optional[threading.Thread] = None
        #: 状态轮询线程**自己的**停止信号 —— 与 `_stop` (整个会话收尾) 分开。
        #: ⚠ 上一版 `_stop_polling()` 只清引用再 `join(1.0)`, 而轮询循环判的是 `_stop`
        #: ⇒ 它**永不退出**: `disconnect()` 每次白等满 1s, 每次重连再多留一条 50Hz 空转
        #: 线程。断线自愈要反复"停轮询 → 重连 → 再起轮询", 这条泄漏必须先收掉。
        self._poll_stop = threading.Event()

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

        ⚠ 握手期间收到 `disconnect()`/`close()` 时, 这次连接由 `_connect_gen` 作废:
        收尾的 `_open` 会把已建好的 arm 关掉并静默退出, **不会**把状态改回 `connected`。
        """
        with self._lock:
            if self._arm is not None and self._status == "connected":
                return True
            if self._status == "connecting":
                return False
            self._status = "connecting"
            self._last_error = None
            # 代次在这里落章: `_open`/`_recover_link` 收尾时比对, 对不上说明这次连接
            # (或这次自愈) 已被断开/关闭作废。
            self._connect_gen += 1
            gen = self._connect_gen
        self._broadcast({"t": "conn", **self.arm_info()})

        def _open(gen: int) -> None:
            try:
                target = self._connect_target()
                arm = self._dial(target)
            except Exception as e:  # noqa: BLE001 - 连接失败是**预期结局**之一
                self._connect_failed(e, None, gen)
                return
            self._commit_link(arm, target, gen)

        self._executor.submit(_open, gen)
        return True

    def _connect_target(self) -> str:
        """这次 `connect()` 该连哪个口 —— **自动发现 / `--port` / `--fake` 的唯一判据点**。

        ⚠ 语义刻意与自愈那条不同 (`_recover_candidates`): 这里 `--port` 是**明确指定**,
        指定错了就该响亮失败, 不许偷偷换成自动发现到的另一个设备 —— 那会让"我明明指了
        这个口"变成谎话。自愈那条的职责是"把这台臂找回来", 所以它允许退回发现。
        """
        if self._fake:
            # ⚠ 注入工厂时**必须**同时给占位端口: SDK 的 `find_cdc_port()`
            # 空值检查排在注入点**之前** (见 `Arm.__init__` 的说明), 没有端口会
            # 在走到工厂之前就抛 TransportError。
            return self._port or "fake"
        if self._port:
            return self._port
        # 真机 + 没给 --port ⇒ 交给 SDK 自己发现。**在连接时**才发现:
        # 启动时发现会让"插上臂再点连接"这种用法失效。
        found = self._port_finder()
        if not found:
            raise litearm.TransportError(
                "未发现 STM32 CDC 设备 (VID:PID 1d50:606f); 请插好设备或用 --port 指定")
        return found

    def _dial(self, target: str) -> Arm:
        """按端口建一条链路 —— `connect()` 与断线自愈**共用**的唯一构造点。"""
        factory = (build_fake_transport_factory(activated=self._fake_activated)
                   if self._fake else None)
        return Arm(port=target, transport_factory=factory).connect()

    def _commit_link(self, arm: Arm, target: str, gen: int) -> bool:
        """把一条新建好的链路装进会话 —— 代次/收尾守卫不过就**丢弃它**。

        两条调用者 (`connect()` 的 `_open`、断线自愈的 `_recover_link`) 共用: 差别只在
        怎么把 `arm` 建起来 (以及失败后怎么写状态), 而"该不该认领它"必须只有一份判据。

        ⚠ **收尾这一段也在自己的 try 里**: `_open` 跑在**没人读取的 Future** 上, 抛出去
        就是静默失败。实测过一次 `AttributeError` (SDK 的 `Arm` 没有 `port` 属性): 前端
        看到 `connected`, 状态帧却永远不来, 日志里一个错都没有 —— 排障时这是最坏的一种
        失败。故这里一律转成 error 态报出来 (`test_connect_completion_failure_...`)。
        """
        with self._lock:
            if self._connect_gen != gen or self._stop.is_set():
                stale = True
            else:
                stale = False
                self._arm = arm
                self._status = "connected"
                self._last_error = None
                self._resolved_port = target
                self._connected_at = time.monotonic()
        if stale:
            # 握手/自愈期间用户按了「断开」(或进程在收尾) —— 这个会话没人要了。
            # ⚠ 必须在这里把它关掉: 否则串口被一个「已断开」的会话占着。
            log.info("链路建成时已被断开/关闭, 丢弃它: port=%s", target)
            self._close_arm(arm)
            return False
        try:
            log.info("已连接: port=%s firmware=%s n=%d cart=%s",
                     target, arm.firmware, arm.n,
                     getattr(arm, "_cart_supported", None))
            self._broadcast({"t": "conn", **self.arm_info()})
            self._start_polling()
        except Exception as e:  # noqa: BLE001
            log.exception("连接收尾失败 (已转为 error 态)")
            self._connect_failed(e, arm, gen)
            return False
        return True

    def disconnect(self) -> bool:
        """断开 (幂等) —— 未连接时是 no-op 并返回 `False`。

        收尾顺序: 停状态轮询 → 停 SDK 会话。`close()` 自己幂等, 且它内部会先收
        零重力保活线程再关链路 (SDK `Arm.close()` 的既定顺序, 不重复一遍)。

        ⚠ **握手在途时也算「停掉了东西」并返回 `True`** —— 否则「连接中按断开」会
        被报成 no-op, 而实际发生的是取消了一次连接。**断线自愈在途时同理**: 那也是一次
        正在进行的连接尝试 (`_recovering`), 报 no-op 会让前端以为"本来就没在连"。
        """
        with self._lock:
            # 先作废在途握手/自愈: 否则 `_open`/`_recover_link` 会在本方法返回**之后**
            # 把它连上, 用户按了断开却看到 connected (上一版的真 bug, 由 `test_...` 钉住)。
            self._connect_gen += 1
            if self._arm is None:
                was_busy = self._status == "connecting" or self._recovering
                self._status = "disconnected"
                self._last_error = None
                self._resolved_port = None
                return was_busy
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

    def _connect_failed(self, exc: BaseException, arm: Optional[Arm],
                        gen: Optional[int] = None) -> None:
        """连接（或连接收尾）失败 —— 落 `error` 态并推一条带原因的 `conn`。

        ⚠ **必须把异常转成状态, 不许让它逃出去**: 本方法跑在命令执行器的那条 Future
        上, 而那条 Future 没人读取 —— 逃出去就是静默失败 (前端停在 connecting, 日志
        一片安静)。

        ⚠ `gen` 对不上说明这次握手已被 `disconnect()`/`close()` 作废: 此时**不能**把
        状态改写成 `error` —— 用户按的是「断开」, 不是「连接失败」。
        """
        if arm is not None:
            self._close_arm(arm)
        with self._lock:
            if gen is not None and self._connect_gen != gen:
                log.info("握手失败时已被断开/关闭, 不上报 error: %s: %s",
                         type(exc).__name__, exc)
                return
            self._arm = None
            self._status = "error"
            self._last_error = f"{type(exc).__name__}: {exc}"
            self._resolved_port = None
        log.warning("连接失败: %s", self._last_error)
        self._broadcast({"t": "conn", **self.arm_info()})

    # ------------------------------------------------------------------ 链路存活 / 自愈
    def _note_link_lost(self, arm: Arm, reason: str) -> bool:
        """链路**可观测地**断了 —— 落 `error` 态、推一条 conn, 并按需起自愈。

        两个调用点, 两条独立的观测 (issue #48 的第 2、3 层):

        * `_poll_once` —— 固件那条 100Hz 被动状态流停了 (`LINK_STALE_AFTER_S`);
        * `execute` —— 某条命令撞上 `TransportError` (写不出去 / 读线程已死)。

        ⚠ **判据是"仍然是我正在用的那条链路"** (`self._arm is arm` 且状态还是
        `connected`): 断开、重连、收尾都可能与本方法并发, 那时旧 arm 的失败**不是**这个
        会话的现状。少了这条, 一次 `disconnect()` 之后的迟到失败会把状态改写成 error。

        ⚠ 端口在这里**清掉** (`_resolved_port = None`): `conn` 帧必须老实说"现在没有
        链路", 而不是继续报那个已经消失的 `/dev/ttyACM1` (issue #48 的实测: 那个端口
        名僵了近三个小时)。真正的端口名由自愈重新解析出来后重新填上。
        """
        with self._lock:
            if self._arm is not arm or self._status != "connected":
                return False
            self._arm = None
            self._status = "error"
            self._last_error = f"链路已断开: {reason}"
            last_port = self._resolved_port
            self._resolved_port = None
            # 清掉最后一帧好数据: 断线之后不许再有人拿它当"现在"。
            self._state = None
            self._state_dict = None
            self._state_stamp = 0.0
            self._last_emit_key = None
            self._zero_g_since = None
            gen = self._connect_gen
            reconnect = self._reconnect
        log.warning("链路已断开 (port=%s): %s", last_port, reason)
        self._broadcast({"t": "conn", **self.arm_info()})
        if not reconnect:
            # 没开自愈: 旧链路仍然要收掉 (它占着串口), 但**不**排在那条可能阻塞
            # 十几秒的命令执行器后面 —— 排进去会让"想手动重连"也一起等。
            threading.Thread(target=self._close_arm, args=(arm,),
                             name="litearm-close-dead", daemon=True).start()
            return True
        th = threading.Thread(target=self._recover_link, args=(gen, last_port, arm),
                              name="litearm-reconnect", daemon=True)
        with self._lock:
            self._recovering = True
            self._recover_thread = th
        th.start()
        return True

    def _recover_candidates(self, hint: Optional[str]) -> List[str]:
        """自愈时按什么顺序试哪些口 —— 与 `_connect_target` 的差别见那里。

        顺序 = **上次真正连上的口** → 显式 `--port` → 自动发现。前两个都可能已经消失
        (设备重新枚举后节点名会变: 实测 `/dev/ttyACM1` → `/dev/ttyACM0`), 所以**必须**
        留着最后那条发现通道 —— 它才是"把这台臂找回来"的依据。
        """
        if self._fake:
            return [self._port or "fake"]
        out: List[str] = []
        for cand in (hint, self._port, self._port_finder()):
            if cand and cand not in out:
                out.append(cand)
        return out

    def _recover_link(self, gen: int, hint: Optional[str], old_arm: Arm) -> None:
        """断线自愈 —— 关掉死链路, 重新解析 CDC 设备, 在窗口内重试建会话。

        窗口 (`_reconnect_window`) 与间隔 (`_reconnect_period`) 见两个常量的说明。三条
        退出路径, 每条都必须**不留下半个会话**:

        * 成功 ⇒ `_commit_link` 认领它 (那里有代次守卫, 被作废就自己把 arm 关掉);
        * 操作员在别处按了连接/断开, 或进程收尾 (`_connect_gen` 变了 / `_stop` 置上)
          ⇒ 直接让位, **不动状态** (那是调用方的事);
        * 窗口用尽 ⇒ 把"试过多少次、最后一句为什么"写进 `error` 再推一条 `conn` ——
          issue #48 要的是"要么自愈, 要么明确告诉操作者", 不是静默重试到天荒地老。
        """
        # ⚠ 先关死链路**再**重试: 进程内那张 `port -> 持有者` 登记表按端口名判重
        # (`transport._claim_port`), 同一个节点名重新枚举回来时, 不先放掉旧句柄就永远
        # 打不开。这一步放在自愈线程上而不是命令执行器上 —— 后者可能正被一条
        # 阻塞到 `move_timeout` 的运动命令占着。
        self._close_arm(old_arm)
        try:
            deadline = time.monotonic() + self._reconnect_window
            attempts = 0
            last_detail = ""
            while not self._stop.is_set():
                if self._connect_gen != gen:
                    return                      # 用户手动连/断 ⇒ 让位, 不碰状态
                attempts += 1
                targets = self._recover_candidates(hint)
                if not targets:
                    last_detail = "没有发现可用的 STM32 CDC 设备"
                for target in targets:
                    if self._connect_gen != gen or self._stop.is_set():
                        return
                    try:
                        arm = self._dial(target)
                    except Exception as e:  # noqa: BLE001 - 设备还没回来是**预期结局**
                        last_detail = f"{target}: {type(e).__name__}: {e}"
                        log.info("自愈第 %d 次尝试失败: %s", attempts, last_detail)
                        continue
                    if self._commit_link(arm, target, gen):
                        log.info("链路已恢复: port=%s (第 %d 次尝试)", target, attempts)
                        return
                    # 认领失败: 要么代次被作废 (用户手动连/断), 要么收尾那一步抛了错
                    # (`_commit_link` 两种情况都已经把这条 arm 关掉并落好状态) ⇒ 收工。
                    return
                if time.monotonic() >= deadline:
                    break
                self._stop.wait(self._reconnect_period)
            with self._lock:
                if self._connect_gen != gen or self._stop.is_set():
                    return
                self._last_error = (f"链路已断开, 自动重连 {attempts} 次未成功"
                                    f" ({self._reconnect_window:.0f}s 内): {last_detail}")
            log.warning("自愈窗口用尽: %s", self._last_error)
            self._broadcast({"t": "conn", **self.arm_info()})
        except Exception:  # noqa: BLE001 - 自愈线程不许带着栈死掉
            # 设备发现 (用户注入的 `port_finder`) 或 SDK 构造都可能抛意料之外的东西。
            # 会话留在 `error` 态 (下面 finally 会落下 `_recovering`), 由操作员手工重连。
            log.exception("断线自愈异常结束 (会话停在 error 态, 需手工重连)")
        finally:
            with self._lock:
                # ⚠ 只清**自己**那次: 极窄的窗口里新一次断线可能已经起了新的自愈线程,
                # 无条件置 False 会把它标成"没在自愈", 于是 `disconnect()` 误报 no-op。
                if self._recover_thread is threading.current_thread():
                    self._recovering = False

    def close(self) -> None:
        """整个守护进程收尾 (幂等) —— 停轮询、停执行器、**降能量**、关会话。

        ⚠ **退出前会先失能** (`disable`, 降能量方向)。这是本项目的产品策略, 而不是
        实现细节: 进程一走链路就断, 与其把"电机是否还使能"留给固件看门狗, 不如在
        还有链路时明确降能量 —— 上一版把这件事写成"由调用方决定", 而**没有**任何
        调用方决定, 于是 Ctrl-C 之后机械臂可能仍带着使能。

        ⚠ 与 `disconnect()` 的区别是**刻意的**: 断开只是结束这一次会话 (计划 2 节
        原则 4 要的是"关窗口不打断在途会话"), 所以那里**不**降能量; 只有进程收尾
        才降。要保留使能请用 `--keep-enabled` (`disable_on_exit=False`)。
        """
        self._stop.set()
        # 作废在途握手: 收尾时建起来的 arm 没人会关, 会一直占着串口。
        with self._lock:
            self._connect_gen += 1
        self._stop_polling()
        # 先等在途命令收尾, 免得它与失能抢链路。
        self._executor.shutdown(wait=True)
        arm = self._take_arm()
        if arm is not None:
            self._deenergize(arm)
            self._close_arm(arm)
            with self._lock:
                self._status = "disconnected"
        self._safety_executor.shutdown(wait=True)

    def _deenergize(self, arm: Arm) -> None:
        """退出前的降能量 —— **任何失败都只记日志**, 收尾不能因此中断。

        用 `disable` 而不是 `estop`: 后者会锁存一个急停故障, 下次连接还得先清错;
        正常退出要的是"掉力矩", 不是"制造故障"。

        ⚠ 本方法在 `close()` 里、主执行器已经排空之后调用, 所以不与在途命令抢链路;
        链路已断时 `disable()` 会抛, 那正是"只能记日志"的场景。
        """
        if not self._disable_on_exit:
            log.info("退出前保持使能 (disable_on_exit=False)")
            return
        try:
            arm.disable()
            log.info("退出前已失能 (降能量)")
        except Exception:  # noqa: BLE001 - 链路可能已断, 收尾不许因此失败
            log.warning("退出前失能失败 (已忽略; 链路可能已断)", exc_info=True)

    # ------------------------------------------------------------------ 状态轮询
    def _start_polling(self) -> None:
        self._stop_polling()
        self._poll_stop.clear()
        th = threading.Thread(target=self._poll_loop, name="litearm-state-poll",
                              daemon=True)
        with self._lock:
            self._poll_thread = th
        th.start()

    def _stop_polling(self) -> None:
        """停轮询线程并**等它真的退出** —— 判据是它自己的事件, 不是"等满 1s"。

        ⚠ 上一版只清引用再 `join(1.0)`, 而循环判的是 `_stop` ⇒ 它永不退出:
        `disconnect()` 每次白等满 1s、每次重连多留一条 50Hz 空转线程 (实测确认)。
        断线自愈要反复"停轮询 → 重连 → 再起轮询", 所以这条必须先修。
        """
        self._poll_stop.set()
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

        ⚠ **"只读缓存"的代价是这一层看不见断线** (issue #48 的第 2 层): 设备一拔, 缓存
        永远回最后一帧好数据, 于是广播把同一帧一直重放。所以"这一拍还有没有新帧"必须
        单独判 —— 见 `_poll_once` 开头的存活判据。
        """
        while not (self._stop.is_set() or self._poll_stop.is_set()):
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
                self._poll_stop.wait(rest)

    def _poll_once(self, now: float) -> Optional[dict]:
        arm = self._arm
        if arm is None:
            return None
        try:
            msg = arm.get_state()
        except Exception:  # noqa: BLE001 - 见 `_poll_loop` 的三条纪律
            return None
        if self._is_link_stale(msg, now):
            # ⚠ 判死之后**什么都不推**: 最后一帧好数据已经在 `_note_link_lost` 里清掉了。
            self._note_link_lost(
                arm,
                f"{now - (msg.timestamp or self._connected_at):.1f}s 没有新的状态帧"
                f" (固件 100Hz 被动流中断)")
            return None
        state = msg.value
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

    def _is_link_stale(self, msg: Any, now: float) -> bool:
        """这一拍还"听得见"这条链路吗 —— 判据是**被动状态流的到达时刻**。

        用 `Msg.timestamp` (SDK 记的"最近一帧状态帧到达时刻", 由它的读线程写) 而不是
        本进程自己的计数: 守护进程被负载拖慢时, 帧仍在到达, 判据不该跟着变糊。

        ⚠ 参照时刻取 `msg.timestamp or self._connected_at`: 连上之后**一帧都没收到过**
        (timestamp 还是哨兵 0.0) 也要能在同一个窗口内判死, 否则"连上了但收不到状态帧"
        会一直报 connected —— 那正是 issue #48 里"顶栏绿着、数字冻住"的另一种形状。
        """
        reference = msg.timestamp or self._connected_at
        if not reference:
            return False
        limit = self._link_stale_after
        with self._lock:
            if self._flash_grace_until > now:
                # 固件正在整扇区擦写 (见 `FLASH_STALL_GRACE_S`): 状态流停了但它没死。
                limit = max(limit, FLASH_STALL_GRACE_S)
        return (now - reference) > limit

    def _note_flash_stall(self) -> None:
        """落一次擦写让路窗口 —— 派发前与返回后各调一次 (理由见 `FLASH_STALL_GRACE_S`)。"""
        with self._lock:
            self._flash_grace_until = time.monotonic() + FLASH_STALL_GRACE_S

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
        ⚠ `estop`/`disable` 走**另一条**执行器 (见 `ENERGY_DOWN_COMMANDS`), 与在途
        运动并行 —— 这是「降能量动作永远可达」的落点。
        返回值是 SDK 原生返回值 (已按需取 `.value` / 转 dict), 由 server 层压成 JSON。

        ⚠ **传输层失败要当场把链路判死** (issue #48 的第 3 层): 命令门控从前只看 `_status`
        这个标志位, 于是"标志位说已连接、每条命令都撞 `[Errno 5]`"能持续几个小时。异常
        照旧往上抛 (调用方要看到失败), 但会话同时落 `error` 态并推一条 `conn` —— 前端
        与守护进程对"现在还能不能指挥这台臂"必须给同一个答案。
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
            # ⚠ 降能量方向的动作走**另一条**执行器: 与在途运动并行, 不排队等它结束
            # (见 `ENERGY_DOWN_COMMANDS`)。这是「急停永远可达」的落点 —— 只在准入处
            # 豁免运动互斥是不够的, 那样它仍会排在阻塞十几秒的 movej 后面。
            executor = (self._safety_executor if m in ENERGY_DOWN_COMMANDS
                        else self._executor)
            try:
                return executor.submit(self._run_command, arm, m, params,
                                       on_event).result()
            except litearm.TransportError as e:
                self._note_link_lost(arm, f"命令 {m} 失败: {type(e).__name__}: {e}")
                raise
        finally:
            if m in MOTION_COMMANDS:
                with self._lock:
                    self._motion_count = max(0, self._motion_count - 1)

    def _run_command(self, arm: Arm, m: str, p: dict,
                     on_event: Optional[Callable[[dict], None]]) -> Any:
        """在命令执行器线程上跑一条 SDK 调用 (串行域内)。"""
        if m in FLASH_STALL_COMMANDS:
            # ⚠ 派发**之前**也落一次让路窗口 (见 `FLASH_STALL_GRACE_S`): 擦写可能在命令
            # 还在途中就开始了, 而这一条命令本身可能一直不返回。
            self._note_flash_stall()
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
            if m == "reset_factory_params":
                # 同上: 固件要求失能态 (擦写窗口 CPU 停顿, 电机不能无监督保持使能)。
                arm.params.reset_factory()
                return None
            if m == "set_payload":
                arm.set_payload(_num(p, "mass"),
                                _vector(p.get("com") or [0.0, 0.0, 0.0], 3, "com"))
                return None
            if m == "set_gravity_scale":
                arm.set_gravity_scale(_vector(p.get("values"), 7, "values"))
                return None
            if m == "set_inertia_scale":
                arm.set_inertia_scale(_vector(p.get("values"), 7, "values"))
                return None
            if m == "set_gravity_vector":
                arm.set_gravity_vector(_vector(p.get("g"), 3, "g"))
                return None
            if m == "get_ff_vec":
                # ⚠ item 编号**不是猜的**: `arm.set_gravity_scale` 就是 `set_ff_vec(7, …)`,
                # `set_inertia_scale` 就是 `set_ff_vec(8, …)` (见 SDK 的 arm.py)。
                return statemap.jsonable(arm.get_ff_vec(_int(p, "item")).value)
            if m == "get_ff_scalar":
                sub_idx = p.get("sub", 0)
                return statemap.jsonable(
                    arm.get_ff_scalar(_int(p, "item"), _int_value(sub_idx, "sub")).value)
            if m == "kin_bench":
                return statemap.jsonable(arm.diag.kin_bench().value)
            if m == "license":
                return _license_dict(arm)
            if m == "activate":
                # ⚠ 唯一出网的一条命令 (见 activation.py 的模块说明)。
                request = activation.build_request(p)
                device_uid = _device_uid(arm)
                if device_uid is None:
                    # ⚠ **不许**退回客户端填的 UID: 那会把注册信息 (个人信息) 发到一个
                    #   没人核实过的 UID 上, 而写入注定失败 (docs/ACTIVATION.md §3:
                    #   UID 必须来自设备的授权记录)。读不到就在这里停下, 不出网。
                    raise activation.ActivationError(*_uid_unavailable(arm))
                if device_uid != request["uid"]:
                    raise activation.ActivationError(
                        "uid_mismatch",
                        f"提交的 UID ({request['uid']}) 不是当前这台机器 ({device_uid})")
                return _submit_license(arm, activation.request_license(
                    self._activation_url, request, expected_uid=device_uid))
            # 白名单与实现**各写一遍**是刻意的: 只在准入处查表的话, 表里加一条而忘了
            # 实现会静默返回 None (前端看到"成功"却什么都没发生)。
            raise UnknownCommandError(m, sorted(COMMANDS))
        except Exception as e:  # noqa: BLE001 - 命令失败是预期结果, 由 server 转成 err
            log.info("命令 %s 失败: %s: %s", m, type(e).__name__, e)
            raise
        finally:
            if m in FLASH_STALL_COMMANDS:
                # ⚠ 返回之后**再**续一段: `0x25`/`0x36` 的 ACK 只表示受理, 真正的擦写
                # 通常发生在这一句之后 (见 `FLASH_STALL_GRACE_S`)。
                self._note_flash_stall()

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


def _int(p: dict, key: str) -> int:
    return _int_value(p.get(key), key)


def _int_value(v: Any, key: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"{key} 需整数")
    return int(v)


def _vector(v: Any, n: int, key: str) -> List[float]:
    """收一个**定长数值向量** —— 长度不对就在这里拒, 不必等固件回 ERR。"""
    if not isinstance(v, (list, tuple)) or len(v) != n:
        raise ValueError(f"{key} 需 {n} 个数值")
    out: List[float] = []
    for x in v:
        if isinstance(x, bool) or not isinstance(x, (int, float)):
            raise ValueError(f"{key} 需 {n} 个数值")
        out.append(float(x))
    return out


#: 授权功能从 1.8.0 起 (见 `docs/ACTIVATION.md` §2)。
_LICENSE_MIN_FW = (1, 8, 0)


def _uid_unavailable(arm: Arm) -> Tuple[str, str]:
    """读不到设备 UID 时的 `(reason, message)`。

    ⚠ 要分两种情况: 固件**本来就没有**授权功能 (1.8.0 之前) 与**这一次没读到**。上游 SDK
    的 `license()` 少传了 `echo_cmd`, 把旧固件回的 `ERR{0x2F,0x00}` 等成了超时 (见
    litearm-python 的 `_wait_keys` 与 `docs/ACTIVATION.md` §4), 于是在当前 SDK 版本里
    两者都表现成"没读到"。这里用固件版本把前者摘出来 —— 否则那台机器的用户拿到的是
    "请检查链路后重试"这句误导话术, 而真正该做的是升级固件。
    """
    ver = getattr(arm, "fw_version", None)
    if ver is not None and tuple(ver) < _LICENSE_MIN_FW:
        return ("firmware_unsupported",
                f"固件 {arm.firmware} 没有授权功能 (需要 "
                f"{_LICENSE_MIN_FW[0]}.{_LICENSE_MIN_FW[1]}.{_LICENSE_MIN_FW[2]} 及以上)")
    return ("device_uid_unavailable",
            "读不到设备授权记录, 无法确认这份凭据属于本机 —— 请检查链路后重试")


def _device_uid(arm: Arm) -> Optional[str]:
    """当前设备的 UID; 读不到 (固件太旧 / 本次无应答) 时 `None`。

    ⚠ 调用方**不许**在 `None` 时退回客户端填的 UID: `activate` 会把注册信息 (个人信息)
    发到那个 UID 上, 而写入注定失败 —— UID 必须来自设备的授权记录
    (`docs/ACTIVATION.md` §3)。正确做法是在出网之前停下, 见 `_uid_unavailable`。
    """
    state = _license_dict(arm)
    return state["uid"] if state.get("supported") is True else None


def _submit_license(arm: Arm, lic: dict) -> dict:
    """把凭据写进设备, 然后**回读确认** —— 成功的 `ACK` 只说明固件答应了。

    回读是这一步唯一的"落位证据" (与 SDK `Arm.activate()` 同一口径)。返回规范化后的
    授权记录, 界面拿到就能直接刷新, 不用再单独查一次。
    """
    arm.activate(cust_id=lic["cust_id"], issued=lic["issued"],
                 flags=lic["flags"], mac=lic["mac"])
    return _license_dict(arm)


def _license_dict(arm: Arm) -> dict:
    """读设备授权记录 → 线上 dict (形状见 `docs/ACTIVATION.md`)。

    `supported` 是**三态**, 不是一个布尔 —— 三者对用户说的话完全不同:

    * `True` —— 读到了记录, 其余字段有效 (未激活时 `cust_id`/`issued`/`flags` 恒 0,
      但 **UID 照回**: 签发凭据用的就是它);
    * `False` —— 固件明确回了 `ERR{0x2F,0x00}`: 这台固件没有授权命令 (太旧);
    * `None` —— 没读到 (本次无应答)。

    ⚠ **今天旧固件走的是 `None` 那条, 不是 `False`**: SDK 的 `license()` 只等
    `RSP_LICENSE(0x4F)` 一条队列, 固件回的那条 `ERR{0x2F,0x00}` 落在它读不到的队列里,
    于是它等满 1s 抛 `MotionTimeoutError` (litearm-python 的 `_wait_keys`; 修法是给那次
    `expect` 补 `echo_cmd`, 属 SDK 仓的另一笔)。这里**必须**把它折成"未确认": 让它冒出去
    的话, 用户看到的是"运动超时", 与"这台固件有没有授权功能"毫不相干。
    """
    try:
        info = arm.license()
    except litearm.UnsupportedByFirmwareError:
        return {"supported": False}
    except litearm.MotionTimeoutError:
        return {"supported": None}
    return {
        "supported": True,
        "state": int(info.state),
        "stateName": info.state_name,
        "activated": bool(info.activated),
        "factoryMode": bool(info.factory_mode),
        "ver": int(info.ver),
        # ⚠ 24 位小写 hex, 与厂商签发器的 `--uid` 参数同一形态 (见 `LicenseInfo.uid_hex`)。
        "uid": info.uid_hex,
        "custId": int(info.cust_id),
        "issued": int(info.issued),
        "flags": int(info.flags),
    }


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
