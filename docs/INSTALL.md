How to install LiteArm Studio from a release. Read this if you downloaded a release
instead of building the project from source.

# Installing LiteArm Studio

Every release publishes the same program for two platforms. The program is
self-contained: it carries the Python runtime, the arm SDK, the gripper SDK, the USB
DFU engine and the web UI. You need no Python, no Node.js and no repository checkout.

## 1. What the release files are

| File | Platform | What it is |
| :--- | :--- | :--- |
| `litearm-studio-<version>_amd64.deb` | Ubuntu 22.04+, Debian 12+ | the package to install; see § 2 |
| `litearm-studio-<version>-linux-amd64` | other Linux, 64-bit x86 | the program as a plain one-file executable; see § 3 |
| `litearm-studio-<version>-windows-amd64.exe` | 64-bit x86 Windows | the same program with an `.exe` suffix; see § 4 |
| `<file>.sha256` | — | SHA-256 checksum of the file it is published next to |

No other architecture is published. An arm64 machine cannot run these files; build from
source instead.

**On Ubuntu and Debian, install the `.deb`.** It is the only artifact that can do the
three things the standalone file cannot: make itself executable, grant access to the
arm's serial port, and put an entry in the application list.

The standalone Linux file deliberately has **no extension**, which has two consequences:

- GitHub serves it with mode `0644`, so it is **not executable** until you run
  `chmod +x`. Running it first gives `Permission denied`.
- Double-clicking it in a file manager either fails with "Untrusted application
  launcher" or opens it as text. Run it from a terminal instead, as § 3.3 shows.

## 2. Install on Ubuntu or Debian with apt

### 2.1 Download and verify

Run these commands in your download directory. This example uses release 0.12.0; change
`version` for a newer release.

```bash
mkdir -p ~/Downloads
cd ~/Downloads
version=0.12.0
base="https://github.com/nexform-tech/litearm-studio/releases/download/v${version}"
curl -LO "$base/litearm-studio_${version}_amd64.deb"
curl -LO "$base/litearm-studio_${version}_amd64.deb.sha256"
sha256sum -c "litearm-studio_${version}_amd64.deb.sha256"
# litearm-studio_0.12.0_amd64.deb: OK
```

### 2.2 Install

```bash
cd ~/Downloads
sudo apt install ./litearm-studio_0.12.0_amd64.deb
```

Use `apt install ./file.deb` rather than `dpkg -i`: apt resolves the dependencies, and it
refuses the install on a distribution older than Ubuntu 22.04 / Debian 12 instead of
leaving you with a program that dies on a missing `GLIBC_2.35`.

### 2.3 Start it

`litearm-studio` is now on `PATH`, and **LiteArm Studio** appears in the application
list. Either one starts the program.

```bash
litearm-studio
litearm-studio --fake     # offline: a complete session with no hardware
```

The program prints the address it listens on, `http://127.0.0.1:8765/` by default, and
opens a window. If that port is taken it picks the next free one, prints it, and **the
printed address is the one to use**. The window is the whole interface, and it belongs to
the program: **closing it quits the program**, which de-energises the arm and releases the
serial port. Reloading the page does not quit — only closing the window does.

Starting `litearm-studio` again while an instance is already running **raises that
instance's window** instead of starting a second program. This matters: a second program
cannot reach the arm, because the first one holds the serial port. Options that ask for a
specific session — `--port`, `--fake`, `--can-channel`, `--ui-dir` and the other session
flags — start a separate instance instead, since reusing the running one would silently
discard them. A running instance of a *different* version is not reused either, so after a
package upgrade the new launch starts normally. Run `litearm-studio --no-open` to start
without a window (the UI is then reachable in a browser at the printed address).

### 2.4 What the package sets up

| Path | Purpose |
| :--- | :--- |
| `/usr/bin/litearm-studio` | the command that starts the program |
| `/usr/lib/litearm-studio/litearm-studio-daemon` | the program itself; its `_internal/` directory sits beside it — keep the two together |
| `/usr/share/applications/litearm-studio.desktop` | the application-list entry |
| `/usr/share/icons/hicolor/*/apps/litearm-studio.png` | the icon |
| `/usr/lib/udev/rules.d/60-litearm-studio.rules` | lets the logged-in desktop user open the arm's serial port, so you never join the `dialout` group |

