"""复用已经在跑的守护进程 —— 同一台机器上的第二次启动不该再起一个会话。

谁读这个文件: 改启动路径 (`__main__.main`) 的人, 以及要回答"关掉窗口再启动一次会发生
什么"的人。

问题的形状 (issue #75)。第二次启动不检查有没有实例在跑 —— 它绑下一个空闲端口
(`server.pick_free_http_port`), 另起一个会话。串口是**独占**的 (`litearm` 的
`SerialTransport` 用 `flock`), 于是新进程连不上机械臂: 窗口里是「打不开 /dev/ttyACM0」,
而机械臂正握在上一个进程手里, 还带着使能。操作员读到的是硬件故障, 实际的读法是「程序
已经在跑了」。

这里的答案是: 启动时先问一圈环回端口上有没有**同一个构建**的守护进程, 有就**请它把窗口
抬到前面** (`focus`), 自己不起。

⚠ 现在"窗口关掉 = 整个程序退出" (见 `window` 模块), 所以正常路径上不会有旧进程留着 ——
这条复用是给另外两种情况兜底: 图标被连点两次, 以及升级后旧版本的进程还活着。

判据只有一条, 来自不需要会话的 `/api/health`:

* **同一个构建** —— `daemon` 字段 (打包时注入的 release 版本, 见 `__init__._resolve_version`)
  必须相等。装了新版而旧进程还活着时, 复用等于把**旧界面**端给操作员: 那比多起一个进程更
  难解释, 所以那种情况下不复用, 让新版照常启动。
* **同一种会话** —— `fake` 字段必须为假。在一条 `--fake` 的调试进程旁边启动真机版, 复用会
  让操作员对着假设备操作。

⚠ 开发构建 (源码直跑、包元数据是占位符) 的版本号彼此相同, 所以同一个 venv 里两个不同
checkout 的守护进程分不开。桌面场景里每个构建都有自己的版本号, 不受影响。
"""
from __future__ import annotations

import json
import urllib.request
from typing import Any, Callable, Dict, Optional

#: 复用判据的唯一来源。它**不需要会话**, 断线、未连接时照样答 (见 `server._health`)。
HEALTH_PATH = "/api/health"

#: 单实例的第二个动作: 请已经在跑的实例把它的窗口抬到前面 (见 `focus`)。
FOCUS_PATH = "/api/focus"

#: 单次探测的超时。环回上"没人监听"是立刻 `ECONNREFUSED`, 不花这个时间; 它只兜住
#: "端口被一个不是 HTTP 的东西占着"这种会一直不答的情况, 所以给得很短。
PROBE_TIMEOUT_S = 0.3

#: 健康检查的应答只有几百字节; 读这么多还没结束就说明对端不是我们的守护进程。
MAX_BODY_BYTES = 64 * 1024


def probe(host: str, port: int,
          timeout: float = PROBE_TIMEOUT_S) -> Optional[Dict[str, Any]]:
    """问一次 `http://host:port/api/health`, 返回解析后的 JSON; 失败返回 `None`。

    **不抛异常**: 启动路径上不能因为"某个端口上蹲着一个奇怪的服务"就崩掉 —— 那会把
    "程序已经在跑"变成"程序起不来"。连不上、不是 HTTP、应答不是 JSON 对象、超时, 一律
    当成"这个端口上没有我们的守护进程"。
    """
    try:
        with urllib.request.urlopen(f"http://{host}:{port}{HEALTH_PATH}",
                                    timeout=timeout) as resp:
            body = resp.read(MAX_BODY_BYTES)
    except Exception:  # noqa: BLE001 - 理由见 docstring
        return None
    try:
        data = json.loads(body)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def is_same_instance(health: Dict[str, Any], *, version: str, fake: bool = False) -> bool:
    """这份 `/api/health` 是不是"同一个构建、同一种会话"的守护进程 (见模块文档)。"""
    return (health.get("ok") is True
            and health.get("daemon") == version
            and bool(health.get("fake")) is bool(fake))


def find_running(host: str, start: int, tries: int, *, version: str, fake: bool = False,
                 timeout: float = PROBE_TIMEOUT_S,
                 probe_fn: Callable[[str, int, float], Optional[Dict[str, Any]]] = probe
                 ) -> Optional[str]:
    """扫描 `start .. start+tries-1`, 返回在跑的同构建实例的 URL; 没有则 `None`。

    扫描范围与 `server.pick_free_http_port` **必须一致**: 上一个实例可能因为 `start` 被
    别的程序占着而挪到了 `start+1`, 只问 `start` 会漏掉它, 于是又回到"两个守护进程"这个
    原始缺陷。

    `probe_fn` 是注入点: 单测用它走遍"命中/版本不符/不是我们的应答"几条分支, 不必真的
    起服务。
    """
    for port in range(int(start), int(start) + int(tries)):
        health = probe_fn(host, port, timeout)
        if health is not None and is_same_instance(health, version=version, fake=fake):
            return f"http://{host}:{port}/"
    return None


def focus(url: str, timeout: float = PROBE_TIMEOUT_S) -> bool:
    """请已经在跑的那个实例把**它自己的窗口**抬到前面; 抬起来了返回 `True`。

    这是第二次启动该做的事 (见 `__main__._reuse_the_running_instance`): 窗口现在由那个
    进程自己拥有, 一个进程一个窗口, 所以这里不新开窗口, 只把它抬起来 —— 桌面程序点两次
    图标的规范行为。

    ⚠ **不抛异常**, 和 `probe` 同理: 启动路径上不能因为"对端不答话"就崩掉。对端是无界面
    运行 (`--no-open`) 时它会如实回 `focused: false`, 这里也如实返回 `False`, 由调用者
    把地址打给操作员。
    """
    request = urllib.request.Request(f"{url.rstrip('/')}{FOCUS_PATH}", method="POST",
                                     data=b"")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            body = resp.read(MAX_BODY_BYTES)
    except Exception:  # noqa: BLE001 - 理由见 docstring
        return False
    try:
        data = json.loads(body)
    except ValueError:
        return False
    return isinstance(data, dict) and data.get("focused") is True
