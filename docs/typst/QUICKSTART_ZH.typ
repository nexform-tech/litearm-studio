// LiteArm 快速上手指南 —— Typst 排版版本
// 源文档: docs/QUICKSTART_ZH.md
//
// 编译命令（在 docs/typst 目录下执行）:
//   typst compile --root ../.. QUICKSTART_ZH.typ ../dist/LiteArm_Quickstart_ZH_typst.pdf
//
// 参考字体: Lato / Noto Serif CJK SC / Noto Sans CJK SC / JetBrains Mono

#set document(
  title: "LiteArm 快速上手指南",
  author: "NEXFORM ROBOTICS",
)

// ---------- 基础排版 ----------

#set page(
  paper: "a4",
  margin: (top: 2.4cm, bottom: 2.2cm, x: 2.2cm),
  numbering: "I",
  header: align(center)[
    #text(size: 9pt, fill: rgb("#8A8F98"))[LiteArm 快速上手指南]
    #line(length: 100%, stroke: 0.5pt + rgb("#E2E8F0"))
    #v(0.35cm)
  ],
  footer: context {
    align(center)[
      #v(0.25cm)
      #text(size: 9pt)[#counter(page).display()]
    ]
  },
)

#set text(
  font: ("Lato", "Noto Serif CJK SC", "DejaVu Sans"),
  lang: "zh",
  region: "cn",
  size: 10.5pt,
)
#set par(justify: true, leading: 0.56em, spacing: 0.75em)
#show heading: set text(font: ("Lato", "Noto Sans CJK SC"), weight: 700)
#show heading: set block(above: 1.1em, below: 0.55em)
#show heading.where(level: 1): set text(size: 17pt)
#show heading.where(level: 2): set text(size: 13.5pt)
#show heading.where(level: 3): set text(size: 11.5pt)
#show heading.where(level: 4): set text(size: 10.8pt)

#let chapter-number(..nums) = {
  let arr = nums.pos()
  if arr.len() == 1 {
    str(arr.at(0)) + "."
  } else {
    arr.map(str).join(".")
  }
}
#set heading(numbering: chapter-number)

// 一级标题居中
#show heading.where(level: 1): it => align(center, it)

// ---------- 表格与代码块样式 ----------

#set table(
  inset: 8pt,
  stroke: 0.6pt + rgb("#DADEE5"),
  fill: (x, y) => if y == 0 { rgb("#F2F4F8") } else { none },
)
#show raw: set text(
  font: ("JetBrains Mono", "Noto Sans CJK SC"),
  size: 0.85em,
)
#show raw.where(block: false): box.with(
  fill: rgb("#F1F5F9"),
  inset: (x: 3pt, y: 1pt),
  outset: (y: 1pt),
  radius: 3pt,
)
#show raw.where(block: true): block.with(
  fill: rgb("#F8FAFC"),
  stroke: 0.6pt + rgb("#E2E8F0"),
  inset: (x: 10pt, y: 8pt),
  radius: 4pt,
  breakable: true,
)

// ---------- 提示框 ----------

#let callout(title, color, body) = block(
  fill: color.lighten(86%),
  stroke: (
    left: (paint: color, thickness: 3.5pt),
    top: (paint: color.lighten(45%), thickness: 0.6pt),
    right: (paint: color.lighten(45%), thickness: 0.6pt),
    bottom: (paint: color.lighten(45%), thickness: 0.6pt),
  ),
  radius: 4pt,
  inset: (x: 12pt, y: 9pt),
  above: 0.85em,
  below: 0.85em,
)[
  #text(
    font: ("Lato", "Noto Sans CJK SC"),
    size: 10pt,
    weight: "bold",
    fill: color,
  )[#title]
  #v(3pt)
  #body
]

#let note-box(body) = callout("注意", rgb("#2563EB"), body)
#let warning-box(body) = callout("警告", rgb("#D97706"), body)

#let quote-box(color, body) = block(
  fill: color.lighten(90%),
  stroke: (left: (paint: color, thickness: 3pt)),
  radius: 3pt,
  inset: (x: 12pt, y: 8pt),
  above: 0.6em,
  below: 0.6em,
)[#body]

// ============================================================
// 封面
// ============================================================

#page(header: none, footer: none, numbering: none)[

#align(center, image("../pdf-config/logo.png", height: 1.4cm))
#v(0.4cm)
#align(
  center,
  text(
    font: ("Lato", "Noto Sans CJK SC"),
    size: 13pt,
    weight: "bold",
  )[NEXFORM ROBOTICS],
)

#v(1.1cm)

