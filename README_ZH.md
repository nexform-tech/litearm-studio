# LiteArm Studio

[English](README.md) | **简体中文**

**LiteArm Studio** 是 LiteArm 七自由度协作机械臂的操作上位机。它是「本地 Python 程序 + 浏览器界面」：**只有本地程序碰硬件**，界面通过 `127.0.0.1` 上的 WebSocket 与它通信。

---

## 架构

```
浏览器窗口 (React UI)
   │  HTTP  → 静态资源、/api/health
   │  WS    → 状态推送(下行) / 命令(上行)
   ▼
litearm-studio-daemon  (Python, 只监听本机, `daemon/`)
   ▼
litearm-python  ──USB CDC (1d50:606f)──>  STM32  ──CAN──>  电机
```

- **本地程序独占机械臂**：自动发现 USB CDC 设备（或 `--port` 指定），以 50 Hz 从 SDK 的缓存帧推送归一化状态；所有 SDK 调用跑在同一条单线程执行器上。急停与失能走**另一条**通道，运动在途时依然可达。
- **本地程序同时托管界面**：提供静态资源，并以 Chromium `--app=` 模式开无地址栏窗口（找不到就退回普通标签页）。**关掉窗口不会打断已在执行的会话。**
- **只监听 `127.0.0.1`**：换地址只能改代码 —— 把一个能驱动机械臂的接口暴露到局域网是安全事故，不是配置项。

---

## ✨ 核心特性

- 🦾 **单臂运动控制**
  - 基于真实 URDF 模型的 3D 数字孪生与坐标系可视化；
  - J1–J7 关节滑条，量程取自控制器自己的软限位（`get_joint_params`），支持实时下发与批量暂存下发；
  - 笛卡尔空间点动（基座/工具坐标系）与目标位姿直线运动（`movel`）；
  - 就绪姿态、固件低速度回零、零重力拖动示教、使能/失能、清除故障；
  - 高优先级 **STOP**（急停），运动过程中依然可达。
- 📈 **遥测**
  - 10 Hz 全轴采样（角度、角速度、力矩、驱动温度、驱动错误码）；
  - 本地 IndexedDB 会话记录，保留上限可配（10–500 MB），支持导出 CSV。
- 🌐 **国际化** —— 简体中文 / English。

### 本版不做

轨迹拖拽示教与回放、控制器日志页、夹爪/灵巧手面板、逐关节阻抗与保持模式（见 [docs/REFACTOR_PLAN.md](docs/REFACTOR_PLAN.md) §5–6）。设置与校准页（负载、增益、限位、自检）**尚未接线**：本地程序已有对应命令，但界面还到不了。

---

## 🚀 快速开始

### 1. 环境准备

- **Node.js** `v20.0.0`+ 与 **pnpm**（`corepack enable` 或 `npm install -g pnpm`）
- **Python** 3.10+（运行本地程序）
- `litearm-python` —— **不在 PyPI 上**，需克隆后本地安装：

```bash
git clone https://github.com/nexform-tech/litearm-python.git
```

### 2. 跑起完整应用

```bash
cd litearm-studio
pip install -e ../litearm-python
pip install -e "daemon[test]"     # 装 fastapi/uvicorn，并提供 litearm-studio-daemon 入口
pnpm install && pnpm build         # 构建本地程序要托管的界面

litearm-studio-daemon --fake       # 离线：用 SDK 的假传输跑完整会话，不碰硬件
# litearm-studio-daemon --fake --fake-unactivated   # 不碰硬件，而且这台假设备**未激活**：
#                                                   # 「设置 → 授权激活」会显示注册表单
# litearm-studio-daemon            # 真机：自动发现 USB CDC 设备
# litearm-studio-daemon --port /dev/ttyACM1 --http-port 9000 --no-open
```

假设备默认是**已激活**的，所以授权面板只显示状态、不出表单。加上 `--fake-unactivated`
就能把未激活那条路整条走一遍：注册表单、激活注册信息同意书，以及按
「使能」时固件回的那句 `ERR{0x10,0x08}`。

启动后会打印实际监听的地址（默认 `http://127.0.0.1:8765/`，被占用会自动换端口）并打开窗口。

### 3. 只调前端

```bash
pnpm install
pnpm dev        # http://localhost:5173 —— 把 /ws 与 /api 代理到 127.0.0.1:8765
```

另开一个终端跑 `litearm-studio-daemon --fake --no-open` 即可。

### 4. 预打包可执行文件

每个 release 都会附带 Windows / Linux 的单文件可执行程序（`litearm-studio-<版本>-<平台>`）
以及每个附件旁的 `.sha256` 校验和。它们把本地程序、`litearm` SDK 与构建好的界面都打在里面，**目标机器
不需要装 Python、不需要 pnpm、也不需要克隆仓库** —— 直接运行，控制台窗口就会打开：

```bash
./litearm-studio-0.5.0-linux-amd64 --fake     # 离线，不碰硬件
./litearm-studio-0.5.0-linux-amd64            # 真机，自动发现 USB 设备
```

发布附件由 `.github/workflows/release.yml` 的 `package` job 产出；自己构建则先 `pnpm build`
再执行 `python packaging/build.py`。

Windows 可执行文件使用 `assets/litearm.ico` 作为图标。该文件已入库，正常构建不需要重新生成；
只有在品牌标识变化时才需要重建，并且始终以 `assets/icon-source.svg` 为准：

```bash
pnpm icon     # 重新渲染 assets/icon-png/*.png 并重写 assets/litearm.ico
```

不要把 `--icon` 指向仓库之外的文件：发布流程检出的是干净的工作区，未入库的图标会让
PyInstaller 悄悄退回它自带的默认图标。

---

## 📖 文档

- 📕 **[用户操作手册 (简体中文)](docs/USER_MANUAL_ZH.md)** —— ⚠️ 仍在描述已下线的 server 版，正在重写。
- 📘 **[User Manual (English)](docs/USER_MANUAL.md)** —— ⚠️ 同上。
- **[快速开始](docs/QUICKSTART_ZH.md)** / **[Quickstart](docs/QUICKSTART.md)**
- **[重构计划](docs/REFACTOR_PLAN.md)** —— 架构、接口契约与范围决策。
- **[本地程序说明](daemon/README.md)**

---

## 📋 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `pnpm dev` | 启动 Vite 开发服务器（代理到本机 daemon） |
| `pnpm build` | 前端生产构建（输出 `dist/`，即 daemon 托管的内容） |
| `pnpm preview` | 本地预览生产构建产物 |
| `pnpm test` | 运行 Vitest 单元测试 |
| `pnpm lint` | 执行 oxlint 静态检查 |
| `pnpm exec tsc -b` | TypeScript 类型检查 |
| `python -m pytest daemon/tests -q` | 本地程序单元测试（不需要硬件） |

---

## 📄 授权许可

本项目采用 **Apache License 2.0** 开源授权协议 - 详见 [LICENSE](LICENSE) 文件。

Copyright © 2026 语道科技 / YuDao. All rights reserved.
