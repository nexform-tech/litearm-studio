# litearm-studio-daemon

LiteArm Studio 的**本地程序（守护进程）**——上位机上唯一持有硬件的进程。

## 它为什么存在

浏览器打不开 USB 串口，而唯一上游 `litearm-python` 是 Python 库，所以必须有一个
本机 Python 进程持有串口。它就是本包：

```
浏览器 (React UI)
   │  HTTP  → 静态资源、/api/health
   │  WS    → 状态推送(下行) / 命令(上行)
   ▼
本程序 (Python，只监听 127.0.0.1)
   ▼
litearm-python ──USB CDC (1d50:606f)──> STM32 ──CAN──> 电机
```

接口契约（消息格式、命令白名单、状态字段、位姿格式）见
[`docs/REFACTOR_PLAN.md`](../docs/REFACTOR_PLAN.md) 第 3 节。

## 依赖

- Python 3.10+
- `fastapi` / `uvicorn`（随本包安装）
- **`litearm`（litearm-python）不在 PyPI 上**，必须先克隆并安装它：

```bash
git clone https://github.com/nexform-tech/litearm-python.git
pip install -e ../litearm-python
pip install -e "daemon[test]"     # 在仓库根目录执行
```

## 运行

```bash
# 离线：用 SDK 的假传输起一个完整会话，不需要任何硬件
litearm-studio-daemon --fake

# 真机：自动发现 USB CDC 设备（VID:PID 1d50:606f）
litearm-studio-daemon

# 指定串口 / 端口 / 不自动开窗口
litearm-studio-daemon --port /dev/ttyACM1 --http-port 9000 --no-open
```

启动后：

| | |
| --- | --- |
| 控制台 | `http://127.0.0.1:<port>/`（默认 8765，被占用会自动换并打印实际端口） |
| WebSocket | `ws://127.0.0.1:<port>/ws` |
| 健康检查 | `http://127.0.0.1:<port>/api/health` |
| 窗口 | 默认用 Chrome/Edge 的 `--app=` 模式开无地址栏窗口；找不到 Chromium 系则退回普通标签页 |

**只监听 `127.0.0.1`**：越线暴露一个能驱动机械臂的接口是安全事故，不是配置项——
换地址只能改代码，没有开关。

## 测试

```bash
pytest daemon/tests -q
```

全部用例跑在 `litearm.testing.FakeTransport` 上，**不需要硬件，也不会碰串口**。

## 对计划文档的偏离与补充

1. **`version` 写成 `0.0.0+semantic-release`**，而非规范原文的 `0.0.0-semantic-release`。
   后者不是合法 PEP 440 版本号，setuptools 会直接拒绝（`pip install -e` 报
   `configuration error: project.version must be pep440`）——这也是兄弟仓
   litearm-python 的 pyproject 里写着实际版本号的原因。本包不发布到任何索引
   （`release.yml` 是 source-only 形态），该字段是惰性的，git tag 仍是唯一版本来源。
2. **错误对象里命令名与固件命令码分占两个键**：`method` 是本程序视角的命令名
   （`"movej"`），`cmd` 是固件回显的命令码（`0x01`）。两者共用一个键会让固件码
   覆盖掉命令名（上一版的真 bug）。
3. **状态帧多带一个 `seq`**（固件帧序号），供前端判「这一帧是不是新的」。
4. **状态推送节流到 10Hz**，但状态串、故障面、逐轴误差任一变化时**立即推**——
   50Hz 全灌进 WebSocket 只会把浏览器和缓冲一起打满。
5. **`zero_g` 的判据取或**：会话自己的记录 + SDK 的保活线程是否存活。后者读的是
   `Arm._zg_thread` 这个**私有**属性（公开面上没有「零重力是否激活」的查询），
   已由 `tests/test_session.py` 钉住，SDK 改了会红而不是静默失效。