#align(
  center,
  text(
    font: ("Lato", "Noto Sans CJK SC"),
    size: 26pt,
    weight: "bold",
  )[LiteArm],
)
#v(0.4cm)
#align(
  center,
  text(
    font: ("Lato", "Noto Sans CJK SC"),
    size: 20pt,
    weight: "bold",
  )[快速上手指南],
)

#v(0.7cm)

#align(center, image("../images/litearm.png", height: 10.2cm))

#v(1fr)

#align(
  center,
  text(
    font: ("Lato", "Noto Sans CJK SC"),
    size: 13pt,
    weight: "bold",
  )[NEXFORM ROBOTICS],
)
#v(0.3cm)
#align(
  center,
  text(
    font: ("Lato", "Noto Sans CJK SC"),
    size: 10.5pt,
  )[版本：V1.0 #h(1.2em) 日期：2026 年 9 月],
)
] 

// ============================================================
// 版本修订记录
// ============================================================

#heading(level: 1, numbering: none, outlined: false)[版本修订记录]

#table(
  columns: (1fr, 1.3fr, 3.5fr),
  align: (center, center, start),
  [*版本号*], [*变更日期*], [*变更说明*],
  [V1.0], [2026.09.07], [LiteArm 快速上手指南初版发布],
)

// ============================================================
// 目录
// ============================================================

#pagebreak()

#outline(title: [目录], depth: 3)

// 正文阿拉伯页码从 1 开始
#set page(numbering: "1")
#counter(page).update(1)
#pagebreak()

// ============================================================
// 安全须知
// ============================================================

#heading(level: 1, numbering: none)[安全须知]

在安装、配置或使用 LiteArm 机械臂之前，请务必仔细阅读本手册及相关配套文档。为保障人员人身安全及设备正常运行，请严格遵守以下安全准则：

+ *电气与供电规范*：请确保机械臂使用原装配备的电源适配器与通信调试线缆。工作输入电压为直流 *24V \~ 48V*，请勿使用破损的电源线、插头或松脱的电源插座。
+ *结构安装与环境*：机械臂底座必须通过高强度螺栓牢固固定在平整刚性基座或台架上。安装表面需能承受机械臂全速运动时的倾覆力矩。
+ *运动防撞与安全区域*：机械臂工作半径范围内严禁站立人员或堆放障碍物。在进行任何通电动作测试前，请务必确认运动包络空间净空。
+ *温升与过热保护*：长时间大负载或高速往复运行可能导致电机模组温度升高。若电机温度异常，内置热保护会自动降额或停机，此时应停止运行并静置冷却。
+ *专业操作与严禁私拆*：本设备仅限经过机器人安全操作培训的工程人员使用。机械臂内部集成了精密谐波减速机构、编码器与驱动电路，严禁私自拆解外壳或关节，私拆将失去质保权益。
+ *紧急停止响应*：调试与运行期间，操作人员需随时保持在上位机图形界面「STOP」软急停按钮或物理急停开关可触达范围，出现轨迹异常时应第一时间切断使能。

#pagebreak()

// ============================================================
// 1. 产品介绍
// ============================================================

= 产品介绍

LiteArm 是由 *NEXFORM ROBOTICS* 针对具身智能、工业自动化、医疗协作及科研教学场景研发的高性能 *7 自由度轻量化仿生协作机械臂*。整机采用高度集成化的驱控一体伺服关节与轻质高刚性连杆设计，在保证高负载自重比的同时具备人臂般的灵巧避障与操作能力。

== 核心特性

+ *7 自由度冗余构型*：拥有超越常规 6 轴机械臂的零空间运动冗余，可在末端位姿保持不变的前提下灵活避让机身障碍物，极度适合狭窄空间作业。
+ *驱控一体伺服模组*：自研轻量化电机模组，内置高精度双绝对值编码器，实现高速高精度的力位闭环伺服控制。
+ *全开放多层软件生态*：配套提供跨平台图形化控制软件 *LiteArm Studio*、高性能 *Python SDK* 及 *ROS / ROS2* 开源驱动包。
+ *数字孪生实时反馈*：原生支持 3D 机械臂数字孪生渲染与 250 Hz 高频双向状态遥测。

== 产品外观与结构

#align(center, image("../images/litearm.png", height: 6cm))

== 核心规格参数

