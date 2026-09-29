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

- **`litegrip`（litegrip-python）同样不在 PyPI 上，而且只在 Linux 上有意义**
  （import 需要 `fcntl` / `PF_CAN`）。要真机驱动夹爪就必须装它：

```bash
git clone --branch v0.4.0 https://github.com/nexform-tech/litegrip-python.git
pip install ./litegrip-python
```

  Linux 上没装它守护进程**照常启动**，只是不提供夹爪（与 Windows 上的"缺席"同一条路）；
  打包脚本则相反 —— Linux 构建缺它直接判失败，见「打包」一节。想显式关掉夹爪用
  `--no-gripper`；用 `--fake` 可以在任何平台跑纯 Python 的仿真后端。

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

### 退出行为（#14）

进程收尾（Ctrl-C / 关掉控制台 / 服务停止）时会**先 `disable()` 降能量**，然后再关链路：

- 进程一走链路就断，把「电机是否还使能」留给固件看门狗不是我们能保证的事；在还有链路时
  明确降能量才是确定的行为。失败只记日志（链路可能已经断），不影响收尾。
- 用 `disable` 而不是 `estop`：后者会锁存一个急停故障，下次连接还得先清错。
- **`disconnect()` 不降能量**——这是刻意的：关窗口/断开只是结束这次会话，不打断在途状态
  （计划 2 节原则 4）。只有**进程收尾**才降能量。
- 需要保留使能（例如只想重启本地程序、机械臂另有保持手段）时用 `--keep-enabled`。

### 断线检测与自愈（#48）

设备被拔掉或板子重新枚举之后，会话**不再继续报 `connected`**：

- 判据是固件那条 100Hz 被动状态流**还在不在到达**（`LINK_STALE_AFTER_S`，默认 2s ≈
  连续丢 200 帧）。50Hz 状态轮询读的是 SDK 的缓存帧，缓存本身永远不会说「设备没了」，
  所以这一层必须单独判。
- 任一条命令撞上传输层失败（真机上的 `写失败: [Errno 5] Input/output error`）也会
  **当场**把链路判死：同一条命令照旧返回失败，但会话同时落 `error` 态。
- 判死之后推一条 `conn`：`status` 为 `error`、`error` 写明原因、`port` **清空**（不会
  继续报那个已经消失的 `/dev/ttyACM1`），最后一帧好数据也一并丢掉，不再重放。
- 例外：`save_params` / `reset_factory_params` 会让固件做**整扇区擦写**，擦写窗口里
  CPU 取指停顿、状态流会断（固件自述 ~1s，给擦写开的看门狗豁免放宽到 ~8s）。这不是
  断线，所以这两条命令会落一个 12s 的让路窗口（`FLASH_STALL_GRACE_S`）——窗口内真要
  断线，仍会被命令的传输层失败当场判死。
- 控制台顶栏因此从绿色变成红色的「连接失败」并显示原因；此后的命令一律以「未连接」
  被拒，与顶栏口径一致。

自愈：断线后守护进程会重新解析 CDC 设备并重建会话（每 1s 试一次，总窗口 60s）。
先试上次连上的节点名，再试 `--port`，最后走自动发现——板子重新枚举后节点名会变
（实测 `/dev/ttyACM1` → `/dev/ttyACM0`），最后那条才是「把这台臂找回来」的依据。
窗口内没接上就**如实上报**（`conn` 的 `error` 写明试了多少次、最后一句为什么），
不再静默重试。想让它断了就停在那儿，用 `--no-reconnect`。

按下「断开」会同时取消在途的自愈；自愈成功后会重新推状态帧，界面不需要刷新。


## 夹爪（LiteGrip）

同一个守护进程还能同时驱动一把 LiteGrip 夹爪，走**与机械臂关节同一条 CAN 总线**
（宿主机 SocketCAN，经典 CAN 1 Mbit）。夹爪有自己的 200Hz 控制 tick、命令队列和急停
事件，与臂的命令执行器完全分开：一条 3 秒的闭合不该占住服务臂命令的线程。

```bash
# 仿真：夹爪也走模拟后端，不需要 CAN 硬件
litearm-studio-daemon --fake

# 真机：默认用上次记录的接口（首次为 can0）
litearm-studio-daemon --can-channel can0

# 接口由你或 systemd 管理时不弹授权框
litearm-studio-daemon --no-can-setup

# 完全不要夹爪
litearm-studio-daemon --no-gripper
```

几条必须知道的规矩（完整规范见 [`docs/GRIPPER_INTEGRATION.md`](../docs/GRIPPER_INTEGRATION.md)）：

