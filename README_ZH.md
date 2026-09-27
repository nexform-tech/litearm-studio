# LiteArm Studio

[English](README.md) | **简体中文**

**LiteArm Studio** 是专为 LiteArm 七自由度协作机械臂打造的新一代图形化上位机控制台。基于 React 19、TypeScript、Three.js 与 Vite 构建，在浏览器中提供高性能实时运动控制、3D 动力学可视化、轨迹拖拽示教与全周期遥测诊断能力。

---

## 📖 文档与操作手册

- 📕 **[用户操作手册 (简体中文)](docs/USER_MANUAL_ZH.md)**
- 📘 **[User Manual (English)](docs/USER_MANUAL.md)**

---

## ✨ 核心特性

- 🦾 **单臂运动控制**：
  - 基于真实 URDF 模型的 3D 数字孪生姿态渲染与空间坐标系可视化；
  - J1–J7 关节空间独立滑条控制，支持实时松手下发与批量暂存下发模式；
  - 笛卡尔空间方向点动盘（基座/工具坐标系）与目标位姿直线插补（`movel`）；
  - 高优先级软件急停（**STOP**）、一键回零位、就绪姿态定位与伺服清错。
- 🎬 **轨迹拖拽示教与回放**：
  - 零重力模式下手把手拖拽示教录制（100 Hz 高频采样）；
  - 控制器端轨迹库管理、多倍速回放（0.25× 至 2.0×）、循环回放与中途安全接管。
- 📈 **遥测与系统诊断**：
  - 10 Hz 实时全轴状态采样（角度、角速度、输出力矩、驱动温度与跟踪误差）；
  - 本地 IndexedDB 数据库会话记录，支持自定义保留上限（10–500 MB）与一键导出 CSV；
  - 控制器后台服务运行日志实时流式读取、级别过滤与关键词搜索。
- ⚙️ **系统校准与高级设置**：
  - 末端工具负载质量与质心偏置（COM）重力补偿校准；
  - 机械臂安装姿态校准（正装、倒吊装、侧立装）；
  - 关节安全限位边界监控、驱动器闭环 PD 增益调节与后台守护服务安全重启。

---

## 🛠️ 技术栈

- **前端核心**：React 19, TypeScript, Vite 8, Tailwind CSS v4
- **3D 可视化**：Three.js, URDF-Loader
- **数据与组件**：IndexedDB（本地遥测引擎）, Radix UI, Lucide Icons, Sonner
- **国际化**：i18next（简体中文 / English）

---

## 🚀 快速开始

### 1. 环境准备

- **Node.js**：`v20.0.0` 或更高版本
- **包管理器**：`pnpm`（`corepack enable` 或 `npm install -g pnpm`）
- **机械臂控制器**：已上电并通过 USB 连接；上位机经 [`litearm-python`](https://github.com/nexform-tech/litearm-python) SDK 直连（无需 server，也无需 IP）

### 2. 网页端开发调试

```bash
# 将 SDK 与上位机项目克隆到同级目录下
git clone https://github.com/nexform-tech/litearm-js.git
git clone https://github.com/nexform-tech/litearm-studio.git

cd litearm-studio
pnpm install

# 启动本地开发服务器
pnpm dev
```

在浏览器中打开 `http://localhost:5173`。

> **项目状态**：传输层正从已下线的 `litearm-server` 迁移到本地控制程序，详见 [docs/REFACTOR_PLAN.md](docs/REFACTOR_PLAN.md)。

---

## 📋 常用开发命令

| 命令 | 说明 |
| :--- | :--- |
| `pnpm dev` | 启动 Vite 本地开发服务器 |
| `pnpm build` | 前端生产构建（输出 `dist/`） |
| `pnpm preview` | 本地预览生产构建产物 |
| `pnpm test` | 运行 Vitest 单元测试 |
| `pnpm lint` | 执行 oxlint 快速静态代码检查 |
| `pnpm exec tsc -b` | TypeScript 静态类型检查 |

---

## 📄 授权许可

本项目采用 **Apache License 2.0** 开源授权协议 - 详见 [LICENSE](LICENSE) 文件。

Copyright © 2026 语道科技 / YuDao. All rights reserved.
