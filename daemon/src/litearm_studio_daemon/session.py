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

import base64
import binascii
import logging
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional, Tuple

import litearm
from litearm import Arm

from . import statemap
from . import activation
from . import dfu
from . import obs
from . import ports
from .errors import (FirmwareUpgradeError, MotionBusyError,
                     NotConnectedCommandError, PortChangeWhileConnectedError,
                     UpgradeBusyError, UnknownCommandError)

log = logging.getLogger("litearm_studio_daemon.session")

#: `_note_command(trace=...)` 的哨兵 —— 见那里的说明。
_TRACE_UNSET: Any = object()

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

#: 采样记录的抽稀间隔 (秒)。50Hz 的状态轮询**不是**日志: 每一拍都写一条, 10MB 的
#: 文件半小时就见底, 而操作员真正要读的是事件。1Hz 足够画出趋势与"那一刻的读数",
#: 完整的 10Hz 采样仍由页面写在自己的采样表里 (见 `telemetryRecorder`)。
SAMPLE_RECORD_INTERVAL_S = 1.0

#: 采样记录的抽稀间隔 (秒)。50Hz 的状态轮询**不是**日志: 每一拍都写一条, 5MB 的文件
#: 几分钟就见底, 而操作员真正要读的是事件。1Hz 足够画出趋势与"那一刻的读数"; 完整的
#: 10Hz 采样仍由页面写在自己的采样表里 (见 `telemetryRecorder`)。
SAMPLE_RECORD_INTERVAL_S = 1.0

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

#: 固件升级（USB DFU）相关命令 —— 与臂的命令空间分开看。
FIRMWARE_COMMANDS = frozenset({"firmware_inspect", "firmware_upgrade",
                               "firmware_status", "firmware_cancel"})

#: **不依赖机械臂会话**的命令。DFU 期间恰恰没有会话（设备在 ROM bootloader 里），
#: 而"看一眼进度""取消"必须仍然可用 —— 否则升级一开始，界面就再也问不动守护进程了。
#: ⚠ `firmware_upgrade` **不**在这里: 它要先失能、再交棒, 必须有活着的会话。
SESSION_FREE_COMMANDS = frozenset({"firmware_inspect", "firmware_status",
                                   "firmware_cancel",
                                   # 选端口**发生在连接之前**: 连接判定在这里会
                                   # 把"这台机器上有哪些口"变成一句"请先连接设备",
                                   # 而那正是操作员此刻做不到的事。
                                   "list_ports"})

#: 等 `0483:DF11` 枚举出来的上限 (秒)。固件侧从登记到交棒的上界是 100ms, 但 USB
#: **重枚举**要时间 —— 这里等的是枚举, 不是等固件。
DFU_APPEAR_TIMEOUT_S = 10.0

#: 烧完等 CDC 回来并重建会话的上限 (秒)。刻意短于自愈窗口 (60s): 这一步失败要
#: **尽快**告诉操作员"镜像已经写进去了, 只是没接回来", 而不是让他对着进度条干等。
UPGRADE_RECONNECT_WINDOW_S = 30.0

#: 失能之后等状态帧确认 `enabled == False` 的上限 (秒)。
#:
#: ⚠ 不能只发 `disable()` 就往 DFU 跳: SDK 的 `enter_dfu()` 会**现读一帧状态**做
#: 使能态预检, 而那一位要等固件的下一帧才更新。不确认就跳, 会随机撞上
#: `ERR{0x15,0x03}`, 表现为"升级偶发失败"。
UPGRADE_DISARM_TIMEOUT_S = 3.0

#: 上传镜像的 base64 上限 (字节)。1MB Flash 的固件 base64 后约 1.4MB, 4MB 已是余量。
#: 超限要**回一条可读的错误**, 不能让 WS 层直接掐断 —— 掐断的话界面只会看到断连。
MAX_IMAGE_B64 = 4 * 1024 * 1024

#: 记住的已校验镜像份数 (按上传顺序淘汰)。升级只用最后一次上传, 但留几份便于
#: 操作员在"选错了"之后退回去重试, 不必重新上传 (一个大文件 base64 要几 MB)。
KEEP_INSPECTED_IMAGES = 3

