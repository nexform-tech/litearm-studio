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
- `pyusb` + `libusb-package`（随本包安装）—— 固件升级的 USB 烧录引擎。
  **Windows 上另外需要 ST 的 WinUSB 驱动**（这是系统驱动，不是 Python 包，见「固件升级」一节）。
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

**`/ws` 只接受同源握手**：浏览器对 WebSocket **不做同源限制**，所以任何网页都能连
`ws://127.0.0.1:<port>/ws` 并驱动机械臂。守护进程因此只接受**与 Host 同源**的握手，
且 Host 必须是 loopback（后者挡 DNS rebinding——那种攻击下 Origin 与 Host 都是攻击者的
域名，同源判据会通过）。没有 `Origin` 头的握手一律放行：浏览器一定会发它，不发就说明是
非浏览器客户端（脚本 / 原生工具）。

开发期前端（vite，默认 5173）已显式放行；换端口或换别的源时加 `--allow-origin`：

```bash
litearm-studio-daemon --allow-origin http://localhost:8000
```

⚠ 放行一个来源 = 让那个来源的页面能驱动机械臂。只在你确知用途时才加。

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
- **激活服务地址可注入**：`LITEARM_ACTIVATION_URL`（可选，必须是 http(s)）写进同样
  构建时生成的 `_build_activation_url.py`（不入库）。不设置 = 用内置生产地址。
  release 工作流从**仓库变量**取它（`vars.LITEARM_ACTIVATION_URL`），所以换地址不必
  改工作流、更不必让用户设环境变量。两个生成文件都在构建的 `finally` 里删除 ——
  留在源码树里会让下一次"源码直接运行"读到上一次打包的值。

发布时由 `.github/workflows/release.yml` 的 `package` job 在 Ubuntu 22.04 与
windows runner 上各出一个可执行程序，并附各自的 `.sha256` 校验和一起挂到 release。

## 测试

```bash
pytest daemon/tests -q
```

全部用例跑在 `litearm.testing.FakeTransport` 上，**不需要硬件，也不会碰串口**。

## 激活（唯一出网的功能）

设备的授权记录（是否已激活 + 设备 UID）由 `license` 命令**只读**取回，界面显示在
「设置 → 授权激活」。写入授权只有一条路，由 `activate` 命令完成：

| 命令 | 出网 | 说明 |
| --- | --- | --- |
| `license` | 否 | 读授权记录。未激活是**状态**不是错误 |
| `activate` | **是** | 把注册信息（姓名/手机号/单位/邮箱/地区 + 微信号/行业/用途 + 同意标记）连同设备 UID POST 给激活服务，拿回本机凭据并写进设备 |

- 地址：`--activation-url` > 环境变量 `LITEARM_ACTIVATION_URL` > **打包时注入的地址**
  > 内置 `https://act.nexform.tech`；传空字符串 = 不提供在线激活。
  打包期注入见下面「打包」一节的 `LITEARM_ACTIVATION_URL`：它让同一份源码能出指向
  不同环境的包，而**终端用户不必设环境变量**——"连不上激活服务"是这条链路上最没法
  自助排查的一种失败（界面只说连不上，说不出该连哪）。
- **本进程只有这一处出网**（`activation.py`）。它**不上报**任何东西：发出去的字段由
  《激活注册信息同意书》在界面上逐项列出，同意由用户在界面上勾选 —— 而**门禁判在这里**，
  因为界面的禁用按钮挡不住直连 WebSocket 的客户端。
- **服务端记录来源 IP**，客户端不采集也不上报内网地址/主机名；这一条披露在隐私政策里，
  不写进同意书（同意书只列上位机发出去的字段）。
- 契约（请求体、应答、错误码、凭据文件格式）见 [`../docs/ACTIVATION.md`](../docs/ACTIVATION.md)。

### 没有硬件也要能看到界面

```bash
litearm-studio-daemon --fake --fake-unactivated
```

`--fake` 起的是**已激活**的假设备（只显示授权状态，不出表单）；`--fake-unactivated` 把它
翻成未激活的那台，于是注册表单、同意书勾选、以及按「使能」时固件回的那句
`ERR{0x10,0x08}` 都能在没有机械臂的情况下走一遍。`--fake-unactivated` 只在 `--fake` 下
有意义，命令行会拒掉单独使用它。

## 固件升级（USB DFU）

把控制器固件（`.hex` / `.bin`）写进 STM32H723。走**免探针**路径：应用态发
`CMD_ENTER_DFU (0x15)` → 板子重启进 ROM bootloader（`0483:DF11`）→ 内置的 pyusb/DfuSe
引擎擦写并读回校验 → 复位回应用 → 重建会话。界面在「设置 → 固件升级」。

| 命令 | 要会话吗 | 说明 |
| --- | --- | --- |
| `firmware_inspect` | 不要 | 上传镜像字节（base64），离线解析并给出摘要与 token |
| `firmware_upgrade` | 要 | 确认后开跑；**立即返回** job 号，进度与终局走广播帧 |
| `firmware_status` | 不要 | 当前快照（界面重开/重连后据此把进度条接回去） |
| `firmware_cancel` | 不要 | 请求取消（进入擦写相位后无效） |

下行新增两类帧：`firmware_progress {job, phase, done, total, detail}` 与
`firmware_result {job, ok, reason, msg, version, port, warning}`。`reason` 是短码，
界面文案按它选（同激活那条纪律：`msg` 是守护进程写的中文）。

几条必须知道的：

- **升级会把设备交出去**，所以进度不走命令应答：烧录可能几十秒（超过
  `COMMAND_TIMEOUT_S`），而且进 bootloader 之后**没有机械臂会话**，普通命令一律以
  「未连接」被拒 —— `firmware_status` / `firmware_cancel` 因此是**会话无关**的。
- **升级期间不起自愈。** 串口一消失就会判链路死并启动 60s 自动重连，那会跟烧录器
  抢同一个 USB 设备。`_note_link_lost` 在升级期间直接让位，由升级线程负责把设备接回来。
- **默认拒绝覆盖扇区 6+7**（许可证 + 出厂标定，只存在于设备、擦掉不可恢复）：
  `image.inspect` 先拦一道，引擎的 `param_policy="abort"` 再拦一道。
- **升级前自动失能**（跳转停 TIM3 ⇒ 电机 100ms 后松开）。有重力负载的臂会下垂，
  所以界面要求操作员确认"手臂已放稳或有支撑"—— 这是界面**无法验证**的一件事，
  只能让人确认；升级期间急停也不可达（设备在 bootloader 里）。
- **Windows 需要 ST 的 WinUSB 驱动**；Linux 需要 udev 规则，或用 `libusb-package`
  自带的库（`dfu/engine.py` 优先用它 —— pyusb 的自动查找在 Windows 上会静默失败）。
- `--fake` 下注入的是一个**同形的假引擎**，整条流水线（相位顺序、进度、失败收尾）
  都能在没有硬件时走一遍 —— 但**烧录结果本身**只能在真机验，判据见
  [`FIRMWARE-UPGRADE-PLAN.md`](../../FIRMWARE-UPGRADE-PLAN.md) §5.3。

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
