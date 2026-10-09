# LiteArm Studio 重构计划

> 范围：**只做控制上位机**这一个应用。
> 状态：待评审。本文档是执行的唯一依据，评审通过后按阶段推进。

---

## 1. 最终形态

最终是 **3 个独立程序**，它们共用同一个底层库 `litearm-python`：

| 程序 | 仓库 | 职责 | 本次 |
| --- | --- | --- | --- |
| **LiteArm Studio** | `nexform-tech/litearm-studio` | 单臂控制上位机 | ✅ 本次 |
| 同构遥操 | 待定 | 双机主从跟随 | 以后 |
| VR 上位机 | 待定 | VR 遥控 | 以后 |

`litearm-python` 是库，不是程序，用户不需要启动它。

### Studio 的交付形态

**一个本地 Python 程序 + 现有 React 界面**：

- 双击一个可执行文件（Windows / Linux 各一份），不需要用户装 Python、装驱动、克隆任何仓库。
- 启动后由**这个进程自己**开一个**嵌入式窗口**（`pywebview`：Linux 走 GTK/Qt，Windows 走系统自带的 WebView2，macOS 走 WKWebView），界面就是现有的 React 构建产物。
- **窗口属于这个程序，所以关掉窗口就是退出**：机械臂失能、串口释放。刷新页面不会退出（刷新发生在 webview 里，进程没动）。

**明确不做 Tauri。** 理由：唯一上游是 Python 的 `litearm-python`，硬件 I/O 必须由 Python 进程持有，Tauri 的 Rust 后端无处可用——引入它等于为了一个窗口多背一套 Rust 工具链和一条打包链路。而它在 Linux 上用的还是系统 WebKitGTK，省不下那一个依赖。

> 交付形态的这一版改动（2026-01）：原方案是"以浏览器应用模式打开窗口"。实测下来它有一个反直觉的失败：窗口由**用户机器上的 Chrome** 持有，关掉它跟本进程毫无关系，于是进程继续握着串口，而界面没了；第二次启动还会因为串口被占而报"打不开设备"。改成嵌入式窗口后，"一个程序"这件事在进程层面成立，第 4 条原则也就不再需要靠一句约定来兜。代价是多一个 webview 依赖（见 `daemon/pyproject.toml` 的 `ui` extra），换来的是不依赖用户装浏览器。

---

## 2. 架构

```
浏览器窗口 (React UI，现有界面)
   │  HTTP  → 静态资源、健康检查
   │  WebSocket → 状态推送(下行) / 命令(上行)
   ▼
Studio 本地程序 (Python, 仅监听 127.0.0.1)
   ├── 命令执行：单线程串行，所有 SDK 调用都在这里
   ├── 状态轮询：~50Hz，只读 SDK 缓存帧，不占串口
   ├── 链路存活：被动状态流 2s 没到达即判为断，落 error 态并自愈（#48）
   └── Arm 会话：独占 USB 串口
   ▼
litearm-python  ──USB CDC (1d50:606f @921600)──>  STM32  ──CAN──>  电机
```

四条设计原则：

1. **唯一上游**：硬件 I/O 只存在于 Python 侧。前端永不直接碰串口。
2. **状态与命令分离**：固件是 100Hz 被动状态流，SDK 的 `get_state()` 直接回缓存、不发帧。因此状态推送不会被 `movej`（可能阻塞十几秒）挡住，运动过程中 3D 依然是活的。**代价**：缓存不会告诉你设备没了，所以「链路还活着吗」必须由被动状态流的到达时刻单独判定（`LINK_STALE_AFTER_S`，见 `daemon/README.md`）。
3. **命令串行**：全部走同一个单线程执行器，避免并发指令竞争；运动互斥（`motionBusy`）也在这一层判定，前端只是显示。
4. **安全在本地程序里**：急停、失能等降能量动作不依赖浏览器存活。窗口属于这个进程，关掉窗口即退出并失能（见交付形态一节）。

### 设备发现

- 当前阶段**只支持单臂**：启动时用 SDK 的 `find_cdc_port()` 自动发现。
- 无 IP、无端点、无设备选择框。`--port` 可覆盖自动发现。
- **断线自愈要重新解析设备**（#48）：板子重新枚举后节点名会变，所以自愈按「上次连上的
  节点名 → `--port` → 自动发现」的顺序重试；进程收尾或操作员手动断开都会取消它。
- 预留多臂扩展缝（设备注册表接口），但本次不实现。

---

## 3. 接口契约

### 3.1 消息格式

下行（本地程序 → 浏览器）：

