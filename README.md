# LiteArm Studio

**English** | [简体中文](README_ZH.md)

**LiteArm Studio** is the operator console for LiteArm 7-DoF collaborative robotic arms. It is a browser UI served by a local Python daemon: the daemon is the **only** process that touches the hardware, and the UI talks to it over a WebSocket on `127.0.0.1`.

---

## Architecture

```
browser window (React UI)
   │  HTTP  → static assets, /api/health
   │  WS    → state push (down) / commands (up)
   ▼
litearm-studio-daemon  (Python, loopback only, `daemon/`)
   ▼
litearm-python  ──USB CDC (1d50:606f)──>  STM32  ──CAN──>  motors
```

- **The daemon owns the arm.** It auto-discovers the USB CDC device (or takes `--port`), pushes normalised state at 50 Hz from the SDK's cached frames, and runs every SDK call on a single-threaded executor. Emergency stop and disable run on a separate lane so they stay reachable while a motion is in progress.
- **The daemon also owns the window.** It hosts the built assets and opens an **embedded window** (`pywebview`), so there is one process and no browser to install. **Closing the window ends the program** — the arm is de-energised and the serial port released. Reloading the page does not end it.
- **Loopback only.** Binding anything else is refused in code — exposing an interface that can drive an arm on a LAN is treated as an incident, not a setting.

---

## Features

- **Single-arm motion control**
  - Real-time 3D digital twin (URDF) with interactive frame axes;
  - Joint space sliders (J1–J7) whose ranges come from the controller's own soft limits (`get_joint_params`), with staged/batched dispatch;
  - Cartesian jogging in base and tool frames, plus linear `movel` to a target pose;
  - Ready pose, firmware homing, zero-gravity drag teaching, enable/disable, fault clearing;
  - High-priority **STOP** (emergency stop) that is reachable during motion.