#table(
  columns: (1.15fr, 1fr, 1.5fr),
  align: (start, center, start),
  [*性能指标*], [*参数规格*], [*备注说明*],
  [*产品型号*], [LiteArm-7D], [7 自由度协作型机械臂],
  [*自由度 (DOF)*], [7 自由度], [拟人化构型 (J1 \~ J7)],
  [*额定有效负载*], [1.5 kg], [峰值最大负载 3.0 kg],
  [*整机自重*], [约 2.8 kg], [高负载自重比轻量化设计],
  [*工作半径 (臂展)*], [650 mm], [末端法兰最大触及距离],
  [*重复定位精度*], [±0.15 mm], [经过精密标定补偿],
  [*工作电压*], [DC 24V \~ 48V], [推荐标准 24V / 10A 稳压供电],
  [*整机额定功率*], [150 W], [待机功耗约 15 W],
  [*通信接口*], [CAN (1 Mbps) / WebSocket], [支持 USB-CAN 适配器直连],
  [*上位机控制频率*], [250 Hz], [底层电机驱动环达 1 kHz],
  [*末端安装接口*], [标准快换机械法兰], [兼容各主流电动夹爪与快换夹具],
)

== 系统架构与通信拓扑

机械臂通过 USB-CAN 适配器连接运行控制服务的主机（用户电脑或独立工控机/计算盒）。系统原生支持单机同屏操作与分布式局域网控制两种模式：

#align(center, image(read("../images/zh/system_architecture.png", encoding: none), width: 100%))

#heading(level: 3, numbering: none, outlined: false)[部署模式说明]

- *单机直连模式*：控制服务（`litearm-server`）与 Studio 上位机均运行在同一台电脑上，Studio 直接连接 `127.0.0.1:7449`；
- *独立主机模式*：控制服务运行在连接机械臂的独立工控机或计算盒上，用户在局域网内通过另一台电脑的 Studio 连接其主机 IP。

#heading(level: 3, numbering: none, outlined: false)[默认通信端口与配置]

- *上位机通信端口*：`7449`（WebSocket 协议，单机填写 `127.0.0.1`，跨机填写实际局域网 IP）
- *Python SDK 端口*：`7447`（RPC / Zenoh 协议）
- *CAN 接口*：默认 `can0`（波特率 1M，服务启动时由 systemd 自动初始化拉起）

#line(length: 100%, stroke: 0.7pt + rgb("#DADEE5"))

// ============================================================
// 2. 安装与准备
// ============================================================

= 安装与准备

== 配件清单

在进行机械臂安装前，请仔细核对包装箱内的配件清单是否齐全：

#table(
  columns: (0.55fr, 1.9fr, 0.6fr, 1.8fr),
  align: (center, start, center, start),
  [*序号*], [*配件名称*], [*数量*], [*规格说明*],
  [1], [LiteArm 7自由度机械臂本体], [1 台], [出厂经过标定与全行程检验],
  [2], [USB 转 CAN 调试适配线], [1 根], [工业级隔离芯片，预制专用接插件],
  [3], [24V 工业电源适配器], [1 个], [输出 24V / 10A，带过流过压保护],
  [4], [AC 交流输入电源线], [1 根], [标准三脚国标插头],
  [5], [底座固定螺栓包], [1 套], [4 颗 M5 高强度内六角螺栓及垫片],
)

== 机械与电气安装

#heading(level: 3, numbering: none, outlined: false)[机械安装说明]

+ 将机械臂垂直放置于厚度不小于 10 mm 的平整金属台面或专用实验台上。
+ 对准底座安装法兰上的 4 个直径 5.5 mm 固定孔，使用配件包中的 M5 螺钉均匀对角拧紧，推荐锁紧力矩为 4.5 N·m。

#heading(level: 3, numbering: none, outlined: false)[电气接线与线序说明]

机械臂基座侧配备快速接插航空端子，引脚线序定义如下：

#table(
  columns: (0.9fr, 0.9fr, 0.8fr, 1.7fr),
  align: (center, center, center, start),
  [*线序 / 针脚*], [*信号名称*], [*线缆颜色*], [*功能说明*],
  [*1*], [CAN-H], [白色], [CAN 总线高差分信号 (1 Mbps)],
  [*2*], [CAN-L], [绿色], [CAN 总线低差分信号 (1 Mbps)],
  [*3*], [GND], [黑色], [直流供电负极 / 系统参考地],
  [*4*], [VCC], [红色], [直流供电正极输入 (DC 24V \~ 48V)],
)

#note-box[
  请务必在断电状态下插拔电源与 CAN 线缆，严禁带电热插拔主电源接口！
]

== 后端控制服务部署 (litearm-server)

#heading(level: 3, numbering: none, outlined: false)[1. 安装软件包]

在连接机械臂的 Ubuntu 22.04 主机（电脑或工控机）上执行：

```bash
sudo dpkg -i litearm-server_<版本号>_amd64.deb
```