- **同一个夹爪只能有一个说话的人**。`litegrip-studio` 连着的时候不要再让本程序连——它
  没有仲裁，两个主机会互相覆盖对方的帧。
- **不自动准备接口就不会有密码框**：默认只在接口状态确实不对时才用 `pkexec` 跑一次固定
  脚本（`ip link set … bitrate 1000000 restart-ms 100 fd off`），已经正确的总线一次都不弹。
- **标定是显式决定的**：解析顺序与"哪一份标定在生效"由守护进程从文件系统判定，SDK 只会
  收到一个明确的 `path=` 或 `template=`（它的无参回退会静默载入出厂文件并返回成功）。
  标称模板只声明方向，只允许张开/闭合/零重力；毫米目标需要实测标定。
- **行程是每通道记录的**（默认 85mm），它不在 SDK 的标定格式里，却是界面上每一个毫米的
  分子——所以它必须活过重启，也必须能按通道分别设置。
- **退出一定失能**：`--keep-enabled` 只对臂有效；一个还夹着东西的夹爪不该留在原地。
- 夹爪只在 Linux 上提供（SDK 需要 `PF_CAN`）；Windows 版构建里它是**缺席**的，不是禁用
  的。`--fake` 例外：仿真后端是纯 Python，任何平台都能跑。

## 打包（Phase 5）

```bash
pnpm build                     # 先构建界面：打包脚本会拒绝在没有 dist/ 的情况下继续
python packaging/build.py      # 产物：packaging/dist/litearm-studio-daemon[.exe]
```

`packaging/build.py` 做四件事：

- **把界面打进包**：`dist/` 以 `--add-data` 放到 `_MEIPASS/dist`，`server.resolve_ui_dir()`
  认识这个冻结路径，所以打包后不需要手工传 `--ui-dir`。
- **把 SDK 打进包**：`litearm` 不在 PyPI 上，连同 `pyserial` 一起内嵌。
- **夹爪 SDK 按平台收**：Linux 上必须装 `litegrip`（`pip install ../litegrip-python`），
  脚本会 `--collect-all litegrip` 把三份 JSON 与 `py.typed` 一起收进去；缺了它会**直接
  判失败**——一个"忘了装 SDK"的 Linux 产物会静默地没有夹爪。Windows 上不装、也不收：
  那个平台没有 `PF_CAN`，夹爪是**缺席**的（不是禁用）。版本钉在 `v0.4.0`
  （见 `.github/workflows/release.yml`），也就是"按名字载入标定模板 + 每通道标定文件"
  的那个版本。
- **版本单一来源**：`LITEARM_STUDIO_VERSION`（CI 传 git tag）> `git describe --tags` >
  `0.0.0+dev`，写进构建时生成的 `_build_version.py`（不入库）。于是 `hello` 帧报的版本
  就是发出去的那个 tag，而不是 `pyproject.toml` 里的占位符。

发布时由 `.github/workflows/release.yml` 的 `package` job 在 Ubuntu 22.04 与
windows runner 上各出一个可执行程序，并附各自的 `.sha256` 校验和一起挂到 release。

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
4. **状态推送与轮询同频（50Hz）**，但状态串、故障面、逐轴误差任一变化时**立即推**——
   节流只管"同样内容重复推"，且前端自己把 React 通知压在 10Hz，所以提速率只喂给
   3D 那条快订阅。⚠ **不要把它调回 10Hz**：旧客户端给 3D 预览留了一条直读 SDK 缓存的
   60Hz 快通道，新架构下前端只能吃本推送，10Hz 会让 3D 孪生明显发卡（这是上一版的真回归）。
5. **`zero_g` 的判据取或**：会话自己的记录 + SDK 的保活线程是否存活。后者读的是
   `Arm._zg_thread` 这个**私有**属性（公开面上没有「零重力是否激活」的查询），
   已由 `tests/test_session.py` 钉住，SDK 改了会红而不是静默失效。
6. **断线判据依赖两条 SDK 契约**（#48）：一是「固件 100Hz 被动状态流始终在流」——没有
   它，`get_state()` 的缓存帧根本不会更新，本程序的整个状态推送也就无从谈起；二是
   `Msg.timestamp` 的语义 = 「该类帧最近一帧的**到达**时刻」。本程序用它判「这一拍还
   听得见链路吗」，**不用**自己数帧：守护进程被负载拖慢时帧仍在到达，自己数会把判据
   拖糊。两条都由 `tests/test_session.py` 的断线用例钉住（冻结 `Msg.timestamp` 即可
   复现「设备没了」）。
