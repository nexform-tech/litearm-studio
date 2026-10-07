# Gripper integration in LiteArm Studio

This document specifies how LiteGrip gripper control is added to LiteArm Studio;
read it if you are implementing or reviewing the daemon-side gripper session, the
WebSocket contract, or the gripper UI.

## 1. Scope

**In scope**

- A second device session inside `litearm-studio-daemon` that drives one LiteGrip
  over SocketCAN.
- The WebSocket frames and commands the UI uses for it, alongside the existing arm
  contract.
- Calibration handling: which file is in effect, and what the UI is allowed to do
  with which provenance.
- A gripper panel on the control page and a settings section, both reusing the
  UX of the retired end-effector panels (see §6.4).

**Out of scope**

- Firmware changes. The arm controller gets no end-effector command.
- The dexterous hand (LinkerHand). The old UI had one; it is not being restored.
- Multi-arm, teleoperation, VLA integration.
- Gripper support on Windows (see D10).

## 2. Frozen decisions

These are settled; the rest of the document assumes them.

| # | Decision | Why |
| --- | --- | --- |
| D1 | The gripper sits on the **same CAN bus as the arm's joints**. The daemon reaches it through a **host SocketCAN interface**, classic CAN at 1 Mbit, default `can0`. | The arm's USB CDC link is not a data path to the gripper: the firmware exposes no end-effector command, and the SDK's passthrough entries (`send_mit`, `move_mit_all`) are addressed by joint index, so they cannot reach a motor at CAN ID `0x08`. |
| D2 | The studio daemon is the **only** talker for the gripper. Connecting while `litegrip-studio` is connected is refused, not merged. | The gripper has one state and no arbitration; two talkers overwrite each other's frames. |
| D3 | The daemon never calls `load_calibration()` with no argument. It always passes an explicit `path=` or `template=`. | The SDK's no-argument chain falls back to its bundled factory file and reports success either way, so the caller cannot tell which file moved the jaws. |
| D4 | The factory default is the SDK's `normal` / `reverse` template, loaded **by name**. Nothing is copied into the user calibration directory. | The templates are nominal (120 mm geometry) and exist to declare direction. Copying one into `~/.litegrip/<channel>_calibration.json` would make nominal data pass for a measurement and defeat every provenance check. |
| D5 | The travel (`max_stroke_mm`) is owned by the host, stored per channel. It starts at `85.0` (the reference unit's measured travel) and the operator confirms it during first-time setup. | The SDK's calibration schema has no field for it, but `zero()` uses it as the numerator of `rad_to_mm`. Left at the SDK default of `120.0` it scales every millimetre reading by about 1.4. |
| D6 | The daemon drives the gripper with its **own 200 Hz MIT tick**. It does not call the SDK's `grasp` / `move_at_speed` / `goto`, and calls `open()` / `close()` only in their plain forms, through the backend's `open_plain` / `close_plain`. | `grasp` / `move_at_speed` / `goto` block for the whole move and have no abort hook, so an E-stop cannot interrupt them, and `move_at_speed` also ends with a fixed ~100 ms hold that stutters a live control loop. `open()` and `close()` are the one exception: this unit has a mechanical dead-band at *each* end that the daemon's anchored reference cannot break (issue #72) and the SDK's wall-clock ramp can, and both take a `progress` callback that the console wires to the E-stop — so each keeps an abort path. A force-carrying close is *not* delegated; it stays on the FSM, where the position gain is the approach gain. |
| D7 | Every SDK call happens on the tick thread. No other thread touches the gripper object. | The SDK is not thread-safe: one socket, one cached motor state, no locks. |
| D8 | The E-stop is a `threading.Event` checked at the top of every tick. It is not a queued command. | A stop that can queue behind other work is not an emergency stop. |
| D9 | The tick is also the keepalive. | The drive leaves the enabled state after 0.4 s without a frame from the host. |
| D10 | Gripper support is Linux-only and is absent, not disabled, on Windows. | `import litegrip` needs `fcntl` and `PF_CAN`; it raises at import on Windows. |

## 3. Architecture

```
browser (React UI)
  │ HTTP  static assets
  │ WS    /ws   (one socket, one command id space)
  ▼
litearm-studio-daemon       (Python, 127.0.0.1 only)
  ├── ArmSession        ──USB CDC──► STM32 ──┐
  └── GripperSession    ──PF_CAN───► can0 ───┤ one CAN bus, 1 Mbit classic
                                             └─► arm joints + LiteGrip DM4310 (0x08 / 0x18)
```

Two session objects behind one WebSocket and one process. The arm's path, its
command whitelist, its executors and its state frames are unchanged.

`GripperSession` owns:

- one **tick thread** at 200 Hz, the only thread that touches the SDK;
- a **command queue** (`queue.Queue`) the WS thread fills and the tick drains;
- an **E-stop event** the WS thread sets and the tick reads first thing;
- a **state snapshot** published to the WS at 50 Hz plus on every change.

It never uses the arm's command executor or its safety executor. A 3-second
gripper move must not occupy the thread that serves arm commands, and the
gripper's safety path is the tick, not an executor.

### 3.1 Reuse: lift the Qt-free core, write only the adapter

`litegrip-studio` already contains a tested, hardware-free implementation of
everything below the UI, and it was written Qt-free on purpose. Both repositories
are Apache-2.0 and owned by the same organization, so the code is lifted rather
than rewritten:

| Lift as-is | Why it is usable here |
| --- | --- |
| `units.py` | Angle/millimetre mapping, travel validation. No Qt, no SDK. |
| `calibration.py` | Provenance, validation, cross-check. No Qt, no SDK at import. |
| `can_link.py` | Interface probe and privileged bring-up. No Qt. |
| `telemetry.py` | State snapshot struct. No Qt. |
| `core/commands.py` | Frozen command dataclasses and the queue. No Qt. |
| `core/profile.py`, `core/motion.py` | Ramp, contact detection, travel clamping. No Qt. |
| `core/calibration_fsm.py` | Guided and two-point probes as state machines. No Qt. |
| `backend/real.py`, `backend/sim.py`, `backend/plant.py` | SDK primitives behind one interface, plus a simulator that runs the same FSM. No Qt. |
| `core/worker.py` `WorkerLoop` | The tick, the gate, the probe, the E-stop. Its docstring says it has no Qt in it; the Qt `QThread` is a separate class at the bottom of the file. |

**Write new** (this is the actual work):

| New module | Responsibility |
| --- | --- |
| `daemon/.../gripper/session.py` | Adapts `WorkerLoop` to the daemon: replaces its signal object with a callback that emits WebSocket frames, adds `gripper.*` command intake, channel enumeration, and the per-channel settings record. |
| `daemon/.../gripper/config.py` | Per-channel device record (channel, CAN id, mount, calibration path override, travel) persisted next to the daemon's settings. `mount` is always `normal` or `reverse` and defaults to `normal`: the reference hardware is assembled that way, so a channel with no measured file resolves to the nominal `normal` template (row 5) rather than to the factory fallback or to nothing. |
| `daemon/.../server.py` (edit) | Route `gripper.*` commands, relay gripper frames to clients, add the gripper to `/api/health`. |
| `src/lib/arm/gripperClient.ts` (new) | Frontend client half: gripper frame handling and command wrappers. |

The `units.py` / `calibration.py` copies must be updated on one point: the SDK
moved to per-channel calibration files and named templates. The lifted code still
resolves the legacy single file. See §5.3.

## 4. Wire protocol

Additive. Existing arm frames and commands do not change.

### 4.1 Downlink (daemon to browser)

```jsonc
{"t":"gripper_conn","status":"disconnected|connecting|connected|error",
 "channel":"can0","canId":8,"mount":"normal|reverse",
 "source":"template|measured|factory|missing|null","path":"/home/u/.litegrip/can0_calibration.json",
 "travelMm":85.0,"error":null}

{"t":"gripper_state","stamp":123.4,"state":{
  "positionMm":41.2,"forceN":0.0,"torqueNm":0.0,
  "enabled":true,"state":"ready|moving|grasping|holding|fault|disabled|stopped",
  "errorCode":1,"temps":{"mosTemp":31,"coilTemp":34},
  "fresh":true,"gate":"READY|TEMPLATE|FACTORY|BLOCKED","gateReason":"…"}}

{"t":"gripper_calib","probe":"zero","phase":"close|open|done|failed",
 "step":12,"total":80,"detail":"寻找闭合限位"}

{"t":"gripper_alert","level":"info|warn|error|fatal","text":"…",
 "kind":"GripperCalibrationError|null","code":0}

{"t":"gripper_busy","busy":true,"what":"正在连接夹爪…"}
```

`gripper_conn` is the single source of truth for the gripper's connection, the
same way `conn` is for the arm. `status:"error"` with `channel:""` means the
interface or the device went away. Its `mount` is read back from the limits the
device is actually running on, and `declaredMount` keeps the record's
declaration beside it so the two can be compared; `template` names the SDK
template in effect when one is. A page that shows a millimetre reading has to be
able to say whether the geometry behind it was ever measured.

`gripper_state` is pushed at 50 Hz, and immediately whenever `state`, `enabled`,
`errorCode` or `mount` changes. Its `gate`/`gateReason` fields say why the
page's controls are disabled (§6.3), and `positionMm` is `null` until a status
frame has been received since the drive was energised — render that as unknown,
never as zero, because zero is the closed stop.

`gripper_alert` carries the asynchronous half of the error surface: a refusal or
a fault that happens on the tick thread has no `res` frame to answer, and an
operator who is not told why a button did nothing will press it again. Its
`kind` is the same wire error class name a `res` frame carries, so the browser
translates both through one table (`common:errors.*`); `text` stays the daemon's
own diagnostic sentence and is shown as the detail. An alert whose kind the
daemon cannot name passes `null` and the browser shows `text` unchanged — a
generic "operation failed" would throw away the only clue there is.
`gripper_busy` says a blocking call (connect, enable, clear-fault) is in
progress, so the page can say why it is waiting.

### 4.2 Uplink (browser to daemon)

```jsonc
{"t":"cmd","id":1,"m":"gripper.close","p":{}}
```

| `m` | `p` | `v` |
| --- | --- | --- |
| `gripper.connect` | `channel?`, `canId?`, `mstId?`, `mount?` | `{"started":true}` |
| `gripper.disconnect` | — | `{"stopped":true}` |
| `gripper.list_channels` | — | `["can0","can1"]` |
| `gripper.enable` | — | `{"enabled":true}` |
| `gripper.disable` | — | `null` |
| `gripper.clear_fault` | — | `null` |
| `gripper.open` | — | `{"ok":true}` |
| `gripper.close` | — | `{"ok":true}` |
| `gripper.grasp` | `forceN?`, `holdS?` | `{"ok":true}` |
| `gripper.move_to` | `targetMm` (0..travel), `speedMmS?` | `{"ok":true}` |
| `gripper.release` | — | `null` (zero torque, stays enabled, back-drivable) |
| `gripper.stop` | — | `null` (E-stop) |
| `gripper.reset_stop` | — | `null` (release the latch) |
| `gripper.set_motion` | `speedMmS?`, `forceN?` | the settings now in effect |
| `gripper.load_template` | `mount` (`normal` or `reverse`) | `{"mount":…,"source":"template"}` |
| `gripper.list_calibrations` | — | `[{"path","source","valid","problems":[],"warnings":[],"closedRad","openRad","fileRadToMm","template","mount"}]` |
| `gripper.import_calibration` | `path` (on the control machine) | `{"path":…,"source":"measured"}` |
| `gripper.zero` | `travelMm` | `{"closedRad":…,"openRad":…,"radToMm":…,"source":…,"warnings":[]}` |
| `gripper.set_allow_factory` | `allow` (bool) | `{"allowFactory":true}` |

Rules:

- Commands keep the existing `{"t":"cmd","id":N,…}` envelope and the shared id
  space, so `res` handling on the client does not change.
- `gripper.stop` is handled before the queue: the WS thread sets the E-stop event
  and answers immediately. The tick engages it within one tick (5 ms).
- `gripper.disable` is a normal queued command; `gripper.stop` is what must never
  queue.
- `gripper.zero` is long (tens of seconds) and streams `gripper_calib` progress
  frames. It must not hold the WS read loop: the tick runs the probe as a state
  machine, one step per tick.
- Command timeout stays at the daemon's existing 60 s, except `gripper.zero`,
  which the client must not subject to a 60 s timeout. The daemon waits up to
  120 s for the probe itself and answers with the calibration it produced.
- `gripper.set_allow_factory` persists the acknowledgement of the factory
  calibration (a decision, not a state) and is the only way the `FACTORY` gate
  opens. It is an addition to the table above, needed by §5.3 row 6.
- `gripper.list_calibrations` needs no connection: it is a filesystem question,
  and the settings page asks it while deciding what to load.

### 4.3 Error kinds

Reuse `{"kind","msg"}`. New kinds map to new `common:errors.*` keys:

| kind | Meaning |
| --- | --- |
| `GripperNotConnectedError` | A command arrived before a gripper session exists. |
| `GripperLinkError` | The CAN interface is missing, down, or bus-off. |
| `GripperFaultActiveError` | The drive reports a latched fault (`errorCode` outside 0 and 1). |
| `GripperCalibrationError` | No usable calibration for the requested motion. |
| `GripperEstoppedError` | Motion refused while the stop latch is engaged. |
| `GripperBusyError` | A second long operation (probe) was requested. |

## 5. Daemon implementation

### 5.1 Session lifecycle

1. `GripperSession.start(config)` reads the per-channel record, enumerates CAN
   interfaces, then `WorkerLoop` connects: it prepares the interface (see §5.4),
   opens the SDK object, and pushes `gripper_conn`.
2. It loads **no calibration** at connect time. Load is an explicit command, and
   the gate (§5.3) blocks motion until one is in effect. This matches the arm's
   rule that a session never silently adopts a configuration.
3. The tick starts at 200 Hz and runs until shutdown. It polls a status frame
   every tick and publishes state at 50 Hz.
4. `gripper.disconnect` stops the tick, zero-torques, disables and closes the
   socket. The per-channel record is not touched.
5. Process shutdown (`serve()`'s `finally`) zero-torques, disables and closes —
   the same shape as the arm's de-energize path, and for the same reason: leaving
   a drive enabled with the last command it received is not acceptable when the
   process that would correct it is gone. `--keep-enabled` applies to the arm
   only; the gripper always disables on exit.

### 5.2 Tick order

The tick borrows `WorkerLoop.tick_once`, whose order is deliberate:

1. Drain the command queue, so a command given this tick takes effect this tick.
2. Read the E-stop event. If set, engage it (zero torque, then disable) and latch.
3. Service the GUI watchdog (`GUI_WATCHDOG_S = 3.0`): if the browser stops talking
   for three seconds, stop the motion. A closed tab must not leave the jaws
   pressing.
4. Poll one status frame.
5. Advance the active FSM: probe, or motion, or a hold frame.
6. Evaluate the gate and publish.

### 5.3 Calibration: resolution, provenance, gate

The daemon decides which calibration is in effect and tells the SDK explicitly.
It never asks the SDK what it loaded.

The implementation is `daemon/src/litearm_studio_daemon/gripper/calibration.py`
(`resolve` / `inspect_file` / `sdk_source`) — the same code the settings page
reads through `gripper.list_calibrations`.

**Resolution order** (first hit wins, and the result carries its provenance):

| # | Source | Condition | Provenance |
| --- | --- | --- | --- |
| 1 | Path pinned in the per-channel record | channel field matches, or is absent | `measured` |
| 2 | `~/.litegrip/<channel>_calibration.json` | parses and validates | `measured` |
| 3 | `LITEGRIP_CALIB` | set in the environment | `measured`, flagged as an environment override |
| 4 | `~/.litegrip/litegrip_calibration.json` | channel field matches or is absent | `measured`, flagged as legacy |
| 5 | SDK template `normal` / `reverse` | always — the record's `mount` defaults to `normal` | `template` |
| 6 | SDK bundled `factory_calibration.json` | row 5 had no template file to load | `factory` |
| 7 | nothing | — | `missing` |

**Gate.** Motion is allowed only when the provenance is `measured`, or `template`
for the commands that do not depend on geometry: `open`, `close`, `release`.
Every millimetre target (`gripper.move_to`, `gripper.grasp`) requires `measured`.
`factory` requires an explicit, persisted operator acknowledgement
(`gripper.set_allow_factory`). `missing` allows nothing but `zero`.

`zero` has a precondition of its own: the axis must have reported a position since
it was last enabled. The probe is seeded from that reading and drives ungated, so a
probe started while the SDK is still serving its `0.0 rad` placeholder is refused
rather than run.

The gate is evaluated twice on purpose: the tick asks "may the axis be driven at
all" (a template says yes, under its own nominal limits), and each command asks
"may this one name a millimetre" (a template says no). The second question lives
in `WorkerLoop._refusal(geometry=…)`; the WebSocket thread asks it too, so the
refusal arrives as a `res` error rather than as an alert after the fact.

**Cross-check.** After loading, read back the limits the SDK actually applied and
compare them with the file. A mismatch means the numbers on screen do not describe
the gripper in front of the operator; refuse further motion and say so.

**Validation.** Parse the JSON before handing it to the SDK: the three required
keys must be present and numeric, the travel must be positive, and the derived
millimetres per rad must fall inside the plausible band. The SDK itself validates
nothing.

**Direction.** `normal` and `reverse` are the only ways to declare it, and only a
human can choose: nudge the jaws at low torque and see which way the angle moves.
Read the result back from the SDK and show it; a wrong pick is not silent to the
software but it is to the operator.

The record's `mount` is never absent — it defaults to `normal`, the reference
hardware's assembly — so row 5 is the ordinary resting state of a channel with no
measured file, and the operator changes it from the settings page, which loads the
chosen template by name. `normal` is a *declaration*, not a measurement: row 5's
nominal geometry is a 120 mm unit's, which is why the gate still refuses every
millimetre target until `zero()` replaces it.

### 5.4 CAN link and channel enumeration

- Enumerate interfaces by reading `/sys/class/net/*/type` for `280` (ARPHRD_CAN).
  Do not hardcode `can0`..`can2` the way the retired UI did.
- Probe state with `ip -details link show <dev>` and treat a controller that is
  not `ERROR-ACTIVE` as needing attention.
- Bring-up is privileged and goes through `pkexec` with the interface name and
  bitrate passed as positional arguments to one fixed script, exactly as
  `can_link.py` does. It runs only when the interface is actually wrong, so a
  correctly configured bus never produces a password dialog.
- `--no-can-setup` exists for machines where the interface is managed by the
  operator or by systemd, and for tests.
- `gripper.connect` refuses a channel the kernel did not enumerate, and lists the
  ones it did, when at least one CAN interface was found. An empty enumeration
  means the enumeration itself is unavailable (`/sys` absent, a container, a
  non-Linux CI), and treating that as "the interface does not exist" would refuse
  to connect on a machine whose bus is fine.

### 5.5 Simulation

`--fake` must cover the gripper too, or the page is untestable in CI. Lift
`backend/sim.py` and `backend/plant.py`: they run the same FSM against a
simulated plant, so the simulator exercises production logic instead of sitting
beside it. `gripper.zero` against the simulator is how the calibration flow gets
end-to-end coverage without hardware.

### 5.6 Persistence

Per-channel record, next to the daemon's existing settings:

```jsonc
{"channels": {
  "can0": {"channel":"can0","can_id":8,"mst_id":null,"mount":"normal",
           "calibration_path":null,"travel_mm":85.0,"allow_factory":false}},
 "lastChannel":"can0"}
```

It is `$XDG_CONFIG_HOME/litearm-studio/gripper.json` (`~/.config/...` by
default), overridable with `LITEARM_STUDIO_GRIPPER_CONFIG`. The write is atomic
and the read is lenient: a field that cannot be parsed costs that field, not the
record, and a file that is not JSON at all reads back as no records.

`travelMm` is per channel because two grippers on one machine can differ, and it
must survive a restart: the SDK does not store it, and the next `zero()` would
otherwise use its own default of 120.

## 6. Frontend implementation

### 6.1 Client refactor

The current client is a single-device singleton: one `ArmClient`, one socket, one
`pending` map, one frame switch on `t`, and zero-argument hooks. That has to
become device-parameterised before any gripper UI can exist.

1. Keep `armClient` as the arm's client. Add a second instance for the gripper
   that shares the socket, or a `deviceClients = { arm, gripper }` registry.
2. Extend the frame switch with the `gripper_*` tags.
3. Parameterise the hooks: `useArmConnection(device)`, `useArmState(device)`, or
   add `useGripperConnection()` / `useGripperState()` that subscribe to the
   gripper half. Keep the existing zero-argument exports as thin wrappers so no
   arm component changes.
4. Errors keep flowing through `formatArmError`; add the new kinds to `KIND_KEYS`
   and to `common:errors.*` in both locales.

### 6.2 Where the UI goes

There are two surfaces, matching the retired product:

- **A panel on the control page**, `src/features/solo/GripperPanel.tsx`, pinned in
  the right column below the E-stop, for operating the gripper: connect state,
  aperture, open/close/grasp/release, force and speed, live position and
  temperature, fault clearing, E-stop state, and the CAN channel it connects on.
- **A section in the existing settings page**, for configuring it: CAN channel,
  CAN ids, mount, which calibration file is in effect, import a calibration,
  run `zero()`, and the per-channel travel.

The CAN channel appears on both surfaces on purpose: the operator connects and
drives the gripper from the control page, so switching the CAN line from there
must not cost a trip to Settings and back. Both call the same
`gripper.list_channels` and both connect through `gripper.connect`'s `channel`.
The channel lives in the daemon's per-channel record, so the two surfaces cannot
drift, and a channel change is only accepted while disconnected — which is why
both disable the picker while connected.

The panel is a component, not a route. The gripper shares the arm's CAN bus and
is driven from the same page as the arm, so operating it must not navigate away
from the arm's own controls — that is the retired product's layout
(`EndEffectorControlPanel` under the E-stop) and the layout §6.4 retrieves as the
UX baseline. Do not add a `/gripper` route, a rail item, or a top-bar title for
it; those were removed deliberately.

The i18n namespace is `locales/{en,zh}/gripper.json`, registered in
`src/i18n/index.ts` and asserted in `src/i18n/__tests__/i18n.test.ts`.

### 6.3 Panel behaviour

- Everything writable is disabled unless the gripper `status` is `connected`, the
  drive is enabled, and the gate allows the command. Show why it is disabled.
- The aperture slider is `0..travelMm`, commits on release, and is not echoed back
  from the device while the user is dragging. "Dragging" is tracked from the
  slider's **pointer** events, not from value changes: Radix emits
  `onValueCommit` *before* `onValueChange` on a keyboard step, so inferring the
  drag from the value re-opens it and the slider never reconciles again.
- Read-back discipline, as in the settings page: after a write, show what the
  device reports, not what was sent.
- The E-stop is reachable while a move is running. It maps to `gripper.stop`, and
  the panel shows the latched state until `gripper.reset_stop`.
- The calibration card always shows provenance: source label, path, both rad
  endpoints, the derived travel, and the mounting direction. "Nominal template,
  never measured" must be visible, not implied. The endpoints and the path may sit
  behind a collapsed `<details>` — the panel shares a column with the arm's live
  charts — but they must be in the DOM and one click away, not summarised away.
- Only one component may mount `useGripperAlerts()` at a time: each mount is an
  independent subscription, so two of them raise every alert twice.

### 6.4 What to reuse from the retired panels

The old end-effector UI is in this repository's history and is the UX baseline.
Retrieve it with:

```bash
git show b4ed8ed:src/features/solo/EndEffectorControlPanel.tsx   # gripper/hand switch
git show b4ed8ed:src/features/solo/GripperPanel.tsx              # the control panel
git show b4ed8ed:src/features/settings/EndEffectorPanel.tsx      # settings + bus binding
git show b4ed8ed:src/lib/arm/gripper.ts                          # unit helpers
```

Reuse: the panel layout (header with status pill, aperture card, open/close pair,
parameters card), the interaction pattern (slider drives, buttons commit, errors
as one toast with a stable id), and the i18n key names and strings, which are
already translated in both locales.

Do not reuse: the device model list and the "Mount & Start" lifecycle. Those were
a server-side device catalog that no longer exists. There is one known device —
the gripper on a chosen CAN channel — so the settings section collapses to a
channel picker, an id pair, a mount choice and the calibration controls.

Two numbers in the old code are wrong for this hardware and must not be carried
over: `GRIPPER_STROKE_MM = 120` (the measured travel is 85) and
`GRIPPER_FORCE_MAX_N = 40` (keep 40 N as the ceiling but default to 20 N, the
recommended working force).

## 7. Testing

**Daemon.** Extend `daemon/tests` with the simulator backend; no CAN interface and
no hardware. Cover:

- connect / disconnect / reconnect, and interface enumeration parsing.
- Every `gripper.*` command through the WS, including argument validation.
- Calibration resolution: each provenance row in §5.3, the channel-mismatch skip,
  a malformed file, the cross-check mismatch, and the factory acknowledgement.
- The gate: which commands each provenance allows and refuses.
- The E-stop: a stop arriving mid-move engages within one tick, latches, and
  survives until reset; a stop during `gripper.zero` aborts the probe.
- The tick as keepalive: no tick gap exceeds the drive's 0.4 s window.
- Shutdown de-energizes; `disconnect` does not.

**Frontend.** Vitest with the existing `FakeWebSocket`: gripper frame routing,
the new hooks, gate-driven disabling, error kinds, and the page's read-back
behaviour. i18n assertions for the new namespace in both locales.

## 8. Packaging

- `packaging/build.py` collects the SDK with `--collect-all litegrip` **on Linux**.
  The package ships three JSON files and `py.typed`; without the data files
  `load_template` raises. On a Linux build the SDK is required and a missing one
  fails the build: an artifact that silently ships without the gripper is worse
  than a build that stops.
- The SDK is not on PyPI. Install it from a checkout the way `litearm` already is,
  and pin the revision: `v0.4.0` in both workflows, the release that introduced
  named templates and per-channel calibration paths.
- Linux only. `litegrip` needs `fcntl` and `PF_CAN`, so it is never imported at
  module scope: `gripper/backend/real.py` is imported inside `_make_backend`, the
  daemon's session import is guarded, and `__main__` builds no gripper session off
  Linux. `daemon/tests/test_gripper_platform.py` runs the whole startup path in a
  subprocess with `litegrip` blocked and asserts the simulator still works.

## 9. Delivery sequence

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| P1 | `GripperSession` with the simulator backend, frames and commands, no UI | Daemon tests green in `--fake`; the arm's existing tests untouched |
| P2 | Calibration resolution, provenance, gate, cross-check | The §7 calibration cases pass; a malformed or foreign file never enables motion |
| P3 | CAN link: enumeration, probe, privileged bring-up | A correctly configured interface produces no dialog; a wrong one produces one actionable message |
| P4 | Frontend client refactor, the control-page panel and the settings section | `pnpm test` green; the panel drives the simulator end to end |
| P5 | Settings section: channel, mount, import, `zero()` | A `zero()` run against the simulator replaces the template and survives a restart |
| P6 | Packaging and real hardware | The released Linux artifact drives a real gripper; the Windows artifact builds without it |

## 10. Open items

Three items, each with the check that closes it. None of them blocks P1 or P2.

1. **Which interface is the gripper on?** Confirm the adapter and its interface
   name on the control machine, and that the daemon's user may use it. Close it by
   enumerating CAN interfaces on the real machine.
2. **CAN id overlap with the arm's joints.** The gripper uses ESC `0x08` and MST
   `0x18`. Close it by capturing a few seconds of the bus while the arm moves and
   checking the id set, and by checking the bus error counters for headroom.
3. **Per-unit calibration files.** Confirm with the gripper's SDK owner whether a
   per-unit file ships with each gripper or whether the templates are the intended
   factory default. The implementation supports both; only the default differs.
   The SDK revision is pinned at `v0.4.0`; if a per-unit file becomes the default,
   the resolution order in §5.3 does not change — only the file that ships.

## 11. Do not

- Do not call the SDK's `grasp`, `move_at_speed`, `goto` or `home`. They block,
  cannot be interrupted, and `home` uses a constant rather than the calibrated
  closed end. `open()` / `close()` are the one exception, and only in their plain
  forms: each is driven through `open_plain` / `close_plain` with the E-stop
  threaded into its `progress` callback, because their wall-clock ramp is what
  breaks this unit's dead-band at each end (issue #72). A force-carrying close
  does not go through them — the FSM's approach gain is the contact detector
  there.
- Do not call `load_calibration()` with no argument. It falls back to the bundled
  factory file silently and returns success.
- Do not copy `calibration_normal.json` or `calibration_reverse.json` into
  `~/.litegrip/`. Load them by template name; copied in, they pass for a
  measurement.
- Do not touch the gripper object from a second thread, including from the WS
  thread and from a "safety executor". The SDK has no locks; the E-stop is an
  event the tick reads.
- Do not let the tick stop while the drive is enabled. The drive drops out of the
  enabled state after 0.4 s without a frame, and a disabled gripper under load
  moves.
- Do not accept a millimetre target while the calibration is nominal. The
  template's geometry describes a 120 mm unit; every millimetre would be wrong by
  about 40%.
- Do not hardcode the travel. It is per unit, it is not in the SDK's schema, and
  it is the numerator of every millimetre the UI shows.