```jsonc
{"t":"hello","daemon":"0.1.0","sdk":"2.1.0"}
{"t":"conn","status":"disconnected|connecting|connected|error",
 "port":"/dev/ttyACM0","firmware":"Litearm1.8.0-7J","n":7,"cart":true,"error":null}
{"t":"state","stamp":1234.5,"state":{ /* 见 3.3 */ }}
{"t":"res","id":7,"ok":true,"v":null}
{"t":"res","id":7,"ok":false,"err":{"kind":"TransportError","msg":"…","cmd":0,"code":0}}
```

`conn` 帧的 `status` 是**唯一**的连接口径，前端据此显示顶栏。`error` 态既表示「连不上」，
也表示「连上过、现在链路断了」（#48）：后者会把 `error` 填成原因、把 `port` 清空，因为
那个节点名已经不存在了；自愈成功后重新推一条 `connected`（`port` 是重新解析出来的）。

上行（浏览器 → 本地程序）：

```jsonc
{"t":"connect","id":3} | {"t":"disconnect","id":4}
{"t":"cmd","id":1,"m":"enable","p":{}}
```

`connect` 与 `disconnect` 都带 `id` 并等同 id 的 `res`。**断开尤其不能 fire-and-forget**：daemon 在 WebSocket 关闭时**不**断开机械臂（刷新页面不能掉臂），所以「已断开」只有在收到确认后才是真的 —— 帧没送到就落「已断开」会让界面与 daemon 失步，之后换口连接必被拒（#82）。daemon 处理 `disconnect` 时先广播一条 `conn`（`status: disconnected`）再回 `res`，顶栏徽标以那条 `conn` 帧为准。

### 3.2 命令白名单

**不接受任意方法调用**，只暴露下列映射（每条都对应 `litearm-python` 的一个公开方法）：

| `m` | 映射 | 说明 |
| --- | --- | --- |
| `enable` / `disable` | `arm.enable` / `arm.disable` | |
| `estop` | `arm.emergency_stop` | 降能量方向，永远可达 |
| `clear_faults` / `reset` | 同名 | |
| `home` | `arm.home` | 固件低速度回零 |
| `movej` | `arm.movej(q, speed)` | 关节运动 |
| `movel` | `arm.move_l(pose, speed)` | 笛卡尔直线（固件规划） |
| `set_speed` | `arm.set_speed(percent)` | 全局调速 0–100 |
| `get_tcp` | `arm.get_tcp().value` | 当前末端位姿 |
| `ik` | `arm.ik(pose)` | 逆解 |
| `zero_g_start` / `zero_g_stop` | `arm.zero_g_start` / `arm.zero_g_stop` | 拖动示教 |
| `get_joint_params` | `arm.params.all_joint_params()` | 逐轴读回 kp/kd/tau_max/软限位（控制页滑条量程要用） |
| `set_joint_param` | `arm.params.set_joint_param(idx, kp, kd, tau_max)` | 逐轴写（RAM） |
| `set_joint_limits` | `arm.params.set_joint_limits(idx, q_min, q_max)` | 逐轴写（RAM） |
| `save_params` | `arm.save_params()` | 持久化到 flash（固件要求失能态） |
| `reset_factory_params` | `arm.params.reset_factory()` | 恢复出厂（固件要求失能态） |
| `set_payload` | `arm.set_payload(mass, com)` | 负载质量与质心（前馈 item 4/5） |
| `set_gravity_scale` / `set_inertia_scale` | 同名 | 重力/惯量前馈系数（vec item 7/8） |
| `set_gravity_vector` | `arm.set_gravity_vector(g)` | 重力方向（scalar item 6） |
| `get_ff_vec` / `get_ff_scalar` | 同名 | 读回，与上一组构成写→读回闭环 |
| `kin_bench` | `arm.diag.kin_bench()` | 固件自检 + 链路诊断计数 |
| `license` | `arm.license()` | 只读：授权状态 + 设备 UID（**未激活是状态不是错误**；契约见 [ACTIVATION.md](ACTIVATION.md)） |
| `activate` | 激活服务 + `arm.activate()` | 提交注册信息换取本机凭据并写入设备（**唯一出网的一条**，须失能态） |

### 3.3 状态字段

尽量沿用旧字段名，让现有面板少改：

| 前端字段 | 来源 |
| --- | --- |
| `q` `dq` `tau` | `joints[].q/dq/tau` |
| `errs[]` | `joints[].err` |
| `temps[{mosTemp,coilTemp}]` | `joints[].t_mos/t_coil` |
| `fault[{joint,errCode}]` | `joint_fault` 位图 + 逐轴 `err` |
| `mode` `modeName` `flags` `flagNames` `jointFault` `faultAxes` | 固件原生（新增，正好补上旧界面缺的诊断信息） |
| `enabled` `cartBusy` `faulted` `faultDetail` | SDK 已算好的派生量 |
| `state` | 见下 |