#quote-box(rgb("#2563EB"))[
  安装后系统会自动注册 `litearm-server-bin.service` 服务。服务启动时会自动拉起并配置 `can0` 接口为 1M 波特率。
]

#heading(level: 3, numbering: none, outlined: false)[2. 配置运行模式]

配置文件路径：`/etc/litearm-server.env`

- *实机模式*：连接好 USB-CAN 适配器与机械臂电源，保持默认文件内容即可。
- *仿真模式 (Dry-Run)*：若手头未连接物理机械臂或 CAN 硬件，需开启仿真模式以避免驱动初始化报错：

```
LITEARM_EXTRA_ARGS="--dry-run"
```

#heading(level: 3, numbering: none, outlined: false)[3. 启动后台服务]

```bash
# 启动后台服务
sudo systemctl start litearm-server-bin

# 查看运行状态与即时日志
sudo systemctl status litearm-server-bin
sudo journalctl -u litearm-server-bin -f -n 50
```

#quote-box(rgb("#2563EB"))[
  当终端日志输出 `WebSocket server listening on port 7449` 即表示服务启动就绪。
]

#heading(level: 3, numbering: none, outlined: false)[4. 终端调试与无头操控（可选）]

如需在纯终端环境下验证机械臂通信：

```bash
# 前台调试启动服务（带调试日志）
litearm-server --dry-run --log-level DEBUG

# CLI 读取当前 7 关节角度
python3 -c "import litearm; arm=litearm.Arm('tcp/127.0.0.1:7447'); print('当前关节角:', arm.get_state().q); arm.close()"

# CLI 一键回零
python3 -c "import litearm; arm=litearm.Arm('tcp/127.0.0.1:7447'); arm.home(); arm.close()"
```

== 上位机安装 (LiteArm Studio)

#heading(level: 3, numbering: none, outlined: false)[Windows 系统]

+ 从发布页下载 `litearm-studio-<版本号>-windows-amd64.exe`，双击运行即可，没有安装向导。
+ 程序未做代码签名，首次运行 Windows 会提示"Windows 已保护你的电脑"，选择"更多信息"→"仍要运行"。
+ 校验下载：`certutil -hashfile litearm-studio-<版本号>-windows-amd64.exe SHA256`，与同目录的 `.sha256` 比对。

#heading(level: 3, numbering: none, outlined: false)[Linux / Ubuntu 系统]

```bash
# 单文件可执行程序，免安装；需要 glibc 2.35 及以上（Ubuntu 22.04+ / Debian 12+）
mkdir -p ~/Applications && cd ~/Applications
version=0.11.0
base="https://github.com/nexform-tech/litearm-studio/releases/download/v${version}"
curl -LO "$base/litearm-studio-${version}-linux-amd64"
curl -LO "$base/litearm-studio-${version}-linux-amd64.sha256"

sha256sum -c "litearm-studio-${version}-linux-amd64.sha256"   # 应输出 OK
chmod +x "litearm-studio-${version}-linux-amd64"              # 下载后没有执行权限
./"litearm-studio-${version}-linux-amd64"
```

#quote-box(rgb("#2563EB"))[
  发布附件只有上面这两个单文件可执行程序：没有 `.deb` 包，也没有 AppImage。串口权限（`dialout` 组）
  与首次激活步骤见仓库的 docs/INSTALL.md。
]

// ============================================================
// 3. 首次联调与测试
// ============================================================

= 首次联调与测试

#heading(level: 3, numbering: none)[步骤 1：连接控制服务]

+ 打开 *LiteArm Studio* 上位机软件。
+ 点击顶部导航栏左侧的控制器连接徽标，调出「控制器连接设置」浮窗。
+ 根据部署架构填写 IP 地址，端口保持 `7449`，点击「连接」：
  - *单机直连*：保持默认 `127.0.0.1`；
  - *独立工控机*：输入工控机的局域网 IP 地址（例如 `192.168.1.100`）。

#align(center, image("../images/zh/02_header_endpoint_modal.png", width: 85%))

#quote-box(rgb("#2563EB"))[
  *连接成功标志*：顶栏徽标变为绿色圆点并显示 `已连接`，右侧遥测通信频率实时跳动在 *250 Hz* 左右。
]

#heading(level: 3, numbering: none)[步骤 2：检查 3D 模型与关节读数]

切换到「单臂控制」页面，确认左侧 3D 视图中机械臂数字孪生模型正常加载，且右侧 J1 \~ J7 关节角度显示有效浮点数值，无掉线或通信中断报警。

#heading(level: 3, numbering: none)[步骤 3：动作验证与慢速点动]

#warning-box[
  实机运行测试前，请再次确认机械臂活动范围内没有任何障碍物，手部随时准备点击右上角红色「STOP」急停按键。
]

