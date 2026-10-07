---
title: "LiteArm"
subtitle: "Quickstart Guide"
title-meta: "LiteArm Quickstart Guide"
author: "NEXFORM ROBOTICS"
version: "v2.1"
date: "October 6, 2026"
---

# LiteArm Quickstart Guide

## 1. Architecture & Requirements

LiteArm Studio is a local Python program plus a browser UI. The program owns the USB serial link to the arm; the UI is served by that program and talks to it over a loopback WebSocket. There is no server and no IP address to configure.

```
browser window (React UI, served by the daemon)
   │  HTTP  → static assets, /api/health
   │  WS    → state push (down) / commands (up)
   ▼
litearm-studio-daemon  (Python, 127.0.0.1 only)
   ▼
litearm-python  ──USB CDC (1d50:606f @921600)──>  STM32  ──CAN──>  motors
```

### Requirements

- Control host: Linux or Windows with a free USB port; Python 3.10+
- Arm controller powered on and connected over USB (USB CDC, VID:PID `1d50:606f`)
- Node.js 20+ and pnpm only if you are building the UI yourself

---

## 2. Installation

There are two routes. To run a released build, download the one-file executable and follow
[INSTALL.md](INSTALL.md) — no Python, no pnpm and no checkout. The commands below build from
source, which is what development needs.

`litearm-python` is not published on PyPI, so install it from its checkout first:

```bash
git clone https://github.com/nexform-tech/litearm-python.git
git clone https://github.com/nexform-tech/litearm-studio.git
cd litearm-studio

pip install -e ../litearm-python
pip install -e "daemon[test]"
```

Build the UI that the daemon will serve (skip only if `dist/` already exists):

```bash
pnpm install && pnpm build
```

---

## 3. Running

```bash
# Offline: a complete session on the SDK's fake transport — no hardware required
litearm-studio-daemon --fake

# Real arm: auto-discovers the USB CDC device
litearm-studio-daemon

# Explicit port, custom HTTP port, no window
litearm-studio-daemon --port /dev/ttyACM1 --http-port 9000 --no-open
```

The daemon prints the address it actually bound to (default `http://127.0.0.1:8765/`; if the port is busy it increments and prints the new one) and opens a Chromium `--app=` window when one is available, otherwise a normal tab.

| | |
| --- | --- |
| Console | `http://127.0.0.1:<port>/` |
| WebSocket | `ws://127.0.0.1:<port>/ws` |
| Health check | `http://127.0.0.1:<port>/api/health` |

> [!IMPORTANT]
> The daemon binds `127.0.0.1` only. There is no option to expose it on a LAN — an interface that can drive an arm is not something to publish.

---

## 4. Initial Smoke Test

### Step 1 — Activate

A new arm must be activated once before it can move. Until then, pressing **Enable** does nothing; everything else works. Make sure the computer is online and the arm is connected, then:

1. Click **Settings**, then **Activation**. If it says **Activated**, you are done.
2. If it says **Not activated**, fill in the form. Name, phone, organization, email and region are required; the rest is optional.
3. Tick the consent box.
4. If the arm is enabled, press **Disable** first, and hold the arm steady: it will sag under its own weight.
5. Press **Submit and activate** and wait a few seconds.

When the panel reads **Activated**, you can enable the arm. If the panel says "no credential for this machine", press **Copy** and send the copied machine number to your supplier. Other messages and fixes: user manual §1.4.

### Step 2 — Connect and enable

1. Open the console (the daemon opens it for you).
2. The top bar shows the connection state and, once connected, the **port · firmware** it resolved. Click **Connect** if the session is not up yet.
3. Confirm the 3D model renders and J1–J7 show live values.
4. Click the **Enable** toggle on the control bar.

### Step 3 — Verify motion

> [!WARNING]
> Clear the working envelope of people and obstacles before enabling or commanding motion. **STOP** issues an emergency stop and stays reachable while the arm is moving.

1. **Jog**: pick J1, set speed to 10–20 %, and nudge with the slider; verify a smooth response.
2. **Home**: click the zero/home action to run the firmware's low-speed homing.
3. **STOP**: press it once and confirm the arm drops energy immediately.

### Step 4 — Telemetry

Open the **Telemetry** page: a session is created automatically when the arm connects, samples are recorded locally, and **Export CSV** writes the selected session to disk.

---

## 5. Troubleshooting

### The daemon starts but reports no module named `litearm`

`litearm-python` is not on PyPI. Install it from the checkout: `pip install -e ../litearm-python`.

### No device found / “未发现 STM32 CDC 设备”

- Check the USB cable and that the controller is powered.
- Verify the device enumerates with VID:PID `1d50:606f`.
- If it shows up under a different path, pass it explicitly: `litearm-studio-daemon --port /dev/ttyACM1`.
- On Linux, make sure your user can open the serial device (`dialout` group).

### "Enable" does nothing

This arm has not been activated yet. Go to **Settings → Activation** and follow step 1 of §4. Nothing except Enable is affected in the meantime.

### The UI loads but never shows state

- Check `http://127.0.0.1:<port>/api/health` — `connected` must be `true`.
- If `conn.status` is `error`, the `conn.error` field carries the reason (device missing, firmware mismatch, transport failure).

### Port 8765 is already in use

The daemon automatically picks the next free port and prints it; read the printed console URL rather than assuming 8765.

### Closing the window stopped the UI but not the arm

That is deliberate: closing the browser window does not tear down an arm session. Use **Disconnect** or **STOP** in the UI, or stop the daemon process, to end the session.

Starting the program again while that daemon is still running opens a window onto it, so you get the arm session back rather than a second program that cannot reach the arm.

### The window says the port cannot be opened but the arm is connected

The program that holds the arm is still running and you started a second one by naming a specific session (`--port`, `--fake`, `--can-channel`, …). Check `http://127.0.0.1:8765/api/health` for the running one, close the second window, and start the program again without those options to attach to the session that is already up.