**旧字段的处置**：

- `watchdog.tripped` → 删除。固件用 flags 的 `WD_TRIPPED` 位表达，退化为标志级。
- `feedback.staleJoints` → 删除。只有 `FB_STALE` 聚合位，没有逐轴明细。
- `robotSerial` / `configChecksumSha256` → 无对应物；设备身份改用 `license()` 的 UID。

**`state` 串的派生规则**（不依赖固件 mode 语义）：

```
faulted                              → 'fault'
未使能                                → 'disabled'
mode==ZERO_G(7) 或 zero_g 会话激活    → 'zero_gravity'
本地程序有运动在飞 或 cartBusy        → 'moving'
否则                                  → 'ready'
```

> ⚠️ 「使能与否」只看 `enabled`（真机上 = 固件 flags bit9，会话自身记录优先），**不看固件的 `mode`**。
> 真机（`Litearm1.8.0-7J`）上 `mode` 只在运动命令被接受时才写，上电后与退出零重力后都停在
> `INIT`(0) ⇒ 使能且静止的臂 `mode=0`；早期把 `INIT` 当未使能，会把已使能的臂报成 `disabled`
> （issue 32）。`moving` 用本地程序自己的「运动在飞」记录判定，比猜固件 mode 可靠。

### 3.4 位姿格式

统一为 `litearm-python` 的原生 6 元组 `[x, y, z, rx, ry, rz]`（`get_tcp()` 也返回这个）。
现有前端使用 `[pos[3], R(3×3)]`，改造时用 SDK 导出的 `mat_to_rpy` / `rpy_to_mat`（或前端 `geometry.ts`）换算。

---

## 4. 阶段划分

### Phase 1 — 拆仓并接入 GitHub

**交付物**：一个全新历史的控制应用仓库，推到 `nexform-tech/litearm-studio`。

- 1.1 备份旧仓（镜像克隆，保留 teleop 源码，供将来建遥操仓使用）
- 1.2 为同级准备 `litearm-js` 检出并构建 —— 旧传输的类型来源，Phase 3 会连同依赖一起移除
- 1.3 只保留控制应用：删除 teleop 全部代码、路由、导航项、i18n 命名空间、旧 SDK 类型声明中的遥操类型、手册章节与截图
- 1.4 清退 Tauri：删除 `src-tauri/`、`Dockerfile.*`、打包脚本与 Tauri 专属文档（当时的交付形态定为浏览器应用模式；2026-01 改为嵌入式窗口，见 §1）
- 1.5 接入组织仓库规范：以远端 `main` 的规范提交为基线，保留规范版 `AGENTS.md`、`LICENSE`、`.releaserc.json`、`.markdownlint.json`、`release.yml`；占位 `ci.yml` 换成真实工具链（job 名保持 `test`）
- 1.6 以**分支 + PR + squash 合并**落地（规范禁止直接推 `main`）

**完成判据**：`pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b && pnpm test && pnpm build` 全绿；CI 的 `test` 检查通过后 squash 合并。

### Phase 2 — 本地程序骨架（fake 模式跑通）

**交付物**：`daemon/` Python 包。

- 设备会话（持有 `Arm`）、~50Hz 状态轮询、命令单线程执行、运动互斥
- HTTP（静态资源 + 健康检查）+ WebSocket（状态推送 / 命令）
- `--fake` 用 `litearm.testing.FakeTransport` 起假会话；`--port` 指定真机
- 单元测试：状态归一化、命令白名单映射、错误转换

**完成判据**：`--fake` 启动后能用脚本走通 连接→使能→关节/笛卡尔运动→急停→断开。

### Phase 3 — 前端换传输

**交付物**：前端只连本地程序。

- 重写 `src/lib/arm/client.ts` 内部为 WebSocket 客户端，**保持对外接口不变**（页面组件不动）
- 删除 `src/lib/arm/endpoint.ts`、`types/litearm-js-browser.d.ts`、`litearm-js` 依赖
- `TopBar` 的 host/port 输入换成「端口名 + 固件版本」只读显示 + 连接/断开
- `main.tsx` 启动逻辑：向本地程序要连接状态，不再读端点
- 重写 `src/lib/arm/errors.ts` 为 SDK 异常层级映射
- 移除轨迹示教/回放与「控制器日志」页：相关组件、状态、i18n 命名空间与导航项
- 启动时由本进程打开嵌入式应用窗口（见 §1「交付形态」；关掉窗口即退出）