The udev rule works through a systemd-logind ACL (`TAG+="uaccess"`), which covers a
desktop login. Over SSH, use § 5 instead.

### 2.5 Uninstall

```bash
sudo apt remove litearm-studio
```

Settings stay in `~/.config/litearm-studio/` — see § 8.

## 3. Install the standalone executable on Linux

Use this on any Linux that is not Ubuntu or Debian, or when you have no root access.

### 3.1 Download

Run these commands in the directory where you want to keep the program.

```bash
mkdir -p ~/Applications
cd ~/Applications
version=0.12.0
base="https://github.com/nexform-tech/litearm-studio/releases/download/v${version}"
curl -LO "$base/litearm-studio-${version}-linux-amd64"
curl -LO "$base/litearm-studio-${version}-linux-amd64.sha256"
```

### 3.2 Verify the checksum

```bash
cd ~/Applications
sha256sum -c litearm-studio-0.12.0-linux-amd64.sha256
# litearm-studio-0.12.0-linux-amd64: OK
```

The `.sha256` file names the executable, so `sha256sum -c` only works while both files
sit in the same directory. Do not verify a file you moved without moving its checksum
as well.

### 3.3 Make it executable and run it

```bash
cd ~/Applications
chmod +x litearm-studio-0.12.0-linux-amd64
./litearm-studio-0.12.0-linux-amd64
```

The program prints the address it listens on, `http://127.0.0.1:8765/` by default, and
opens a window. Use the printed address if that port was taken.

### 3.4 Requirements

| Requirement | Why it matters |
| :--- | :--- |
| glibc 2.35 or newer | Ubuntu 22.04+, Debian 12+. On Ubuntu 20.04 the program fails to start and the shell reports a missing `GLIBC_2.35` |
| An executable `$TMPDIR` | Every start unpacks about 87 MB into `$TMPDIR` (default `/tmp`) and runs from there. A `/tmp` mounted `noexec` breaks the start; point `TMPDIR` at a normal directory instead |
| A browser | Any browser works. With Chrome, Chromium, Edge or Brave on `PATH` the window opens without an address bar; otherwise the default browser opens a tab |
| Access to the serial port | Real arm only. See § 5 |

Starting the program takes a few seconds, because of that unpack. That is expected.

### 3.5 Useful command-line flags

| Flag | What it does |
| :--- | :--- |
| `--fake` | Runs a complete session against a simulated arm, with no hardware |
| `--fake-unactivated` | With `--fake`: simulates an unlicensed arm, so the activation panel shows its signup form |
| `--port /dev/ttyACM1` | Uses a serial device the automatic discovery did not pick |
| `--http-port 9000` | Binds a different HTTP port |
| `--no-open` | Does not open a browser window |
| `--no-gripper` | Does not start the gripper session |
| `--can-channel can0` | Names the SocketCAN interface the gripper is on |
| `--no-can-setup` | Does not try to bring the CAN interface up with `pkexec` |
| `--verbose` | Prints debug logging |

The full list is in `litearm-studio --help`, or
`./litearm-studio-0.12.0-linux-amd64 --help` for a standalone install.

## 4. Install on Windows

Download `litearm-studio-<version>-windows-amd64.exe` from the same release and
double-click it. Nothing else is needed; the same window opens.

To verify the download, run this in the directory holding the file and compare the
value with the content of the `.sha256` file:

```powershell
certutil -hashfile litearm-studio-0.12.0-windows-amd64.exe SHA256
```

The executable is not code-signed, so Windows shows "Windows protected your PC" the
first time. Choose **More info** and then **Run anyway**; without that, the file never
starts. Do not work around it by disabling SmartScreen for the whole machine.

## 5. Let the program use the serial port (standalone installs)

If you installed the `.deb`, skip this section: its udev rule already grants access.