#: 命令白名单 —— (方法名 → 中文说明)。**唯一**的准入判据: 表里没有的一律
#: `UnknownCommandError`, 不接受任意方法调用 (计划 3.2)。
COMMANDS: Dict[str, str] = {
    # ---- 设备发现 (界面上的端口下拉; 没连也能问, 见 SESSION_FREE_COMMANDS) ----
    "list_ports": "枚举本机可能的机械臂串口 (STM32 CDC 排最前) → [path, …]",
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
    # ---- 固件升级 (USB DFU; 路线 A) ----
    # ⚠ 这四条**不走** `_run_command`: 升级会把设备从应用态交出去 (进 ROM
    #   bootloader), 而 `_executor` 是给"还在应用态的臂"准备的单线程串行域。
    #   见 `_begin_upgrade` / `_run_upgrade`。
    "firmware_inspect": "离线解析并校验一份固件镜像 (.hex/.bin), 返回摘要与 token "
                        "(不碰设备; 覆盖受保护区 6+7 的镜像直接拒绝)",
    "firmware_upgrade": "开始固件升级: 失能 → 进 DFU → 擦写+读回校验 → 复位 → 重连 "
                        "(进度与结果走 firmware_progress / firmware_result 帧)",
    "firmware_status": "查当前升级进度快照 (会话无关; 界面重连后用它恢复)",
    "firmware_cancel": "请求取消升级 (只在可取消的相位生效; 进入擦写后无效)",
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
                 port_lister: Optional[Callable[[], List[str]]] = None,
                 port_store: Optional[ports.LastPortStore] = None,
                 poll_period: float = POLL_PERIOD_S,
                 state_push_interval: float = STATE_PUSH_INTERVAL_S,
                 link_stale_after: float = LINK_STALE_AFTER_S,
                 reconnect: bool = True,
                 reconnect_period: float = RECONNECT_PERIOD_S,
                 reconnect_window: float = RECONNECT_WINDOW_S,
                 disable_on_exit: bool = True,
                 activation_url: str = activation.DEFAULT_ACTIVATION_URL,
                 sdk_version: str = litearm.__version__,
                 dfu_engine: Any = None) -> None:
        #: 构造时给的端口 —— 空 = 连接时用 `port_finder` (= SDK `find_cdc_port`) 自动发现。
        #: ⚠ `--port` 只是**覆盖**自动发现 (计划 2 节「设备发现」), 所以这里允许 None。
        self._port = port or None
        self._fake = bool(fake)
        #: `--fake` 下假设备是不是"已激活的那台"。False = 未激活 (界面能看到注册表单)。
        #: 只在 `--fake` 下有意义; 命令行那边会拒掉"给了它却没给 --fake"的组合。
        self._fake_activated = bool(fake_activated)
        self._port_finder = port_finder or find_cdc_port
        #: 界面上「端口」下拉的数据源 (`list_ports`)。注入是为了让测试不依赖本机真的
        #: 插着什么 —— 与 `port_finder` 同一个理由。
        self._port_lister = port_lister or ports.list_serial_ports
        #: 上次连上的串口 —— **只是提示**, 见 `_connect_candidates`。测试必须注入
        #: (或由 conftest 把 `LITEARM_STUDIO_ARM_CONFIG` 指到私有路径), 否则会读到
        #: 跑测试那台机器上真实的记录, 还会把假端口写进去。
        self._port_store = port_store if port_store is not None else ports.LastPortStore()
        #: 界面这一次显式选的口 (**一次性**: 用过即清, 见 `_connect_candidates`)。
        self._pending_port: Optional[str] = None
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
        #: 上一次落采样记录的时刻 (见 `SAMPLE_RECORD_INTERVAL_S`)。
        self._last_sample_at = 0.0
        #: 上一次落采样记录的时刻 (见 `SAMPLE_RECORD_INTERVAL_S`)。
        self._last_sample_at = 0.0
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

        #: 烧录引擎。`--fake` 下自动换成同形的假件（升级流程因此**没有硬件也能走通**,
        #: 界面与相位顺序都能验）；测试可以显式注入。生产走 `dfu.engine`。
        self._dfu_engine = dfu_engine or (dfu.fake.FakeEngine() if self._fake
                                          else dfu.engine)
        #: 升级在途。**它是一条安全闸**: 见 `_note_link_lost` 与 `execute`。
        self._upgrading = False
        #: 升级线程 —— 收尾时要知道它还在不在。
        self._upgrade_thread: Optional[threading.Thread] = None
        #: 当前(或最近一次)升级的标识与相位快照, 供 `firmware_status` 恢复界面。
        self._upgrade_job: Optional[str] = None
        self._upgrade_progress: Optional[dict] = None
        self._upgrade_result: Optional[dict] = None
        #: 取消请求 —— 每个 job 一个新 Event。
        self._upgrade_cancel = threading.Event()
        #: 已校验镜像 (token → (blob, summary)), 按上传顺序淘汰。
        self._images: Dict[str, Tuple[bytes, "dfu.ImageSummary"]] = {}
        self._image_order: List[str] = []
        #: 当前 DFU 设备会话 (`DfuDevice` 包装) —— 从"等枚举到"一直用到"复位"。
        #: ⚠ 必须**同一个包装对象**贯穿: 引擎的 `leave()` 与 `flash()` 是同一会话上
        #:   的两步, 中途重建包装会把已释放的 libusb 资源再交回去。
        self._dfu_session: Any = None

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
    def connect(self, port: Optional[str] = None, *,
                trace: Optional[str] = None) -> bool:
        """连接 (幂等) —— 已连接时**是 no-op**, 返回 `True`。

        `port` = **这一次**要连的口 (顶栏下拉里选的那个), 覆盖自动发现与 `--port`。
        只在本次尝试里有效: 用完即清, 下一次不带口的 `connect` 又回到"上次连上的口 →
        自动发现"那条软路径 (见 `_connect_candidates`)。

        ⚠ 显式指定的口**不做退让**: 指定错了就是响亮失败 (`error` 态 + 原因), 不会偷偷
        换成发现到的另一个设备 —— 那会让"我明明指了这个口"变成谎话。界面上"我以为连的
        是这台、其实连的是那台"是这里最坏的失败形状。

        真在跑时: 状态先落 `connecting` 并推一条 `conn`, 再在命令执行器上建会话
        (握手可能几秒), 成功后定关节数、起状态轮询线程、推 `connected`。

        失败**不抛栈**: 会话落到 `error` 并推一条带 `error` 文案的 `conn`, 返回 `False`
        (前端要看到的是"为什么没连上", 不是进程崩)。

        ⚠ 握手期间收到 `disconnect()`/`close()` 时, 这次连接由 `_connect_gen` 作废:
        收尾的 `_open` 会把已建好的 arm 关掉并静默退出, **不会**把状态改回 `connected`。

        ⚠ 已经连着时再指一个**不同**的口会被拒 (`PortChangeWhileConnectedError`), 而不是
        静默忽略: 上一版返回 `True` 却把 `port` 丢掉, 于是"我选了 ACM0"与"链路还在 ACM1"
        同时成立。换口是操作员的决定 —— 先 `disconnect()`, 会话不自己挪链路。
        `port` 为空或正是当前口时仍是幂等 no-op (`main.tsx` 每次页面加载自动发的那条无参
        `connect` 走的就是这条)。

        `trace` 是发起这次连接的浏览器连接标识 (见 `obs.trace`): 有它, 页面上
        "点连接 → 握手 → 成功/失败"这几条记录会归到同一次操作下。可选, 因为
        `Session` 也能在没有服务端的情况下被单测直接驱动。
        """
        requested = (port or "").strip() or None
        with self._lock:
            if self._arm is not None and self._status == "connected":
                # 已经连着: 只有"没指口"或"指的就是当前口"是 no-op。指了别的口必须响亮
                # 失败 —— 见 `PortChangeWhileConnectedError` 的类文档。
                if requested is not None and requested != self._resolved_port:
                    raise PortChangeWhileConnectedError(
                        self._resolved_port or "", requested)
                return True
            if self._status == "connecting":
                return False
            self._pending_port = requested
            self._status = "connecting"
            self._last_error = None
            # 代次在这里落章: `_open`/`_recover_link` 收尾时比对, 对不上说明这次连接
            # (或这次自愈) 已被断开/关闭作废。
            self._connect_gen += 1
            gen = self._connect_gen
        obs.info(obs.CONNECT_STARTED, body="开始连接机械臂",
                 fields={"target": self._port or "auto", "fake": self._fake},
                 trace_id=trace)
        self._broadcast({"t": "conn", **self.arm_info()})

        def _open(gen: int) -> None:
            try:
                targets = self._connect_candidates()
            except Exception as e:  # noqa: BLE001 - 连接失败是**预期结局**之一
                self._connect_failed(e, None, gen)
                return
            last: Optional[BaseException] = None
            for target in targets:
                # 试下一个之前先看看这次连接还算不算数: 用户可能刚按了「断开」, 那就不该
                # 再握着下一个候选口往下试 (`_commit_link` 也会挡, 但这里挡住省一次握手)。
                with self._lock:
                    if self._connect_gen != gen or self._stop.is_set():
                        log.info("连接已被断开/关闭, 放弃剩余的候选口: %s", targets)
                        return
                try:
                    arm = self._dial(target)
                except Exception as e:  # noqa: BLE001 - 见上
                    last = e
                    log.info("连接 %s 失败: %s: %s", target, type(e).__name__, e)
                    obs.emit(obs.CONNECT_FAILED,
                             body=f"连接 {target} 失败: {type(e).__name__}: {e}",
                             fields={"port": target, "phase": "dial",
                                     "error_kind": type(e).__name__},
                             exception=e, trace_id=trace)
                    continue
                self._commit_link(arm, target, gen, trace)
                return
            if last is None:
                last = litearm.TransportError(
                    "未发现 STM32 CDC 设备 (VID:PID 1d50:606f); 请插好设备或用 --port 指定")
            self._connect_failed(last, None, gen)

        # ⚠ 在 trace 上下文**之内**提交: 执行器线程继承提交那一刻的 contextvars,
        # 于是 `_open`/`_commit_link` 里的记录自动带上同一个 trace_id。
        with obs.trace(trace):
            self._executor.submit(_open, gen)
        return True

    def _connect_candidates(self) -> List[str]:
        """这次 `connect()` 按顺序试哪些口 —— **自动发现 / `--port` / 界面选口 / 上次
        连上的口** 四者的唯一判据点。

        三层, 语义刻意不同:

        * `--fake` ⇒ 占位口 (真机端口在假传输上没有意义);
        * **显式指定** (`--port`, 或界面这一次选的口) ⇒ **只有它**: 指定错了就该响亮
          失败, 不许偷偷换成自动发现到的另一个设备 —— 那会让"我明明指了这个口"变成
          谎话。这条纪律由 `test_session.test_connect_without_device_...` 与
          `test_ports.*` 钉住。
        * 其余 ⇒ **上次连上的口** (软提示, 可能已经被重新枚举成别的节点名) →
          自动发现。与自愈那条 (`_recover_candidates`) 同一口径: 它的职责是"把这台臂
          找回来", 所以允许退回发现。

        ⚠ 界面选的口**一次性**: 读走就清。留着的话, 之后客户端自动发的无参 `connect`
          会被一次早就过期的选择锁死 (哪怕那个口已经消失), 而那正是"上次连上的口"这条
          软路径要解决的问题。
        """
        with self._lock:
            chosen, self._pending_port = self._pending_port, None
            fixed = self._port
        if self._fake:
            # ⚠ 注入工厂时**必须**同时给占位端口: SDK 的 `find_cdc_port()`
            # 空值检查排在注入点**之前** (见 `Arm.__init__` 的说明), 没有端口会
            # 在走到工厂之前就抛 TransportError。
            return [chosen or fixed or "fake"]
        if chosen or fixed:
            return [chosen or fixed]
        out: List[str] = []
        for cand in (self._port_store.last_port(), self._port_finder()):
            if cand and cand not in out:
                out.append(cand)
        return out

    def _dial(self, target: str) -> Arm:
        """按端口建一条链路 —— `connect()` 与断线自愈**共用**的唯一构造点。"""
        factory = (build_fake_transport_factory(activated=self._fake_activated)
                   if self._fake else None)
        return Arm(port=target, transport_factory=factory).connect()

    def _commit_link(self, arm: Arm, target: str, gen: int,
                     trace: Optional[str] = None) -> bool:
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
            obs.emit(obs.CONNECT_DISCARDED,
                     body=f"链路建成时已被断开/关闭, 丢弃 {target}",
                     fields={"port": target, "reason": "disconnected_during_handshake"},
                     trace_id=trace)
            self._close_arm(arm)
            return False
        # 记住这个口 —— 下次启动/不带口的连接先试它 (只是提示, 见 `_connect_candidates`)。
        # ⚠ 只在**连上之后**记: 记一个连不通的口, 会让下一次的默认选择和"上次能用"无关。
        # ⚠ 放在锁外: 这是文件 I/O, 不该占着会话锁。代价是 `connected` 比这一笔**先**
        #   被看见 (状态在上面那个锁块里就发布了)。这是可接受的: 唯一读这条记录的是
        #   `_connect_candidates`, 而它只在 `connect()` 里被调用, `connect()` 又跑在同一
        #   条单线程执行器上 —— 下一次连接必然排在这次 `_open` 之后, 那时这一笔已经落地。
        self._port_store.remember(target)
        try:
            log.info("已连接: port=%s firmware=%s n=%d cart=%s",
                     target, arm.firmware, arm.n,
                     getattr(arm, "_cart_supported", None))
            obs.info(obs.CONNECT_SUCCEEDED,
                     body=f"已连接: {target} (固件 {arm.firmware or '未识别'}, "
                          f"{int(getattr(arm, 'n', 0) or 0)} 轴)",
                     fields={"port": target, "firmware": arm.firmware or "",
                             "n": int(getattr(arm, "n", 0) or 0),
                             "cart": bool(getattr(arm, "_cart_supported", False)),
                             "fake": self._fake},
                     trace_id=trace)
            self._broadcast({"t": "conn", **self.arm_info()})
            self._start_polling()
        except Exception as e:  # noqa: BLE001
            log.exception("连接收尾失败 (已转为 error 态)")
            obs.error(obs.CONNECT_FAILED, body=f"连接收尾失败: {type(e).__name__}: {e}",
                      fields={"port": target, "phase": "commit"},
                      exception=e, trace_id=trace)
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
                obs.info(obs.DISCONNECTED, body="断开 (当时没有链路)",
                         fields={"cancelled": bool(was_busy)})
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
            closed_port = self._resolved_port
            self._resolved_port = None
        obs.info(obs.DISCONNECTED, body="已断开机械臂连接",
                 fields={"port": closed_port, "had_link": arm is not None})
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
                obs.emit(obs.CONNECT_DISCARDED,
                         body="握手失败, 但这次连接已被断开/关闭作废",
                         fields={"error_kind": type(exc).__name__,
                                 "reason": "superseded"},
                         exception=exc)
                return
            self._arm = None
            self._status = "error"
            self._last_error = f"{type(exc).__name__}: {exc}"
            self._resolved_port = None
        log.warning("连接失败: %s", self._last_error)
        obs.error(obs.CONNECT_FAILED, body=f"连接失败: {self._last_error}",
                  fields={"port": self._port or "auto", "fake": self._fake,
                          "error_kind": type(exc).__name__},
                  exception=exc)
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
            # ⚠ 升级在途时链路"消失"是**我们主动把设备交出去的**, 不是掉线。这时起
            #   自愈线程去重连, 会跟烧录器抢同一个 USB 设备; 而升级线程自己负责把
            #   设备接回来 (见 `_upgrade_reconnect`)。这是本功能最容易踩的一处:
            #   少了这条, 升级必然与自愈打架。
            if self._upgrading:
                return False
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
        obs.warning(obs.LINK_LOST,
                    body=f"链路已断开 ({last_port or '未知端口'}): {reason}",
                    fields={"port": last_port, "reason": reason,
                            "auto_reconnect": bool(reconnect)})
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
        """自愈时按什么顺序试哪些口 —— 与 `_connect_candidates` 的差别见那里。

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

    def _recover_link(self, gen: int, hint: Optional[str], old_arm: Arm,
                      trace: Optional[str] = None) -> None:
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
                        obs.info(obs.RECOVER_FAILED,
                                 body=f"自愈第 {attempts} 次尝试失败: {last_detail}",
                                 fields={"port": target, "attempt": attempts,
                                         "error_kind": type(e).__name__},
                                 trace_id=trace)
                        continue
                    if self._commit_link(arm, target, gen, trace):
                        log.info("链路已恢复: port=%s (第 %d 次尝试)", target, attempts)
                        obs.info(obs.LINK_RECOVERED,
                                 body=f"链路已恢复: {target} (第 {attempts} 次尝试)",
                                 fields={"port": target, "attempt": attempts},
                                 trace_id=trace)
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
            obs.error(obs.RECOVER_GAVE_UP, body=f"自动重连失败: {self._last_error}",
                      fields={"attempts": attempts,
                              "window_s": round(self._reconnect_window, 1),
                              "detail": last_detail or "没有发现可用的 STM32 CDC 设备"},
                      trace_id=trace)
            self._broadcast({"t": "conn", **self.arm_info()})
        except Exception as e:  # noqa: BLE001 - 自愈线程不许带着栈死掉
            # 设备发现 (用户注入的 `port_finder`) 或 SDK 构造都可能抛意料之外的东西。
            # 会话留在 `error` 态 (下面 finally 会落下 `_recovering`), 由操作员手工重连。
            log.exception("断线自愈异常结束 (会话停在 error 态, 需手工重连)")
            obs.error(obs.RECOVER_ERROR,
                      body=f"断线自愈异常结束, 会话停在 error 态: {type(e).__name__}: {e}",
                      fields={"error_kind": type(e).__name__},
                      exception=e, trace_id=trace)
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
        obs.info(obs.SESSION_CLOSED, body="守护进程收尾: 会话已关闭",
                 fields={"had_link": arm is not None})

    def _deenergize(self, arm: Arm) -> None:
        """退出前的降能量 —— **任何失败都只记日志**, 收尾不能因此中断。

        用 `disable` 而不是 `estop`: 后者会锁存一个急停故障, 下次连接还得先清错;
        正常退出要的是"掉力矩", 不是"制造故障"。

        ⚠ 本方法在 `close()` 里、主执行器已经排空之后调用, 所以不与在途命令抢链路;
        链路已断时 `disable()` 会抛, 那正是"只能记日志"的场景。
        """
        if not self._disable_on_exit:
            log.info("退出前保持使能 (disable_on_exit=False)")
            obs.info(obs.DEENERGIZE_SKIPPED, body="退出前保持使能 (--keep-enabled)",
                     fields={"disable_on_exit": False})
            return
        try:
            arm.disable()
            log.info("退出前已失能 (降能量)")
            obs.info(obs.DEENERGIZED, body="退出前已失能 (降能量)")
        except Exception as e:  # noqa: BLE001 - 链路可能已断, 收尾不许因此失败
            log.warning("退出前失能失败 (已忽略; 链路可能已断)", exc_info=True)
            obs.warning(obs.DEENERGIZE_FAILED,
                        body=f"退出前失能失败 (已忽略; 链路可能已断): {type(e).__name__}",
                        fields={"error_kind": type(e).__name__}, exception=e)

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
            # ⚠ 采样记录的节拍与**推送**节拍是两件事: 推送 50Hz/变化即推, 采样 1Hz。
            sample_due = (now - self._last_sample_at) >= SAMPLE_RECORD_INTERVAL_S
            if sample_due:
                self._last_sample_at = now
        if sample_due:
            # 记录在锁外发: `obs.emit` 要走广播扇出, 不该在持有会话锁时做。
            self._note_sample(doc)
        return {"t": "state", "stamp": round(now, 4), "state": doc}

    def _note_sample(self, doc: dict) -> None:
        """把这一拍的状态落成一条**采样记录** —— 与事件同一套 schema, `kind=sample`。

        ⚠ 它只写 `fields`, 不写 `body` 之外的任何文本: 采样是数值记录, 页面要拿它画
        趋势、算最大值, 不是拿它读句子。
        """
        obs.debug(obs.STATE_SAMPLE, body=f"state={doc.get('state', '')}",
                  fields=sample_fields(doc))

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
                on_event: Optional[Callable[[dict], None]] = None,
                trace: Optional[str] = None) -> Any:
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

        ⚠ **一条命令一条记录** (issue #79 第 3、4 点): 这里是"方法发出 / 值或异常返回"的
        唯一漏斗, 所以 SDK 交互的台账记在这里, 而不是在每个命令实现里各补一次。
        `arm.command.succeeded` 对读操作是 DEBUG (10Hz 的 `get_tcp` 不该写进文件),
        对真正改变机器的命令是 INFO; 失败一律 ERROR。参数经 `obs` 脱敏后才落盘。
        """
        params = dict(p or {})
        span = obs.new_span_id()
        started = time.perf_counter()
        with obs.span(span), obs.trace(trace):
            try:
                value = self._execute_command(m, params, on_event=on_event)
            except Exception as e:  # noqa: BLE001 - 失败照旧往上抛, 这里只记台账
                self._note_command(m, params, None, e,
                                   duration_ms=(time.perf_counter() - started) * 1000,
                                   span=span, trace=trace)
                raise
            self._note_command(m, params, value, None,
                               duration_ms=(time.perf_counter() - started) * 1000,
                               span=span, trace=trace)
            return value

    def _execute_command(self, m: str, params: dict, *,
                         on_event: Optional[Callable[[dict], None]]) -> Any:
        """`execute` 的准入与派发 —— 拆出来只为让台账那一段包住整个调用。"""
        # 会话无关的命令 —— **排在连接判定之前**。DFU 期间设备在 ROM bootloader 里,
        # 恰恰没有会话, 而"校验镜像 / 看进度 / 取消"必须仍然可用。
        if m in SESSION_FREE_COMMANDS:
            return self._run_session_free(m, params)

        with self._lock:
            arm = self._arm
            # ⚠ 升级在途时**先**给 `UpgradeBusyError`, 再谈连接态: 那段时间
            #   `_status` 已经是 `upgrading`, 落到 NotConnected 会把"现在不能下命令"
            #   说成"你没连设备" —— 操作员据此会去点「连接」, 而那正是最不该做的事。
            #   降能量动作(急停/失能)例外, 与运动互斥同一条纪律。
            if self._upgrading and m not in ENERGY_DOWN_COMMANDS:
                raise UpgradeBusyError(m)
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
            if m == "activate":
                # ⚠ 激活**不占**命令执行器等网络, 见 `_activate` 的两段式说明。
                return self._activate(arm, params)
            if m == "firmware_upgrade":
                # ⚠ 升级**不占**命令执行器, 也不在这里阻塞: 它返回后进程就交给
                #   ROM bootloader 了, 进度与结果只能走广播帧 (见 `_begin_upgrade`)。
                return self._begin_upgrade(arm, params)
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

    def _note_command(self, m: str, params: dict, value: Any,
                      exc: Optional[BaseException], *, duration_ms: float,
                      span: str, trace: Any = _TRACE_UNSET) -> None:
        """一条命令的台账 —— 成功与失败都走这里。

        ⚠ 参数**必须**经 `obs.redact.command_arguments`: 激活请求带着操作员的注册信息
        与设备 UID, 固件升级带着镜像 token。脱敏是构造性的 (见 `obs.redact` 的模块说明),
        这里的 `fields` 就是它唯一的入口。会话无关的命令 (`firmware_inspect` 等) 同样
        走这里 —— 它们的参数是**最**需要脱敏的一类。
        """
        fields: Dict[str, Any] = {
            "method": m,
            "outcome": "ok" if exc is None else "error",
            "duration_ms": round(float(duration_ms), 1),
            "span_id": span,
            "args": obs.redact_command_arguments(m, params),
        }
        if exc is not None:
            fields["error_kind"] = type(exc).__name__
        else:
            fields["result"] = obs.describe_value(value)
        event = obs.COMMAND_SUCCEEDED if exc is None else obs.COMMAND_FAILED
        notable = (m in obs.NOTABLE_COMMANDS) or exc is not None
        body = (f"命令 {m} 完成 ({fields['duration_ms']:.0f}ms)" if exc is None
                else f"命令 {m} 失败: {type(exc).__name__}: {exc}")
        # ⚠ `trace` 的默认值是哨兵而不是 `None`: "调用方明确给了没有 trace" 与
        # "调用方没表态" 是两件事 —— 后者要回落到**当前上下文**里的 trace (浏览器
        # 那条连接绑定的), 否则从 WS 来的命令会丢掉自己的 trace_id。
        obs.emit(event, body=body, fields=fields, exception=exc,
                 severity=None if notable else "DEBUG",
                 level=None if notable else "DEBUG", span_id=span,
                 trace_id=obs.current_trace() if trace is _TRACE_UNSET else trace)

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
            # ⚠ `activate` **不在这里**: 它要拆成"SDK → 网络 → SDK"三段, 由
            #   `Session._activate` 处理 (见那里的说明)。白名单里仍然有它。
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

    def _sdk_call(self, arm: Arm, fn: Callable[[], Any], method: str) -> Any:
        """在命令执行器上跑一段 SDK 访问 —— 与其它 SDK 调用严格串行。

        ⚠ 传输层失败要当场把链路判死: 与 `execute` 的通用分支同一条纪律 (issue #48)。
        """
        try:
            return self._executor.submit(fn).result()
        except litearm.TransportError as e:
            self._note_link_lost(arm, f"命令 {method} 失败: {type(e).__name__}: {e}")
            raise

    def _activate(self, arm: Arm, p: dict) -> dict:
        """在线激活 —— **两段式**: SDK 访问走命令执行器, 网络那一段**不占它**。

        ⚠ 为什么要拆: `_executor` 是单线程的, 而一次激活最坏要等十几秒 (读授权记录在旧
        固件上必等满 1s 超时 + HTTP 超时 10s + 写入 2s + 回读 1s)。占着执行器, 操作员在
        这十几秒里连 `movej` 都发不出去 —— 急停/失能仍然可达 (见 `ENERGY_DOWN_COMMANDS`),
        但"能急停"不等于"能动一下"。

        ⚠ 拆开的代价: 等网络这段时间别的命令可以插进来 (最要紧的是 `enable`), 于是写入
        可能拿到 `ERR{0x3F,0x04}`。那是固件的门禁在说话 —— 如实报给操作员即可, 见
        `docs/ACTIVATION.md` §7。

        返回写入后的**回读记录**: 回读才是"落位"的证据 (ACK 只说明固件答应了)。
        """
        try:
            # ⚠ 唯一出网的一条命令 (见 activation.py 的模块说明)。
            request = activation.build_request(p)
            device_uid = self._sdk_call(arm, lambda: _device_uid(arm), "activate")
            if device_uid is None:
                # ⚠ **不许**退回客户端填的 UID: 那会把注册信息 (个人信息) 发到一个没人
                #   核实过的 UID 上, 而写入注定失败 (docs/ACTIVATION.md §3: UID 必须来自
                #   设备的授权记录)。读不到就在这里停下, 不出一字节。
                raise activation.ActivationError(*_uid_unavailable(arm))
            if device_uid != request["uid"]:
                # ⚠ 消息里**不写两个 UID**: 它是激活服务认的凭据, 而这条消息会进日志文件
                # (issue #79 第 6 点)。前端拿到的是"不一致"这件事, 不是一个可以外传的标识。
                raise activation.ActivationError(
                    "uid_mismatch",
                    "提交的设备 UID 与当前这台机器不一致 —— 请重新读取设备信息后重试")
            # ↓ 这一段在**调用方线程**上跑: 它不碰串口, 不该占着 SDK 那条线程。
            lic = activation.request_license(
                self._activation_url, request, expected_uid=device_uid)
            written = self._sdk_call(arm, lambda: _submit_license(arm, lic), "activate")
            obs.info(obs.ACTIVATE_SUCCEEDED,
                     body=f"在线激活成功 (设备状态 {written.get('stateName', '未知')})",
                     fields={"state": written.get("state"),
                             "state_name": written.get("stateName"),
                             "factory_mode": bool(written.get("factoryMode")),
                             "activation_url": self._activation_url})
            return written
        except Exception as e:  # noqa: BLE001 - 命令失败是预期结果, 由 server 转成 err
            log.info("命令 activate 失败: %s: %s", type(e).__name__, e)
            obs.error(obs.ACTIVATE_FAILED, body=f"在线激活失败: {type(e).__name__}: {e}",
                      fields={"error_kind": type(e).__name__,
                              "reason": getattr(e, "reason", None)},
                      exception=e)
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

    # ------------------------------------------------------------------ 固件升级
    # 这一段的形状与别的命令**刻意不同**, 三条理由:
    #   1. 它跨两个会话 (应用态 CDC → ROM bootloader → 又是应用态), 所以不能用
    #      `_executor` 那条"给还在应用态的臂准备"的单线程域;
    #   2. 它可能跑几十秒 (擦 128KB 扇区 + 写 + 读回), 超过 `COMMAND_TIMEOUT_S`,
    #      所以命令**立即返回**, 进度与结果走广播帧;
    #   3. 它会把设备交出去, 而 `_status` 在那段时间不再是 connected —— 于是
    #      "看进度/取消"必须是不依赖会话的命令 (见 `SESSION_FREE_COMMANDS`)。

    def _run_session_free(self, m: str, p: dict) -> Any:
        """不依赖机械臂会话的几条 —— 在连接判定之前被分派 (见 `execute`)。"""
        if m == "list_ports":
            # 列的是**这台机器**上可能是这台臂的串口, 与当前有没有连上无关。
            return self._port_lister()
        if m == "firmware_inspect":
            return self._inspect_image(p)
        if m == "firmware_status":
            return self._upgrade_status()
        if m == "firmware_cancel":
            return self._cancel_upgrade()
        raise UnknownCommandError(m, sorted(COMMANDS))

    def _inspect_image(self, p: dict) -> dict:
        """离线校验一份上传的镜像 → 摘要 + token。**不碰设备**。

        分成"先校验、再升级"两步是刻意的: 操作员要在动手之前看见
        "这是哪个版本、多大、会不会碰到许可证扇区", 而校验失败必须发生在
        **任何硬件动作之前**。
        """
        data = p.get("data")
        if not isinstance(data, str) or not data:
            raise dfu.ImageError("image_unreadable", "请求里没有镜像数据 (p.data)")
        if len(data) > MAX_IMAGE_B64:
            raise dfu.ImageError(
                "image_too_large",
                f"上传的镜像太大 ({len(data)} B base64, 上限 {MAX_IMAGE_B64} B) —— "
                f"固件不可能超过 1 MB Flash")
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as e:
            raise dfu.ImageError("image_unreadable", f"镜像数据不是合法 base64: {e}")
        name = str(p.get("name") or "firmware").strip() or "firmware"
        blob, summary = dfu.inspect(name, raw)
        token = secrets.token_urlsafe(12)
        with self._lock:
            self._images[token] = (blob, summary)
            self._image_order.append(token)
            while len(self._image_order) > KEEP_INSPECTED_IMAGES:
                self._images.pop(self._image_order.pop(0), None)
        log.info("固件镜像已校验: %s (%d B, 版本 %s)",
                 summary.name, summary.size, summary.version or "未识别")
        obs.info(obs.IMAGE_INSPECTED,
                 body=f"固件镜像已校验: {summary.name} ({summary.size} B, "
                      f"版本 {summary.version or '未识别'})",
                 fields={"name": summary.name, "size": summary.size,
                         "version": summary.version or "",
                         "base": summary.base})
        return {**summary.to_dict(), "token": token}

    def _upgrade_status(self) -> dict:
        """当前升级快照 —— 界面重连之后靠它把进度条接回去。

        ⚠ `running` 是**必需的**，不是可有可无的装饰：没有它，界面分不清"这次还在跑"
        与"上一次已经结束" —— 两者都带着最后一条进度的相位（结束那次是 `done`），
        于是刷新页面会看到"升级进行中 · 完成"这种自相矛盾的话。
        """
        ready = bool(self._dfu_engine.available())
        engine = self._dfu_engine.backend_status()
        with self._lock:
            job = self._upgrade_job
            progress = dict(self._upgrade_progress or {})
            result = self._upgrade_result
            running = self._upgrading
        if job is None:
            return {"job": None, "engine": engine, "engineReady": ready,
                    "running": False}
        return {"job": job, "engine": engine, "engineReady": ready,
                "running": running,
                "phase": progress.get("phase"),
                "done": progress.get("done", 0),
                "total": progress.get("total", 0),
                "detail": progress.get("detail", ""),
                "result": result}

    def _cancel_upgrade(self) -> dict:
        """请求取消。**只在相位之间与等待类相位生效** —— 见 `job.run_upgrade`。"""
        with self._lock:
            active = self._upgrading
        if not active:
            return {"cancelled": False, "reason": "not_running"}
        self._upgrade_cancel.set()
        return {"cancelled": True}

    def _begin_upgrade(self, arm: Arm, p: dict) -> dict:
        """校验请求 → 起升级线程 → **立刻返回** (进度走广播帧)。"""
        token = str(p.get("token") or "")
        with self._lock:
            if self._upgrading:
                raise UpgradeBusyError("firmware_upgrade")
            entry = self._images.get(token)
        if entry is None:
            raise FirmwareUpgradeError(
                "image_unreadable",
                "这份镜像不在已校验列表里 (可能已过期) —— 请重新选择文件")
        if p.get("confirm") is not True:
            raise FirmwareUpgradeError(
                "confirm_required",
                "缺少确认标记 (p.confirm) —— 升级会先失能, 机械臂失去支撑会下垂")
        ready = bool(self._dfu_engine.available())
        if not ready:
            # ⚠ 在**任何硬件动作之前**说清缺什么。等跳进 DFU 才发现没引擎, 板子
            #   已经停在 bootloader 里了, 那种失败最难收场。
            raise FirmwareUpgradeError("engine_unavailable",
                                       self._dfu_engine.backend_status())

        blob, summary = entry
        job = f"fw-{secrets.token_hex(4)}"
        with self._lock:
            self._upgrading = True
            self._upgrade_job = job
            self._upgrade_progress = {"phase": dfu.PHASE_VALIDATE, "done": 0,
                                      "total": summary.size, "detail": ""}
            self._upgrade_result = None
            self._upgrade_cancel = threading.Event()
            self._dfu_session = None
            # 顶栏据此显示"正在升级"; `connected` 也随之转 False —— 那是对的,
            # 设备马上就不在应用态了。
            self._status = "upgrading"
            self._last_error = None
        self._broadcast({"t": "conn", **self.arm_info()})

        th = threading.Thread(target=self._run_upgrade,
                              args=(blob, summary.base, summary, job),
                              name="litearm-dfu", daemon=True)
        with self._lock:
            self._upgrade_thread = th
        th.start()
        log.info("固件升级开始: job=%s 镜像=%s (%d B)",
                 job, summary.name, summary.size)
        obs.info(obs.UPGRADE_STARTED,
                 body=f"固件升级开始: {summary.name} ({summary.size} B)",
                 fields={"job": job, "name": summary.name, "size": summary.size,
                         "version": summary.version or ""})
        return {"job": job, "phase": dfu.PHASE_VALIDATE}

    def _run_upgrade(self, blob: bytes, base: int, summary: Any, job: str) -> None:
        """升级线程主体 —— **不许让异常逃出去** (逃出去就只剩一条 WS 断连)。"""
        def emit(progress: "dfu.Progress") -> None:
            doc = progress.to_dict(job)
            with self._lock:
                self._upgrade_progress = doc
            self._broadcast({"t": "firmware_progress", **doc})

        try:
            result = dfu.run_upgrade(blob=blob, base=base, summary=summary,
                                     hooks=_DfuHooks(self), emit=emit,
                                     is_cancelled=self._upgrade_cancel.is_set)
        except Exception as e:                                 # noqa: BLE001
            # `run_upgrade` 自己已经把一切折成 `Result`; 这一层是"连兜底都炸了"的
            # 最后一道 —— 宁可报一句笼统的失败, 也不能让线程带着栈死掉。
            log.exception("固件升级线程异常结束")
            obs.error(obs.UPGRADE_CRASHED,
                      body=f"固件升级线程异常结束: {type(e).__name__}: {e}",
                      fields={"job": job, "error_kind": type(e).__name__},
                      exception=e)
            result = dfu.Result(False, "flash_failed", f"{type(e).__name__}: {e}")

        doc = result.to_dict(job)
        with self._lock:
            self._upgrading = False
            self._upgrade_result = doc
            self._upgrade_thread = None
            if not result.ok and self._arm is None:
                # 没接回来 ⇒ 会话停在 error 态, 前端顶栏该变红并说明原因。
                self._status = "error"
                self._last_error = f"固件升级失败: {result.message}"
        log.info("固件升级结束: job=%s ok=%s reason=%s", job, result.ok, result.reason)
        (obs.info if result.ok else obs.error)(
            obs.UPGRADE_FINISHED,
            body=f"固件升级{'成功' if result.ok else '失败'}: {result.reason}",
            fields={"job": job, "ok": bool(result.ok), "reason": result.reason,
                    "message": result.message,
                    "reconnected": self._arm is not None})
        self._broadcast({"t": "firmware_result", **doc})
        self._broadcast({"t": "conn", **self.arm_info()})

    # ---- `dfu.UpgradeHooks` 的实际动作 (由 `_DfuHooks` 适配) ----
    #
    # ⚠ 这一段抛的是 `dfu.UpgradeError`（**流水线内部**的失败类型），不是本模块的
    #   `FirmwareUpgradeError`（那是"还没开跑就被拒"的类型，走 `err` 应答）。
    #   两者同名不同类，选错的话 `job.run_upgrade` 的 `except UpgradeError` 接不住，
    #   结果会退化成笼统的 `flash_failed` —— 短码丢失，界面说不出是哪一步坏的。

    def _upgrade_arm(self) -> Arm:
        with self._lock:
            arm = self._arm
        if arm is None:
            raise dfu.UpgradeError("not_connected", "会话未连接 —— 请先连接设备")
        return arm

    def _dfu_disarm(self) -> None:
        """失能, 并**等状态帧确认**。见 `UPGRADE_DISARM_TIMEOUT_S`。"""
        arm = self._upgrade_arm()
        self._sdk_call(arm, lambda: arm.disable(), "firmware_upgrade")
        deadline = time.monotonic() + UPGRADE_DISARM_TIMEOUT_S
        while time.monotonic() < deadline:
            st = self._sdk_call(arm, lambda: arm.get_state(refresh=True).value,
                                "firmware_upgrade")
            if st is None or not bool(getattr(st, "enabled", False)):
                # 读不到状态帧就**不拦**: 门禁的权威在固件 (`enabled || enable_pending`
                # 一律回 0x03), 本地预检只为可读性。
                return
            time.sleep(0.05)
        raise dfu.UpgradeError(
            "arm_enabled",
            f"机械臂在 {UPGRADE_DISARM_TIMEOUT_S:.0f}s 内没有失能 —— 不冒险进入 DFU "
            f"(跳转会停 TIM3, 电机 100ms 松开, 有重力负载会下垂)")

    def _dfu_enter(self) -> None:
        """发 `0x15` 并等设备真的离开 CDC, 然后把本会话的 `Arm` 放掉。"""
        arm = self._upgrade_arm()
        # `enter_dfu()` 成功返回时设备**已经**从 CDC 消失, 且该 `Arm` 进终态。
        self._sdk_call(arm, lambda: arm.enter_dfu(), "firmware_upgrade")
        with self._lock:
            self._arm = None
            self._resolved_port = None
            # 最后一帧好数据也要清掉: 设备已经不在应用态了。
            self._state = None
            self._state_dict = None
            self._state_stamp = 0.0
            self._last_emit_key = None
        log.info("固件升级: 设备已交棒进 ROM bootloader")
        obs.info(obs.ENTERED_BOOTLOADER, body="固件升级: 设备已交棒进 ROM bootloader")

    def _dfu_wait(self, is_cancelled: Callable[[], bool]) -> None:
        """等 `0483:DF11` **可用**（不只是"存在"）, 并把引擎会话**开好**。

        ⚠ **"存在" ≠ "可用"** —— 这是真机演练抓到的。设备一 attach，内核先建出
        `/dev/bus/usb/001/00X`（默认 `root:root 0644`），**udev 随后才**按规则 chmod
        成 0666。而 pyusb 靠 sysfs 枚举，在这个窗口里已经能 `find_device()` 到它 ——
        于是 `open()` 拿到 `[Errno 13] Access denied`，现象是"设备明明在 DFU，却报没权限"。

        所以这里不能只等"枚举出来"，必须**真开一次**；开不了就继续等（udev 只慢几十毫秒）。
        这个竞态与 WSL 无关：任何 Linux 主机上刚热插拔完都可能撞上。
        """
        if not self._dfu_engine.available():
            raise dfu.UpgradeError("engine_unavailable",
                                   self._dfu_engine.backend_status())
        deadline = time.monotonic() + DFU_APPEAR_TIMEOUT_S
        denied = False
        while time.monotonic() < deadline:
            if is_cancelled():
                raise dfu.UpgradeError("cancelled", "已取消")
            dev = self._dfu_engine.find_device()
            if dev is not None:
                session = self._dfu_engine.DfuDevice(dev)
                try:
                    session.open()
                except Exception as e:                             # noqa: BLE001
                    # 权限还没到位 ⇒ 继续等下一轮；别的错直接抛出去（别把真故障说成"没等到设备"）。
                    if not _is_permission_error(e):
                        raise
                    denied = True
                    time.sleep(0.2)
                    continue
                with self._lock:
                    self._dfu_session = session
                return
            time.sleep(0.2)
        if denied:
            raise dfu.UpgradeError(
                dfu.REASON_DFU_PERMISSION,
                "DFU 设备在, 但当前用户打不开它 (打开时报 Access denied)。"
                "Linux 上需要一条 udev 规则："
                'SUBSYSTEM=="usb", ATTR{idVendor}=="0483", '
                'ATTR{idProduct}=="df11", MODE="0666"')
        raise dfu.UpgradeError(
            "dfu_device_absent",
            f"等 {DFU_APPEAR_TIMEOUT_S:.0f}s 没等到 DFU 设备 (0483:DF11) —— "
            f"检查 USB 线; Windows 上还需要 ST 的 WinUSB 驱动")

    def _dfu_flash(self, blob: bytes, base: int,
                   on_progress: Callable[[int, int, str], None]) -> None:
        with self._lock:
            session = self._dfu_session
        if session is None:
            raise dfu.UpgradeError("dfu_device_absent", "没有可用的 DFU 设备")
        # ⚠ 会话在 `_dfu_wait` 里**已经开好**了（见那里的"存在≠可用"）。这里再
        #   `open()` 一次不但多余，还会把那个竞态重新引回来。
        # ⚠ `param_policy="abort"`: `image.inspect` 已经拦过一道, 这里让引擎**自己**
        #   再拦一道。许可证 (扇区 6) 与出厂标定 (扇区 7) 只存在于设备上, 擦掉不可
        #   恢复 —— 两道判据都留着, 因为这一处的代价是不可逆的。
        session.flash(blob, base, progress=on_progress,
                      param_policy="abort", verify=True)

    def _dfu_detach(self) -> None:
        with self._lock:
            session, self._dfu_session = self._dfu_session, None
        if session is not None:
            session.leave(reset=True)

    def _dfu_reconnect(self, is_cancelled: Callable[[], bool]) -> Tuple[str, str]:
        """等 CDC 回来并以**新 `Arm`** 重建会话 —— 旧的那个已进终态, 不可复用。"""
        with self._lock:
            gen = self._connect_gen
            hint = self._resolved_port or self._port
        deadline = time.monotonic() + UPGRADE_RECONNECT_WINDOW_S
        attempts = 0
        last = ""
        while time.monotonic() < deadline:
            if is_cancelled():
                raise dfu.UpgradeError("cancelled", "已取消 (镜像已写入)")
            if self._stop.is_set():
                raise dfu.UpgradeError("cancelled", "守护进程正在收尾")
            attempts += 1
            for target in self._recover_candidates(hint):
                try:
                    arm = self._dial(target)
                except Exception as e:  # noqa: BLE001 - 设备还没回来是**预期结局**
                    last = f"{target}: {type(e).__name__}: {e}"
                    continue
                if self._commit_link(arm, target, gen):
                    log.info("升级后链路已恢复: port=%s (第 %d 次尝试)", target, attempts)
                    obs.info(obs.FIRMWARE_LINK_RESTORED,
                             body=f"升级后链路已恢复: {target} (第 {attempts} 次尝试)",
                             fields={"port": target, "attempt": attempts,
                                     "firmware": getattr(arm, "firmware", "") or ""})
                    return target, getattr(arm, "firmware", "") or ""
                raise dfu.UpgradeError("reconnect_failed", "重建会话时被断开/收尾")
            self._stop.wait(self._reconnect_period)
        raise dfu.UpgradeError(
            "reconnect_failed",
            f"固件已写入并通过读回校验, 但 {UPGRADE_RECONNECT_WINDOW_S:.0f}s 内没能"
            f"重新连上 ({attempts} 次): {last or '没有发现 STM32 CDC 设备'} —— "
            f"断电重上电即可")