- **Logs** (the `/log` page)
  - Every daemon decision as a structured record: connections, reconnects, command
    invocations with their arguments and outcome, activation, firmware phases, and
    gripper alerts;
  - One JSONL file per daemon, rotating by size, in OpenTelemetry's field naming —
    readable by `jq`, Loki, Fluent Bit or an OTel Collector with no translation, and
    **not** tied to the browser's origin (so it survives a port change; see
    [issue #80](https://github.com/nexform-tech/litearm-studio/issues/80));
  - A live view over the WebSocket with level, category and text filters, expandable
    raw fields and exceptions, and JSONL export; the daemon's history is read back
    over `/api/logs`, which is how the page still shows earlier records after a reload.
- **Telemetry**
  - 10 Hz joint sampling (angles, velocities, torques, temperatures, driver error codes),
    recorded in the browser with a configurable retention cap and CSV export;
  - 1 Hz state records in the daemon's log file as `kind: "sample"`, so a session's
    numbers sit next to its events.
- **LiteGrip gripper** (Linux only) — enable, open, close, grasp and release, with live position, force, torque and temperature readings and a calibration check on the Gripper page.
- **Settings and activation** — payload, mounting direction (upright / inverted / side ±x / ±y, sent to the firmware as the base-frame gravity vector), per-joint gains and soft limits, the firmware self-test, USB DFU firmware update, and the one-time arm activation.
- **Internationalization** — English / 简体中文.

### Not in this build

Trajectory teaching/playback, dexterous-hand panels and per-joint impedance or hold modes are out of scope ([docs/REFACTOR_PLAN.md](docs/REFACTOR_PLAN.md) §5–6). The controller-log page the plan dropped is back, rebuilt on the daemon's own records — see [docs/LOGS.md](docs/LOGS.md). Everything the Settings page exposes (payload, gains, limits, self-test, gripper bus, activation, firmware update) *is* wired to the daemon.

---

## Quick Start

### 1. Prerequisites

- **Node.js** `v20.0.0`+ and **pnpm** (`corepack enable` or `npm install -g pnpm`)
- **Python** 3.10+ for the local daemon
- **The two SDKs** (`litearm-python`, `litegrip-python`) — not on PyPI: they ship as git
  submodules under `sdk/`, pinned by tag. `make sdk` fetches and installs them; there is
  nothing to clone by hand.

### 2. Run the whole application

```bash
cd litearm-studio
make sdk                           # fetch the pinned SDK submodules and install them
pip install -e "daemon[test]"     # installs fastapi/uvicorn and the `litearm-studio-daemon` entry point
pnpm install && pnpm build         # build the UI the daemon will serve

litearm-studio-daemon --fake       # offline: full session on the SDK's fake transport, no hardware
# litearm-studio-daemon --fake --fake-unactivated   # no hardware, and the device is UNLICENSED:
#                                                   # the activation panel and its signup form show up
# litearm-studio-daemon            # real arm: auto-discovers the USB CDC device
# litearm-studio-daemon --port /dev/ttyACM1 --http-port 9000 --no-open
```

The fake device is licensed by default, so the activation panel shows a state and no form.
Add `--fake-unactivated` to walk the whole unlicensed path: the signup form, the activation
consent document, and the `ERR{0x10,0x08}` refusal when you press Enable.

To move to a newer SDK: check the tag out inside `sdk/<repo>` and commit the updated
submodule pointer. `.gitmodules` plus that pointer is the only place the two versions live,
and every build path — dev, CI, `.deb`, Windows — follows it.

The console prints the URL it bound to (default `http://127.0.0.1:8765/`, auto-incrementing if busy) and opens a window.

### 3. UI-only development

```bash
pnpm install
pnpm dev        # http://localhost:5173 — proxies /ws and /api to 127.0.0.1:8765
```

Run `litearm-studio-daemon --fake --no-open` alongside it.

### 4. Prebuilt artifacts

Each release attaches a Debian package, standalone one-file executables for other Linux and for
Windows, and a `.sha256` next to each. They bundle the daemon, the `litearm` SDK and the built UI,
so a target machine needs **no Python, no pnpm and no repository checkout**.

On Ubuntu 22.04+ and Debian 12+, install the package: it makes itself executable, grants the
serial-port permission and adds an entry to the application list.

```bash
cd ~/Downloads
version=0.12.0
base="https://github.com/nexform-tech/litearm-studio/releases/download/v${version}"
curl -LO "$base/litearm-studio_${version}_amd64.deb"
curl -LO "$base/litearm-studio_${version}_amd64.deb.sha256"
sha256sum -c "litearm-studio_${version}_amd64.deb.sha256"   # prints: ...: OK
sudo apt install ./litearm-studio_${version}_amd64.deb
litearm-studio --fake     # offline, no hardware
```

Everywhere else — and on Windows — use the standalone file. It is not executable as downloaded, so
`chmod +x` it first; the Linux one needs glibc 2.35 or newer:

```bash
mkdir -p ~/Applications && cd ~/Applications
# $base and $version are the ones set above
curl -LO "$base/litearm-studio-${version}-linux-amd64"
curl -LO "$base/litearm-studio-${version}-linux-amd64.sha256"
sha256sum -c "litearm-studio-${version}-linux-amd64.sha256"
chmod +x "litearm-studio-${version}-linux-amd64"
./"litearm-studio-${version}-linux-amd64" --fake     # offline, no hardware
./"litearm-studio-${version}-linux-amd64"            # real arm, USB auto-discovery
```

[docs/INSTALL.md](docs/INSTALL.md) covers the requirements, the serial-port permission and
first-run activation in full.

Release assets are produced by the `package` job in `.github/workflows/release.yml`. To build
the Debian package yourself, run `make deb` (Docker; it pins the Ubuntu 22.04 toolchain the
frozen runtime has to be linked against — see [daemon/README.md](daemon/README.md#打包phase-5)).
For the bare executable instead, run `pnpm build` and then `python packaging/build.py`.

The Windows executable carries the LiteArm icon from `assets/litearm.ico`. It is committed, so a
normal build never regenerates it; rebuild it only when the brand mark changes, and keep
`assets/icon-source.svg` as the source of truth:

```bash
pnpm icon     # re-renders assets/icon-png/*.png and rewrites assets/litearm.ico
```

Do not point `--icon` at a file outside the repository: the release workflow checks out a clean tree,
so an untracked icon silently falls back to PyInstaller's default executable icon.

---

## Documentation

- **[Installation](docs/INSTALL.md)** — what each release file is, and how to install it on Ubuntu and Windows.
- **[User Manual (English)](docs/USER_MANUAL.md)** — operations, settings, safety and troubleshooting. Its trajectory and end-effector sections still describe the retired server-based build and are being rewritten.
- **[用户操作手册 (简体中文)](docs/USER_MANUAL_ZH.md)** — same caveat.
- **[Quickstart](docs/QUICKSTART.md)** / **[快速开始](docs/QUICKSTART_ZH.md)**
- **[Activation contract](docs/ACTIVATION.md)** / **[激活接口约定](docs/ACTIVATION_ZH.md)** — the firmware, daemon and vendor-signer agreement behind activation. For developers changing any of the three.
- **[Log format](docs/LOGS.md)** — the record schema, where the files live, how to read them, and what is never written to them. For anyone answering "what happened?" after a session.
- **[Refactor plan](docs/REFACTOR_PLAN.md)** — architecture, interface contract and scope decisions.
- **[Daemon README](daemon/README.md)**

---

## Common Commands

| Command | Description |
| :--- | :--- |
| `pnpm dev` | Start the Vite dev server (proxies to a local daemon) |
| `pnpm build` | Production UI build into `dist/` (what the daemon serves) |
| `pnpm preview` | Preview the production build locally |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm lint` | Static analysis (oxlint) |
| `pnpm exec tsc -b` | TypeScript typecheck |
| `make deb` | Installable Debian package into `packaging/dist/` (Docker, ~90 s) |
| `python -m pytest daemon/tests -q` | Daemon unit tests (no hardware needed) |

---

## License

Licensed under the **Apache License 2.0** — see [LICENSE](LICENSE).

Copyright © 2026 NexForm / YuDao. All rights reserved.
