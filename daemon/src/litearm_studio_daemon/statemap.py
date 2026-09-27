"""`RobotState` → 线上 JSON 的归一化。

契约见 `litearm-studio/docs/REFACTOR_PLAN.md` 3.3 节「状态字段」: 字段名尽量沿用旧
前端字段名, 让现有面板少改。

本模块只做**纯函数**式的转换 (不持会话、不碰硬件), 因此可以单独跑单测。
"""
from __future__ import annotations

from dataclasses import fields, is_dataclass
from typing import Any, List, Optional

#: 固件 `mode` 里本包要单独认的两个值 (其余一律走 `mode_name`)。
#: ⚠ 这两个数与 `MODE_NAMES` 同源, 但**刻意不 import 私有模块** (`litearm._protocol`)
#: —— 那种跨包私有依赖会比一个常量更容易碎。`tests/test_statemap.py` 用 `MODE_NAMES`
#: 反查这两个数, 漂了就红。
MODE_INIT = 0
MODE_ZERO_G = 7


def _r6(x: Any) -> float:
    """浮点收窄到 6 位小数 —— 只为让 50Hz 推送的可读性与帧大小可控, 不改判据。"""
    try:
        return round(float(x), 6)
    except (TypeError, ValueError):
        return 0.0


def state_of(*, faulted: bool, enabled: bool, mode: int,
             zero_g_active: bool, motion_in_flight: bool,
             cart_busy: bool) -> str:
    """派生状态串 —— **逐条**照 REFACTOR_PLAN 3.3 的规则, 顺序即优先级。

    ```
    faulted                            -> 'fault'
    未使能 或 mode==INIT(0)             -> 'disabled'
    mode==ZERO_G(7) 或 zero_g 会话激活  -> 'zero_gravity'
    会话有运动在飞 或 cartBusy          -> 'moving'
    否则                                -> 'ready'
    ```

    ⚠ `'moving'` 的判据**故意**取「会话本地有运动在飞 或 `cartBusy`」, 而不是去猜
    固件 `mode` 的语义 (计划原文: 「使能且静止对应哪个固件 mode 值尚未在真机核实」)。
    `cartBusy` 单独 OR 进来有两个用处: ① 侧信道 (别的进程/别的客户端发起的笛卡尔
    规划) 也算; ② **本会话在途**那一段 (前面条件已成立) 不依赖任何固件位。

    ⚠ `zero_g_active` 是**会话自己的**记录 (收到过 `zero_g_start` 且未 `zero_g_stop`),
    mode==7 只是固件侧的证据; 两者取或 —— 固件 mode 未及时翻转、或本地记录还没落章
    时, 另一条路仍然兜得住。
    """
    if faulted:
        return "fault"
    if (not enabled) or mode == MODE_INIT:
        return "disabled"
    if mode == MODE_ZERO_G or zero_g_active:
        return "zero_gravity"
    if motion_in_flight or cart_busy:
        return "moving"
    return "ready"


def fault_list(state: Any) -> List[dict]:
    """`{joint, errCode}` 列表 —— 来源 = `joint_fault` 位图 + 逐轴 `err`。

    两条来源的去重规则: 按**关节号**合并, `errCode` 取逐轴 `err` (0 表示该轴被
    `joint_fault` 断了但没报具体错码 —— 断轴本身是固件级故障)。

    ⚠ `joint_fault` 的位序是**0 基** (`state.fault_axes` 就是这个口径), 但旧前端
    字段 `fault[].joint` 用的是**1 基**轴号 (J1..Jn) —— 这里统一输出 1 基, 与
    `fault_axes` 的 "J{a+1}" 展示口径一致。
    """
    axes = set(getattr(state, "fault_axes", []) or [])
    errs = {}
    for i, j in enumerate(getattr(state, "joints", []) or []):
        err = int(getattr(j, "err", 0) or 0)
        if err:
            errs[i] = err
    out = []
    for i in sorted(axes | set(errs)):
        out.append({"joint": i + 1, "errCode": int(errs.get(i, 0))})
    return out


