# litearm-studio-daemon

LiteArm Studio 的**本地程序（守护进程）**——上位机上唯一持有硬件的进程。

## 它为什么存在

浏览器打不开 USB 串口，而唯一上游 `litearm-python` 是 Python 库，所以必须有一个
本机 Python 进程持有串口。它就是本包：

```
本进程拥有的窗口 (React UI 跑在嵌入式 webview 里)
   │  HTTP  → 静态资源、/api/health
   │  WS    → 状态推送(下行) / 命令(上行)
   ▼
本程序 (Python，只监听 127.0.0.1)
   ▼
litearm-python ──USB CDC (1d50:606f)──> STM32 ──CAN──> 电机
```

**窗口也是本进程开的**（`window.py`，嵌入式 webview），所以"一个程序"在进程层面成立：
关掉窗口 ⇒ `webview.start()` 返回 ⇒ 收尾失能 + 释放串口。不需要任何计时器或心跳。

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

- **应用窗口要 `pywebview`**（在 `ui` extra 里，不是默认依赖：无界面运行、CI 与测试都不需要
  一个 GUI 栈）。`pywebview` 是纯 Python，真正渲染的内核要么来自系统，要么自带一个：

```bash
pip install -e "daemon[ui]"                       # pywebview 本体

# Linux: 借系统的 WebKitGTK。包只有 ~63 MB，因为 libwebkit2gtk 留在系统上。
sudo apt install python3-gi gir1.2-webkit2-4.1

litearm-studio-daemon             # 开窗口；关掉窗口就是退出
litearm-studio-daemon --no-open   # 无界面运行；界面用浏览器连它打印出的地址
```

  ⚠ Linux 上还有一个**自带内核**的备选：`pip install -e "daemon[ui-qt]"`（Qt WebEngine）。
  它不需要 apt，但把一整个 Chromium 打进产物 —— 实测 `.deb` 从 **63 MB** 变成 **243 MB**。
  只在拿不到系统 GTK 时才用它。

  Windows 的 WebView2 与 macOS 的 WKWebView 都是系统自带的，两边什么都不用装。

  没有可用后端时报错退出码 3，并且**不会**静默退回无界面 —— 见 `window.WindowUnavailable`。

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
| 导出保存 | `POST http://127.0.0.1:<port>/api/export?name=<建议文件名>` —— 页面把导出的字节放在请求体里，由本进程弹原生保存对话框并写盘（见下） |
| 窗口 | 由本进程自己开的嵌入式窗口（`window.py`）；**关掉它即退出程序**，刷新页面不会退出 |

**导出的文件由本进程保存**（issue #104 / #100）：页面跑在 webview 里，够不到宿主窗口，
它自己那一手 `<a download>` 的落点由后端各自决定——GTK 静默写进下载目录、WebView2 直接
取消下载。所以页面把字节 POST 回来，本进程弹对话框（预填页面给的文件名，从系统的下载目录
开始）、自己写文件、再把路径回给页面。取消回 `cancelled`，无界面运行回 `no-window`（页面
据此回退到浏览器下载），写失败回 `write-failed`。这条接口与 `/ws` 用同一套同源判据。

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

### 第二次启动：复用已经在跑的实例（#75）

窗口现在属于本进程，关掉它就退出了（见下一节），所以正常路径上不会有旧进程留着。这条复用
是给另外两种情况兜底：**图标被连点两次**，以及**升级后旧版本的进程还活着**。它们原本会另起
一个会话：绑下一个空闲端口，而串口是独占的（SDK 的 `SerialTransport` 用 `flock`），新进程
打不开 —— 窗口里是「打不开 /dev/ttyACM0」，机械臂却正握在上一个进程手里。界面把这读成
硬件故障。

现在启动时会先扫一遍 `--http-port` 起的那一组端口（范围与 `pick_free_http_port` 一致：
上一个实例可能因为 8765 被别的程序占着而挪到了 8766），探到**同一个构建**的守护进程就
`POST /api/focus` 请它**把自己的窗口抬到前面**，然后立即退出，不再起第二个：

```bash
$ litearm-studio-daemon
[litearm-studio-daemon] 已有实例在运行, 复用它: http://127.0.0.1:8765/
[litearm-studio-daemon] 已把它的窗口抬到前面
```

⚠ **不新开窗口**：一个进程一个窗口，新开一个会让两个窗口指向同一个会话。旧实例是无界面
运行的（`--no-open`）时没有窗口可抬，此时如实把地址打出来。`--no-open` 的本次启动也不碰
任何窗口。