The arm appears as a USB CDC device with VID:PID `1d50:606f`, owned by the `dialout`
group. Without access to it the UI opens but never connects.

```bash
sudo usermod -aG dialout "$USER"   # takes effect after you log out and back in
```

Logging out and back in is required; a new terminal is not enough. Alternatively, add a
udev rule that grants the desktop user access — this is the same rule the `.deb`
installs:

```bash
sudo tee /etc/udev/rules.d/60-litearm-studio.rules >/dev/null <<'EOF'
SUBSYSTEM=="tty", ATTRS{idVendor}=="1d50", ATTRS{idProduct}=="606f", ENV{ID_MM_DEVICE_IGNORE}="1", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=tty
```

Reconnect the arm after either change.

## 6. Gripper (Linux, optional)

The gripper shares the arm's CAN bus and needs a SocketCAN interface. By default the
program asks to bring it up through `pkexec`, which shows a graphical authorisation
prompt; that prompt needs a running polkit agent, so it does nothing over a plain SSH
session.

- Bring the interface up yourself and pass `--no-can-setup` to skip the prompt.
- Pass `--no-gripper` to run without the gripper entirely.
- Pass `--can-channel <device>` to name the interface if it is not the one the program
  remembers.

The gripper is present in the Linux build only. It is absent from the Windows build,
not disabled: the SDK it needs cannot import there.

## 7. First run: activation

A new arm must be activated once before it can move. Until then, pressing
**Enable** does nothing, while everything else works. Make sure the computer is
online and the arm is connected, then:

1. Click **Settings**, then **Activation**. If it says **Activated**, you are done.
2. Fill in the form. Name, phone, organization, email and region are required.
3. Tick the consent box.
4. If the arm is enabled, press **Disable** first and hold the arm steady, because it
   will sag under its own weight.
5. Press **Submit and activate** and wait a few seconds.

Activation is the only feature that needs the internet. It applies to this one arm
only, so a second arm needs its own activation, and it cannot be undone from the
software. If the panel says "no credential for this machine", press **Copy** and send
the copied machine number to your supplier, then submit again.

## 8. Where settings live

The program stores the few settings it remembers (currently the SocketCAN channel it
last used) under `$XDG_CONFIG_HOME/litearm-studio/`, which is
`~/.config/litearm-studio/` by default.

Removing the program does not remove them:

```bash
sudo apt remove litearm-studio                          # package install
rm ~/Applications/litearm-studio-0.12.0-linux-amd64     # standalone install
rm -rf ~/.config/litearm-studio
```

## 9. Troubleshooting

| Symptom | Cause and fix |
| :--- | :--- |
| `bash: ./litearm-studio-0.12.0-linux-amd64: Permission denied` | The standalone file is not executable. Run `chmod +x` on it (see § 3.3), or install the `.deb` |
| `cannot execute binary file: Exec format error` | The file is x86-64 only, or the download was truncated by a proxy. Re-download it and check the checksum |
| `version 'GLIBC_2.35' not found` | The distribution is older than Ubuntu 22.04 / Debian 12. Build the program from source instead |
| `apt install` refuses with `libc6 (>= 2.35)` | The same thing, reported by apt before anything is installed. Build from source |
| The program exits immediately, mentioning extraction | `$TMPDIR` (usually `/tmp`) is mounted `noexec`. Run it with `TMPDIR=~/tmp litearm-studio` after creating that directory |
| The UI loads but the badge stays "Connect failed" | The serial device is missing or not readable. Check § 5, then pass `--port` explicitly |
| The UI loads but never shows state | The WebSocket is blocked. Same-origin handshakes are required; a proxy or a browser extension that rewrites origins breaks it |
| Nothing opens, only "无法自动打开浏览器" in the terminal | No browser was found. Open the printed address by hand |
| **Enable** does nothing | The arm is not activated. See § 7 |
| The activation panel reads **Not supported** | The firmware predates 1.8.0. Update the firmware first (see [user manual](USER_MANUAL.md) §5.7) |