def state_to_dict(state: Any, *, enabled: Optional[bool] = None,
                  zero_g_active: bool = False,
                  motion_in_flight: bool = False) -> dict:
    """`RobotState` → 3.3 节那张表的 JSON 对象 (纯转换, 不做任何判断以外的加工)。

    `enabled` / `zero_g_active` / `motion_in_flight` 三个量来自**会话**而不是状态帧:
    固件那一位 (flags bit9) 只从 1.5.0 起上报, 老固件恒 0 ⇒ 不能只依赖它; 会话自己的
    记录更可靠 (与 `state_of` 的口径一致)。
    """
    joints = list(getattr(state, "joints", []) or [])
    cart_busy = bool(getattr(state, "cart_busy", False))
    faulted = bool(getattr(state, "faulted", False))
    en = bool(getattr(state, "enabled", False)) if enabled is None else bool(enabled)
    mode = int(getattr(state, "mode", 0) or 0)
    return {
        # 逐轴向量
        "q": [_r6(j.q) for j in joints],
        "dq": [_r6(j.dq) for j in joints],
        "tau": [_r6(j.tau) for j in joints],
        "errs": [int(j.err) for j in joints],
        "temps": [{"mosTemp": _r6(j.t_mos), "coilTemp": _r6(j.t_coil)} for j in joints],
        # 故障面
        "fault": fault_list(state),
        # 固件原生诊断量
        "mode": mode,
        "modeName": str(getattr(state, "mode_name", "")),
        "flags": int(getattr(state, "flags", 0) or 0),
        "flagNames": list(getattr(state, "flag_names", []) or []),
        "jointFault": int(getattr(state, "joint_fault", 0) or 0),
        "faultAxes": list(getattr(state, "fault_axes", []) or []),
        # SDK 已算好的派生量
        "enabled": en,
        "cartBusy": cart_busy,
        "faulted": faulted,
        "faultDetail": str(getattr(state, "fault_detail", "")),
        # 帧序号: 前端可用它判"这一帧是不是新的" (计划 3.3 没点名, 但它零成本且
        # 是 `seq` 唯一的上行通道 —— 见 README「对计划文档的偏离/补充」)。
        "seq": int(getattr(state, "seq", 0) or 0),
        # 派生状态串
        "state": state_of(faulted=faulted, enabled=en, mode=mode,
                          zero_g_active=zero_g_active,
                          motion_in_flight=motion_in_flight, cart_busy=cart_busy),
    }


def jsonable(value: Any) -> Any:
    """把 SDK 返回值压成**可 JSON 序列化**的形状 (命令应答 `v` 字段用)。

    覆盖 SDK 实际会返回的几类: `None` / 基本类型 / `list` / `tuple` /
    `Msg` 信封 (取 `.value`) / dataclass (如 `CartPlan`) / `RobotState`。认不出的
    类型退回 `repr` —— **不抛**, 因为"应答里有个怪值"不该把整条命令判成失败。
    """
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    # `Msg` 信封 (`get_tcp` 等 11 个读口): 命令层已经取过 `.value`, 这里再兜一层。
    # ⚠ `Msg` **本身就是 dataclass**, 所以判据**不能**写成 `not is_dataclass(value)` ——
    # 那样这条分支永远走不到 (上一版的真 bug, 由 `test_jsonable_unwraps_msg_envelope`
    # 钉住)。改用形状判据 (`value`/`hz`/`timestamp` 三件套), 顺带避免为这一处 import SDK。
    if (hasattr(value, "value") and hasattr(value, "hz")
            and hasattr(value, "timestamp")):
        return jsonable(value.value)
    if is_dataclass(value) and not isinstance(value, type):
        return {f.name: jsonable(getattr(value, f.name)) for f in fields(value)}
    return repr(value)