判据只有两条，都来自不需要会话的 `/api/health`（见 `instance.py`）：

- **同一个构建** —— `daemon` 字段（打包时注入的 release 版本）必须相等。装了新版而旧进程
  还活着时**不**复用：那会把旧界面端给操作员，比多起一个进程更难解释。
- **同一种会话** —— `fake` 字段必须为假。在一条 `--fake` 的调试进程旁边启动真机版，复用会
  让操作员对着假设备操作。

**以下选项一旦被显式改过就不复用**（`__main__._SESSION_SHAPING`）：`--fake`、
`--fake-unactivated`、`--port`、`--ui-dir`、`--keep-enabled`、`--no-reconnect`、
`--no-gripper`、`--can-channel`、`--no-can-setup`、`--activation-url`、`--allow-origin`。
它们描述的是"这次要一个什么样的会话"，而复用一个已经在跑的实例等于把它们静默丢掉 ——
与「显式指定的口不做退让」（见「串口怎么选」）是同一条纪律。桌面条目不带参数，走的就是
复用那条路。

### 退出行为（#14）

进程收尾有**两个**触发点：**关掉应用窗口**（正常路径，见 `window.py`），或进程收到信号
（Ctrl-C / 服务停止）。两者都走同一条收尾路径，并且会**先 `disable()` 降能量**，然后再关链路：

- 进程一走链路就断，把「电机是否还使能」留给固件看门狗不是我们能保证的事；在还有链路时
  明确降能量才是确定的行为。失败只记日志（链路可能已经断），不影响收尾。
- 用 `disable` 而不是 `estop`：后者会锁存一个急停故障，下次连接还得先清错。
- **`disconnect()` 不降能量**——这是刻意的：界面上的"断开"只是结束这次会话。只有**进程收尾**
  才降能量。关窗口属于进程收尾。
- ⚠ **刷新页面不是退出信号**：刷新发生在 webview 内核里，窗口与进程都没动，WebSocket 断了
  会自己重连。退出只看窗口关没关。
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

### 选哪个串口（界面下拉）

控制台顶栏有一个串口下拉，旁边那个 `端口 · 固件` 是**现在实际连着哪个口**——两者不是
一回事：下拉是「这次连哪台」，自动发现连上时它仍停在「自动发现」。

| 命令 / 帧 | 要会话吗 | 说明 |
| --- | --- | --- |
| `list_ports` | 不要 | 本机可能的机械臂串口，STM32 CDC（`1d50:606f`）排最前；只列 USB 串口，板载 `/dev/ttyS0` 之类不进列表 |
| `{"t":"connect","port":"…"}` | — | 这一次连接的目标口；省略 = 按下一条顺序解析 |

`connect` 带 `port` 时**不做退让**：指定错了就是 `error` 态加原因，不会偷偷换成自动发现
到的另一个设备。界面上「我以为连的是这台、其实连的是那台」是这里最坏的失败形状，所以
宁可连不上。不带 `port` 时按 上次连上的口 → 自动发现 依次试（与自愈同一条软路径）。

会话**已经在另一个口上**时，`connect` 指一个不同的口会被拒，`res` 是
`{"ok":false,"err":{"kind":"PortChangeWhileConnectedError",…}}`：换口是操作员的决定，
先按「断开」，守护进程不会把活着的链路挪走。不指口、或指的就是当前口，仍是幂等的 no-op
（页面每次加载自动发的那条无参 `connect` 走这里）。

上次连上的口记在 `$XDG_CONFIG_HOME/litearm-studio/arm.json`（默认
`~/.config/litearm-studio/arm.json`，可用 `LITEARM_STUDIO_ARM_CONFIG` 覆盖），**只在连上
之后**才写：记一个连不通的口，会让下次的默认选择和「上次能用」无关。它只是**提示**，不是
硬性目标——设备重新枚举后节点名会变，所以它后面永远留着自动发现那条退路。`--port` 仍然是
硬性指定，且**界面选的口优先于它**（`--fake` 下两者都只是占位字符串）。


## 日志（#79）

守护进程写一份**结构化日志文件**：一行一个 JSON 对象（JSON Lines），字段名照
OpenTelemetry 的日志数据模型。页面的「日志」页是它的一个视图，而文件本身才是权威历史 ——
关掉窗口、换一个端口、换一个浏览器 profile，历史都还在（这正是 issue #80 的修法）。

默认位置按平台惯例（`obs/handlers.default_log_dir`）：