#: 采样记录里保留的状态字段。**刻意不是全部**: `flagNames`/`faultDetail` 这类给人读的
#: 文本每一条都带着, 文件会胖一倍, 而它们在事件 (`conn` 帧与故障记录) 里已经有了。
SAMPLE_FIELDS = ("q", "dq", "tau", "errs", "temps", "fault", "state",
                 "enabled", "faulted", "cartBusy", "seq", "mode", "modeName")


def sample_fields(doc: dict) -> dict:
    """`state` 帧的字典 → 采样记录要落的那几项。

    ⚠ 白名单而不是整份拷贝: 状态帧的字段会随版本增加, 而"日志文件里突然多出一堆
    没人读的字段"是缓慢发生的体积泄漏。要加一项就在这里加。
    """
    return {key: doc[key] for key in SAMPLE_FIELDS if key in doc}


def _is_permission_error(exc: BaseException) -> bool:
    """异常链里有没有 `EACCES` —— 用来把"打不开设备"与"设备没到"分开。

    ⚠ 判据是 `errno`，**不是**消息文本：引擎会把 libusb 的 `USBError` 包成
    `DfuError`（`raise ... from e`），所以顺着 `__cause__`/`__context__` 找 errno 是
    可靠的；去匹配 `"Access denied"` 这种字符串，换一个 libusb 版本/语言就失效。
    """
    seen: set[int] = set()
    e: Optional[BaseException] = exc
    while e is not None and id(e) not in seen:
        seen.add(id(e))
        if getattr(e, "errno", None) == 13:
            return True
        e = e.__cause__ or e.__context__
    return False


class _DfuHooks:
    """把 `Session` 的 `_dfu_*` 动作适配成 `dfu.UpgradeHooks`。

    单独一个适配器而不是让 `Session` 直接实现那几个方法名: `disarm` / `flash` /
    `detach` 这些名字看起来像臂的命令, 挂在 `Session` 的公开面上会让人以为可以
    随手调用 —— 它们只在升级流水线的相位里有意义。
    """

    def __init__(self, session: "Session"):
        self._s = session

    def disarm(self) -> None:
        self._s._dfu_disarm()

    def enter_dfu(self) -> None:
        self._s._dfu_enter()

    def wait_for_dfu(self, is_cancelled: Callable[[], bool]) -> None:
        self._s._dfu_wait(is_cancelled)

    def flash(self, blob: bytes, base: int,
              on_progress: Callable[[int, int, str], None]) -> None:
        self._s._dfu_flash(blob, base, on_progress)

    def detach(self) -> None:
        self._s._dfu_detach()

    def reconnect(self, is_cancelled: Callable[[], bool]) -> Tuple[str, str]:
        return self._s._dfu_reconnect(is_cancelled)


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
