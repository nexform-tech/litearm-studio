# LiteArm Studio

**English** | [简体中文](README_ZH.md)

**LiteArm Studio** is the next-generation graphical host application and control studio designed for LiteArm 7-DoF collaborative robotic arms. Built with React 19, TypeScript, Three.js and Vite, it delivers real-time motion control, 3D kinematic visualization, trajectory lead-through teaching, and telemetry diagnostics in the browser.

---

## 📖 Documentation & User Manuals

- 📘 **[User Manual (English)](docs/USER_MANUAL.md)**
- 📕 **[用户操作手册 (简体中文)](docs/USER_MANUAL_ZH.md)**

---

## ✨ Key Features

- 🦾 **Single-Arm Motion Control**:
  - Real-time 3D digital twin rendering with interactive URDF kinematics and frame axes;
  - Joint space slider control (J1–J7) with instant dispatch and batched staging modes;
  - Cartesian directional jogging (Base and Tool frames) and linear interpolation motions (`movel`);
  - High-priority software emergency stop (**STOP**), one-click homing, ready pose positioning, and fault clearing.
- 🎬 **Trajectory Lead-Through Teaching**:
  - Drag-and-teach recording in zero-gravity mode sampled at 100 Hz;
  - On-controller trajectory library management, multi-rate playback (0.25× to 2.0×), loop execution, and emergency takeover.
- 📈 **Telemetry & Diagnostics**:
  - Real-time 10 Hz joint state sampling (angles, velocities, torques, temperatures, tracking errors);
  - Client-side IndexedDB session recording with customizable retention caps (10–500 MB) and CSV export;
  - Real-time streaming, keyword search, and level filtering for controller system logs.
- ⚙️ **Calibration & System Settings**:
  - End-effector payload mass and center-of-mass (COM) compensation;
  - Base mounting orientation calibration (Standard, Inverted, Wall-Mount);
  - Joint safety limits, closed-loop servo PD gains, hardware diagnostics, and daemon service restart.

---

## 🛠️ Technology Stack

- **Frontend Core**: React 19, TypeScript, Vite 8, Tailwind CSS v4
- **3D Visualization**: Three.js, URDF-Loader
- **State & Data**: IndexedDB (client-side telemetry), Radix UI Primitives, Lucide Icons, Sonner
- **Internationalization**: i18next (English / 简体中文)

---

## 🚀 Quick Start

### 1. Prerequisites

- **Node.js**: `v20.0.0` or higher
- **Package Manager**: `pnpm` (`corepack enable` or `npm install -g pnpm`)
- **Robot Controller**: powered on and connected over USB; the host reaches the arm through the
  [`litearm-python`](https://github.com/nexform-tech/litearm-python) SDK (no server and no IP address)

### 2. Web Development

```bash
# Clone both the SDK and Studio repositories side-by-side
git clone https://github.com/nexform-tech/litearm-js.git
git clone https://github.com/nexform-tech/litearm-studio.git

cd litearm-studio
pnpm install

# Start local development server
pnpm dev
```

Open your browser at `http://localhost:5173`.

> **Project status:** the transport layer is being re-pointed from the retired `litearm-server` to a
> local control daemon. See [docs/REFACTOR_PLAN.md](docs/REFACTOR_PLAN.md).

---

## 📋 Common Commands

| Command | Description |
| :--- | :--- |
| `pnpm dev` | Start Vite local web development server |
| `pnpm build` | Production build for Web distribution (`dist/`) |
| `pnpm preview` | Preview production web build locally |
| `pnpm test` | Run unit tests via Vitest |
| `pnpm lint` | Fast static analysis via oxlint |
| `pnpm exec tsc -b` | TypeScript static typecheck |

---

## 📄 License

This project is licensed under the **Apache License 2.0** - see the [LICENSE](LICENSE) file for details.

Copyright © 2026 NexForm / YuDao. All rights reserved.