| 平台 | 目录 |
| --- | --- |
| Linux | `$XDG_STATE_HOME/litearm-studio/daemon.jsonl`（默认 `~/.local/state/litearm-studio/`） |
| macOS | `~/Library/Logs/litearm-studio/daemon.jsonl` |
| Windows | `%LOCALAPPDATA%\litearm-studio\Logs\daemon.jsonl` |

```bash
# 看最近发生了什么
tail -n 20 ~/.local/state/litearm-studio/daemon.jsonl | jq -c '{ts,severity,event,body}'

# 只看失败的命令
jq -c 'select(.event=="arm.command.failed") | {ts,method:.fields.method,err:.fields.error_kind}' \
  ~/.local/state/litearm-studio/daemon.jsonl

# 改目录 / 级别 / 轮转
litearm-studio-daemon --log-dir /tmp/litearm-logs --log-level DEBUG
```

开关（`--help` 里有同样的说明）：

- `--log-dir DIR`（也可用环境变量 `LITEARM_STUDIO_LOG_DIR`）—— 换目录。
- `--log-level LEVEL` —— 写入**文件**的最低级别，默认 `INFO`。`DEBUG` 会记下每一条命令
  的参数与返回，用于排障；`INFO` 只记真正改变机器的命令（`enable`/`movej`/`estop`…）
  与所有失败。
- `--log-max-bytes` / `--log-backups` —— 按体积轮转，默认 5MB × 5 份。
- `--log-stdout` —— 把同样的 JSONL 也写到 stderr，给 Fluent Bit / Loki / 容器运行时采集用。

实现**只用标准库，没有额外依赖**：记录 schema 在本仓的 `obs/schema.py`（字段名照
OpenTelemetry 的日志数据模型），写入是 `logging.handlers.RotatingFileHandler` 加一个
自定义 Formatter，trace/span 上下文是 `contextvars`。轮转与整行原子写入交给那个标准库
handler —— 它已经在轮转与写入之间持锁，这正是自己实现最容易写错的一步。

**不要**把 uvicorn 或 SDK 的 `logging` 也塞进这个文件：那是人读的文本，混进来会让采集器
解析失败。人读的那一路走 stderr，结构化记录走 `litearm.obs` 这一条独立 logger。

**记录里没有的东西**（`obs/redact.py` 强制，不是靠自觉）：激活请求里的联系人信息与设备
UID、从激活服务取回的凭据、固件镜像的字节、任何叫 `token`/`password`/`secret` 的字段。
新增一条日志时**不要**自己拼字段绕过 `obs.emit` —— 脱敏是那条路上的唯一一道闸。

字段含义的完整表、事件目录、以及**永远不会写进文件的东西**见
[../docs/LOGS.md](../docs/LOGS.md); 代码里的权威定义是 `obs/schema.py`。

字段含义（速查）：`ts`（RFC 3339 UTC）、`ts_ns`
（OTLP `time_unix_nano`）、`severity`/`severity_number`（OTLP 六档）、`event`
（稳定事件名，机器读这一个）、`body`（人读的一句话）、`trace_id`（一次浏览器连接）、
`span_id`（一条命令）、`service`/`version`/`host`/`pid`/`thread`/`source`、`fields`。

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
  脚本（`ip link set … bitrate 1000000 fd off`），已经正确的总线一次都不弹。`restart-ms`
  会被先试一次、遇到不支持它的驱动（本产品用的 `gs_usb` 适配器就是）再丢掉——它是加固项，
  不是连接的前提；无论哪条路径，接口最后都会 `up`。
- **标定是显式决定的**：解析顺序与"哪一份标定在生效"由守护进程从文件系统判定，SDK 只会
  收到一个明确的 `path=` 或 `template=`（它的无参回退会静默载入出厂文件并返回成功）。
  标称模板只声明方向，只允许张开/闭合/零重力；毫米目标需要实测标定。
- **行程是每通道记录的**（默认 85mm），它不在 SDK 的标定格式里，却是界面上每一个毫米的
  分子——所以它必须活过重启，也必须能按通道分别设置。
- **退出一定失能**：`--keep-enabled` 只对臂有效；一个还夹着东西的夹爪不该留在原地。
- 夹爪只在 Linux 上提供（SDK 需要 `PF_CAN`）；Windows 版构建里它是**缺席**的，不是禁用
  的。`--fake` 例外：仿真后端是纯 Python，任何平台都能跑。

## 打包（Phase 5）

**本地出包就一条命令**（需要 Docker）：

```bash
make deb        # → packaging/dist/litearm-studio_<版本>_amd64.deb
```