+ *使能机械臂*：点击控制区上方的「使能」开关，此时机械臂各关节进入伺服锁轴就绪状态。
+ *点动测试*：在关节控制区选择 *J1 轴*，将运动速度滑块调整为安全低速（*10% \~ 20%*），点击 `+` 按键让 J1 轴微动 1° \~ 2°，观察 3D 模型与物理机械臂动作是否平滑跟随。
+ *回零测试*：点击「一键回零位」按钮，机械臂将平稳过渡并停靠至标准待命零位姿态。

// ============================================================
// 4. 常见问题排查 (FAQ)
// ============================================================

= 常见问题排查 (FAQ)

#heading(level: 3, numbering: none)[Q1：上位机提示连接失败或连接超时？]

+ 确认连接地址与端口填写正确（本机默认为 `127.0.0.1:7449`）。
+ 检查控制端后台服务运行状态：

  ```bash
  sudo systemctl status litearm-server-bin
  ```

+ 若服务未处于 active 状态，执行 `sudo systemctl start litearm-server-bin` 重新拉起；若为 failed，请参照 Q2 排查。
+ 若跨电脑局域网连接，请检查两台设备是否处于同一子网并能相互 `ping` 通，且工控机防火墙已放行 7449 端口：`sudo ufw allow 7449/tcp`。

#heading(level: 3, numbering: none)[Q2：控制端服务启动失败 (failed) 或频繁重启退出？]

- 执行命令查看详细日志：`sudo journalctl -u litearm-server-bin -e`
- *原因 1：USB-CAN 适配器未正确连接或接口名称不匹配*
  - 服务启动时会自动初始化 `can0`。若未插 USB-CAN 适配器，服务将直接退出报错。
  - 使用 `ip link show can0` 及 `dmesg | grep -i can` 排查系统是否识别到硬件设备。
  - 若系统识别出的 CAN 接口为 `can1`，需在 `/etc/litearm-server.env` 中指定 `LITEARM_IFACE="can1"`。
- *原因 2：未连接硬件但未开启仿真模式*
  - 在纯软件或无实机测试时，必须在 `/etc/litearm-server.env` 中配置 `LITEARM_EXTRA_ARGS="--dry-run"` 后重启服务。
- *原因 3：机械臂供电异常*
  - 检查 24V 开关电源指示灯是否正常亮起，测量端子输入电压是否在 24V \~ 48V 正常区间。

#heading(level: 3, numbering: none)[Q3：3D 视口显示黑屏或提示 WebGL 初始化失败？]

- 确认系统显卡驱动正常且支持硬件加速。
- 若在虚拟机（VMware / VirtualBox）或远程桌面中使用，请在虚拟机设置中开启「3D 图形加速 (Accelerate 3D Graphics)」。

// ============================================================
// 5. 售后服务与附录
// ============================================================

= 售后服务与附录

== 售后与服务须知

+ *保修期限*：LiteArm 系列产品自购买交付之日起，享受官方 *12 个月的有限保修服务*。
+ *保修服务*：在保修期内，凡因制造工艺、设计或原材料缺陷导致的设备硬件故障，NEXFORM ROBOTICS 将提供免费的检测、维修或零部件更换服务。
+ *免责与非保修范围*：
  - 因未按产品手册要求安装、接线、供电导致的电气击穿或机械损坏；
  - 撞机、跌落、不可抗力或私自拆卸关节模组导致的损坏；
  - 正常使用过程中的机械外观磨损与自然老化。
+ *报修与技术支持流程*：若设备发生不可自愈故障，请及时记录现场报错日志并联系官方售后支持，请勿强行通电或自行拆解。

== 软件开发包 (SDK) 开源生态

开发者可自由获取 LiteArm 原生支持的多语言 SDK 开源项目：

- *Python SDK*：#link("https://github.com/nexform-robotics/litearm-python-sdk")[https://github.com/nexform-robotics/litearm-python-sdk]
- *ROS / ROS2 驱动包*：#link("https://github.com/nexform-robotics/litearm-ros2")[https://github.com/nexform-robotics/litearm-ros2]
- *URDF / 机械臂仿真模型库*：#link("https://github.com/nexform-robotics/litearm-description")[https://github.com/nexform-robotics/litearm-description]

== 官方联系方式

*NEXFORM ROBOTICS*

- *技术支持邮箱*：support\@nexform.cn
- *商务合作邮箱*：business\@nexform.cn
- *官方网站*：#link("https://www.nexform.cn")[https://www.nexform.cn]
- *公司地址*：北京市海淀区中关村前沿机器人产业创新中心