**完成判据**：`pnpm build` 通过，前端无任何指向旧 SDK 的引用。

### Phase 4 — 端到端验证

**交付物**：可演示的骨架。

- fake 模式：发现 → 连接 → 使能 → 关节点动 → 笛卡尔点动 → 急停 → 状态与 3D 实时刷新
- 真机：`--port` 切换后重复上述流程
- 校准 3.3 中未核实的 mode 语义

**完成判据**：连续运行 10 分钟，状态推送不中断、3D 无卡顿；急停在运动过程中始终可用。

### Phase 5 — 打包

**交付物**：Windows / Linux 各一个可执行文件。

- 把 webview 依赖（`daemon/pyproject.toml` 的 `ui` extra）与 `litearm-python`（含 `pyserial`）、界面静态资源一起打进单文件可执行程序
- Linux 仍需在 Ubuntu 22.04 基准环境构建（沿用现有规范）；Windows 用 CI 的 windows runner，不再用交叉编译容器
- ⚠ 反过来于原计划：pywebview **仍然需要**。2026-01 的交付形态改版把它请了回来——"关掉窗口就是退出"只有在窗口属于本进程时才成立（见 §1）。

---

## 5. 能力缺口处置

以 `litearm-python` 的固件命令覆盖表为判据（该表逐条镜像固件 `hal/usb_cmd.h`，且 `UNIMPLEMENTED_CMDS` 为空，即命令空间已完整枚举）。

**有对应，直接接线**：使能/失能、急停、清错、回零、关节运动、笛卡尔直线、拖动示教、调速、当前位姿、逆解、实时状态、实时曲线、负载质量与质心、重力/惯量系数、驱动器增益、关节限位、动力学模型导入、固件自检与 CAN 诊断。

**需换算或降级**：位姿旋转矩阵 ↔ rpy；安装姿态（改用重力向量表达）；关节限位/增益（由整数组改为逐轴下发）。

**固件无对应，先隐藏**：

| 缺口 | 判定依据 |
| --- | --- |
| 夹爪 / 灵巧手 | 固件无任何末端设备命令；旧实现是 server 侧 device daemon 走 CAN |
| 零点偏移 / 笛卡尔限位 / 碰撞配置 | 固件无对应命令 |
| 服务运维（重启服务、配置文件读写、清停止） | 纯 server 概念 |

**已定：这一版不做，从界面移除**：

| 缺口 | 决定与理由 |
| --- | --- |
| 轨迹拖拽示教 / 回放 | 本次不做。原实现依赖已下线的 server 轨迹库，固件也没有轨迹指令。将来若要做，走本地程序侧自建（采样存盘 + 逐点回放）。 |
| ~~「控制器日志」页~~ | **已由 issue #79 补回**：新实现不读 server 文本日志，而是让守护进程把自己的判断写成结构化 JSONL（见 [LOGS.md](LOGS.md)），页面实时看、并可从文件回读历史。固件的 `arm.log` 仍是另一回事（300Hz 控制拍采样），不作为替代。 |

---

## 6. 不在本次范围

多臂支持；遥操；VR；轨迹拖拽示教与回放；安装器签名与自动更新；激活服务站点本身（`act.nexform.tech` 是另一个项目，本仓只做客户端，契约见 [ACTIVATION.md](ACTIVATION.md)）。

**固件升级（DFU）已不在这一节**：路线 A 的最小可用版本已落地（守护进程的 `dfu/`
子包 + 四条 `firmware_*` 命令 + 设置页的「固件升级」段），见
[`daemon/README.md`](../daemon/README.md) 的「固件升级」一节。**镜像的托管分发与
在线检查更新仍不做** —— 今天镜像是操作员自己选的文件，所以没有版本清单，也没有签名。

---

## 7. 风险

| 风险 | 应对 |
| --- | --- |
| 固件 mode 语义未在真机核实 | 用本地程序的「运动在飞」判定 `moving`；真机到手后校准 |
| `litearm-python` 不在 PyPI | 打包时内嵌，不从索引安装；SDK 版本被钉在打包那一刻 |
| 嵌入式窗口依赖 webview | `ui` extra 一并打进单文件可执行程序；Linux 走 Qt（纯 pip）或系统 GTK，Windows/macOS 用系统自带的内核 |
| Linux 打包需 Ubuntu 22.04 基准 | 沿用现有容器化构建规范 |
| 旧仓历史被弃用后 teleop 源码丢失 | Phase 1 先做镜像备份，Gitee 远端亦保留 |