它做三件事：构建界面（`pnpm build`）、在**准备好的 Ubuntu 22.04 容器**里跑
`packaging/build.py` 得到单文件可执行程序、再用 `packaging/deb.py` 打成 `.deb`。
第一次运行会先建镜像（约 4 分钟），之后每次约 90 秒。

```bash
scripts/build-deb.sh --version 0.17.5     # 指定版本
scripts/build-deb.sh --no-ui              # 复用已有 dist/，跳过界面构建
make deb-image                            # 改过 packaging/deb.Dockerfile 之后重建镜像
```

⚠ **为什么必须在 Ubuntu 22.04 里构建，而不是本机。** 单文件可执行程序里冻着一个 Python
运行时，它链接的是**构建机**的 glibc：在更新的发行版上打出来的包会要求 glibc ≥ 2.38，
在 Ubuntu 22.04（2.35）与 24.04（2.39）上**根本起不来**；它还会把构建机的 GTK 带去配目标
机的系统 WebKitGTK。release 工作流的 `package` job 同样在 ubuntu-22.04 上构建，本地的
`packaging/deb.Dockerfile` 就是那个环境，容器里跑的 `packaging/deb_build.sh` 与那个 job
逐步骤一致 —— **改了工作流就要同步改它**：本地构建与线上不一致，比没有本地构建更糟。

版本号默认是 `<最新 tag>~local.<短 sha>`，例如 `0.17.5~local.1c4c370`。用 `~` 而不是
`+`：Debian 的版本序里 `1.2.3~x` **小于** `1.2.3`，所以本地测试包之后仍能被正式版正常
升级；写成 `+` 会排在正式版之上，装正式版就变成了降级。

### 本地包与发布包是否一致

换过构建镜像、动过打包脚本之后，拿发布产物当基准核一遍清单：

```bash
gh release download v0.17.5 --pattern 'litearm-studio_0.17.5_amd64.deb'
pip install pyinstaller                     # 只有这个脚本需要它
python scripts/compare_bundles.py litearm-studio_0.17.5_amd64.deb \
    packaging/dist/litearm-studio_*_amd64.deb \
    --ignore 'libapt-pkg*' --ignore 'libudev*' --ignore 'libyaml*' \
    --ignore 'libusb-1.0*' --ignore 'ossl-modules/*' --ignore 'libxxhash*'
```

它比的是冻结产物里的清单（PyInstaller 的 TOC），分三组：**系统库**、**界面资源**、Python 层。
前两组缺一个就判失败（界面资源的文件名里的内容哈希会先抹掉，改界面不算差异）；Python 层里多出来的
那些（`apt_pkg`、`cryptography`、`certifi`…）是发布 runner 自带的，精简构建不需要，只列出来给你看。
上面那六个 `--ignore` 就是当前 runner 比我们多出来的那几样。

⚠ 这条检查抓到过一次真问题：用最小镜像构建时 `librsvg` 与 SVG 的 pixbuf loader 没被收进去 ——
包能装、能启动，只有打包进去的 Adwaita 图标画不出来。`packaging/deb.Dockerfile` 现在显式装了
`librsvg2-2` / `librsvg2-common` 就是为了它。

只想在**本机**（不进容器）看打包过程，或要给 Windows 出包时，仍是直接调脚本：

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
- **Windows 需要 ST 的 WinUSB 驱动**（系统驱动，不是 Python 包）。Linux 上要两条 udev
  规则 —— **两条都要**，因为它们匹配的是两个不同的 USB 身份：
  ```bash
  # 应用态 CDC（串口）
  SUBSYSTEM=="tty", ATTRS{idVendor}=="1d50", ATTRS{idProduct}=="606f", MODE="0666"
  # ROM DFU bootloader
  SUBSYSTEM=="usb", ATTR{idVendor}=="0483", ATTR{idProduct}=="df11", MODE="0666"
  ```
  少了第二条，现象是"板子明明已经在 DFU 里，却报 `Access denied`"。`dfu/engine.py`
  优先用 `libusb-package` 自带的库（pyusb 的自动查找在 Windows 上会静默失败）。
- ⚠ **"设备存在 ≠ 设备可用"**：设备一 attach，内核先建出 `/dev/bus/usb/...`（默认
  `root:root 0644`），**udev 随后才**按规则 chmod。所以 `_dfu_wait` 不是"等枚举到"，
  而是**真开一次**、开不了继续等（实测撞到过：`find_device()` 成功、`open()` 却 EACCES）。
  一直开不了会报 `dfu_permission_denied`，而不是笼统的"烧录失败"。
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
