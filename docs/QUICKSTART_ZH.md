---
title: "LiteArm"
subtitle: "快速上手指南"
title-meta: "LiteArm 快速上手指南"
author: "NEXFORM 新元体"
version: "v2.1"
date: "2026 年 10 月 6 日"
---

# LiteArm 快速上手指南

## 1. 系统架构与环境要求

LiteArm Studio 是「本地 Python 程序 + 浏览器界面」：程序独占到机械臂的 USB 串口，界面由该程序托管，并通过本机回环上的 WebSocket 与它通信。**没有 server，也没有要填的 IP。**

```
浏览器窗口 (React UI，由本地程序托管)
   │  HTTP  → 静态资源、/api/health
   │  WS    → 状态推送(下行) / 命令(上行)
   ▼
litearm-studio-daemon  (Python，只监听 127.0.0.1)
   ▼
litearm-python  ──USB CDC (1d50:606f @921600)──>  STM32  ──CAN──>  电机
```

### 环境要求

- 控制主机：Linux 或 Windows，有一个空闲 USB 口；Python 3.10+
- 机械臂控制器已上电并通过 USB 连接（USB CDC，VID:PID `1d50:606f`）
- 只有自己构建界面时才需要 Node.js 20+ 与 pnpm

---

## 2. 安装

有两条路。只想运行发布版，就下载单文件可执行程序并照着 [INSTALL.md](INSTALL.md) 做 —— 不需要
Python、不需要 pnpm、也不需要克隆仓库。下面的命令是源码构建，开发时才需要。

`litearm-python` 不在 PyPI 上，必须先克隆并本地安装：

```bash
git clone https://github.com/nexform-tech/litearm-python.git
git clone https://github.com/nexform-tech/litearm-studio.git
cd litearm-studio

pip install -e ../litearm-python
pip install -e "daemon[test]"
```

构建本地程序要托管的界面（`dist/` 已存在可跳过）：

```bash
pnpm install && pnpm build
```

---

## 3. 启动

```bash
# 离线：用 SDK 的假传输跑完整会话，不需要任何硬件
litearm-studio-daemon --fake

# 真机：自动发现 USB CDC 设备
litearm-studio-daemon

# 指定串口 / 端口 / 不自动开窗口
litearm-studio-daemon --port /dev/ttyACM1 --http-port 9000 --no-open
```

启动后会打印实际监听的地址（默认 `http://127.0.0.1:8765/`；被占用会自动换并打印新端口），并在有 Chromium 系浏览器时以 `--app=` 模式开窗，否则退回普通标签页。

| | |
| --- | --- |
| 控制台 | `http://127.0.0.1:<port>/` |
| WebSocket | `ws://127.0.0.1:<port>/ws` |
| 健康检查 | `http://127.0.0.1:<port>/api/health` |

> [!IMPORTANT]
> 本地程序**只监听 `127.0.0.1`**，没有开给局域网的开关 —— 一个能驱动机械臂的接口不该被发布出去。

---

## 4. 首次冒烟验证

### 第 1 步 —— 激活

未激活的机械臂**会拒绝使能**（固件回 `ERR{0x10,0x08}`），其余命令一切照常。打开 **设置 → 授权激活**：

1. 面板显示 **未激活** 与**设备 UID**（24 位十六进制）。这串 UID 由程序从机械臂读出，**不用手输**，通常也不用发给谁——供应商在发货前已按它录好凭据；
2. 填写注册信息（**姓名 / 电话 / 单位 / 邮箱 / 所在地区必填**），并同意《激活注册信息同意书》；
3. **先点控制栏的「失能」**——固件要求失能状态才写入授权记录——再点「提交并激活」。

成功后面板显示 **已激活**，固件随后才允许使能。只有提示「没有这台机器的凭据」时，才需要点「复制」把 UID 发给供应商补录。细节见用户手册 §1.4。

### 第 2 步 —— 连接与使能

1. 打开控制台（本地程序会替你打开）。
2. 顶栏显示连接状态；连上后会显示本次解析到的 **端口名 · 固件版本**。若会话未建立，点 **连接**。
3. 确认 3D 模型正常渲染，J1–J7 有实时读数。
4. 点击控制栏上的 **使能** 开关。

### 第 3 步 —— 验证运动

> [!WARNING]
> 使能或下发运动前，请清空机械臂工作范围，确保没有人员与障碍物。**STOP** 会下发急停，且在运动过程中依然可达。

1. **点动**：选中 J1，速度设 10–20 %，用滑条轻微点动，确认动作平滑。
2. **回零**：点击回零位，执行固件的低速度回零。
3. **STOP**：按一次，确认机械臂立刻降能量。

### 第 4 步 —— 遥测

打开「遥测」页：机械臂连接后会自动创建会话、在本机记录采样，**导出 CSV** 可把选中会话写盘。

---

## 5. 常见问题

### 启动报找不到 `litearm` 模块

`litearm-python` 不在 PyPI 上，需从检出目录安装：`pip install -e ../litearm-python`。

### 提示「未发现 STM32 CDC 设备」

- 检查 USB 线缆与控制器供电。
- 确认设备以 VID:PID `1d50:606f` 枚举。
- 若它出现在别的设备路径下，显式指定：`litearm-studio-daemon --port /dev/ttyACM1`。
- Linux 下确认当前用户有权限打开串口设备（`dialout` 组）。

### 点「使能」没有反应 / 提示未激活

这台机器还没激活：固件把授权检查放在使能的**第一条**判据上，未激活时一律拒绝（`ERR{0x10,0x08}`），重发无用。

去 **设置 → 授权激活**，按 §4 第 1 步完成激活。未激活不影响除使能以外的操作。

### 界面能打开但一直没有状态

- 访问 `http://127.0.0.1:<port>/api/health`，`connected` 必须为 `true`。
- 若 `conn.status` 是 `error`，`conn.error` 字段就是原因（设备不存在、固件不匹配、链路故障）。

### 8765 端口被占用

本地程序会自动往后找空闲端口并打印，请以打印出的地址为准，不要假定是 8765。

### 关掉窗口后界面没了，但机械臂还连着

这是刻意设计：关窗口**不会**打断已在执行的会话。要结束会话请在界面里点 **断开** 或 **STOP**，或直接停掉本地程序进程。
