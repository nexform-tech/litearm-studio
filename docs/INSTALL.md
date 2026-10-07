How to install the prebuilt LiteArm Studio executables from a release. Read this if
you downloaded a release instead of building the project from source.

# Installing LiteArm Studio

Every release publishes the same program for two platforms. The executable is
self-contained: it carries the Python runtime, the arm SDK, the gripper SDK, the USB
DFU engine and the web UI. You need no Python, no Node.js and no repository checkout.

## 1. What the release files are

| File | Platform | What it is |
| :--- | :--- | :--- |
| `litearm-studio-<version>-linux-amd64` | Ubuntu 22.04+, Debian 12+ | 64-bit x86 executable, about 38 MB |
| `litearm-studio-<version>-windows-amd64.exe` | 64-bit x86 Windows | the same program with an `.exe` suffix |
| `<file>.sha256` | — | SHA-256 checksum of the file it is published next to |

No other architecture is published. An arm64 machine cannot run these files.

The Linux file deliberately has **no extension**. Two consequences matter:

- GitHub serves it with mode `0644`, so it is **not executable** until you run
  `chmod +x`. Running it first gives `Permission denied`.
- Double-clicking it in a file manager either fails with "Untrusted application
  launcher" or opens it as text. Install it from a terminal instead, as § 2.3 shows.

The Linux file is not a package: there is no `.deb`, no AppImage and nothing to
install system-wide. "Installing" it means putting the file where you want it,
making it executable, and running it.

## 2. Install on Linux

### 2.1 Download

Run these commands in the directory where you want to keep the program. This example
uses `~/Applications` and release 0.11.0; change `version` for a newer release.

```bash
mkdir -p ~/Applications
cd ~/Applications
version=0.11.0
base="https://github.com/nexform-tech/litearm-studio/releases/download/v${version}"
curl -LO "$base/litearm-studio-${version}-linux-amd64"
curl -LO "$base/litearm-studio-${version}-linux-amd64.sha256"
```

### 2.2 Verify the checksum

```bash
cd ~/Applications
sha256sum -c litearm-studio-0.11.0-linux-amd64.sha256
# litearm-studio-0.11.0-linux-amd64: OK
```

The `.sha256` file names the executable, so `sha256sum -c` only works while both files
sit in the same directory. Do not verify a file you moved without moving its checksum
as well.

### 2.3 Make it executable and run it

```bash
cd ~/Applications
chmod +x litearm-studio-0.11.0-linux-amd64
./litearm-studio-0.11.0-linux-amd64
```

The program prints the address it listens on, `http://127.0.0.1:8765/` by default,
and opens a window. If that port is taken it picks the next free one, prints it, and
**the printed address is the one to use**.

The window is the whole interface. Closing it does not stop the program; press
`Ctrl+C` in the terminal to stop the program, which also disables the arm on exit.

### 2.4 Requirements

| Requirement | Why it matters |
| :--- | :--- |
| glibc 2.35 or newer | Ubuntu 22.04+, Debian 12+. On Ubuntu 20.04 the program fails to start and the shell reports a missing `GLIBC_2.35` |
| An executable `$TMPDIR` | Every start unpacks about 87 MB into `$TMPDIR` (default `/tmp`) and runs from there. A `/tmp` mounted `noexec` breaks the start; point `TMPDIR` at a normal directory instead |
| A browser | Any browser works. With Chrome, Chromium, Edge or Brave on `PATH` the window opens without an address bar; otherwise the default browser opens a tab |
| Access to the serial port | Real arm only. See § 4 |

Starting the program takes a few seconds, because of that unpack. That is expected.

### 2.5 Useful command-line flags

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

The full list is in `./litearm-studio-0.11.0-linux-amd64 --help`.

## 3. Install on Windows

Download `litearm-studio-<version>-windows-amd64.exe` from the same release and
double-click it. Nothing else is needed; the same window opens.

To verify the download, run this in the directory holding the file and compare the
value with the content of the `.sha256` file:

```powershell
certutil -hashfile litearm-studio-0.11.0-windows-amd64.exe SHA256
```

The executable is not code-signed, so Windows shows "Windows protected your PC" the
first time. Choose **More info** and then **Run anyway**; without that, the file never
starts. Do not work around it by disabling SmartScreen for the whole machine.

## 4. Let the program use the serial port (Linux, real arm)

The arm appears as a USB CDC device with VID:PID `1d50:606f`, owned by the `dialout`
group. Without access to it the UI opens but never connects.

```bash
sudo usermod -aG dialout "$USER"   # takes effect after you log out and back in
```

Logging out and back in is required; a new terminal is not enough. Alternatively, add
a udev rule that grants the desktop user access:

```bash
sudo tee /etc/udev/rules.d/60-litearm-studio.rules >/dev/null <<'EOF'
SUBSYSTEM=="tty", ATTRS{idVendor}=="1d50", ATTRS{idProduct}=="606f", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=tty
```

Reconnect the arm after either change.

## 5. Gripper (Linux, optional)

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

## 6. First run: activation

An arm that has never been activated refuses to enable and answers `ERR{0x10,0x08}`
to every enable request. Everything else in the UI works, so the first run looks
half-broken until you finish this.

1. Open **Settings → Activation**. The panel shows the device UID, 24 hex characters.
2. Copy the UID and give it to your supplier, who issues a credential for that
   machine.
3. Fill in the registration form (**name, phone, organization, email and region are
   required**) and accept the consent document.
4. Disarm the arm. The firmware rejects the licence record while the arm is armed.
5. Press **Submit and activate**.

Activation is the only feature that uses the network, and the credential is bound to
one machine: another arm needs a credential issued for its own UID. The record is
written once and cannot be erased from the UI.

## 7. Where settings live, and how to uninstall

The program stores the few settings it remembers (currently the SocketCAN channel it
last used) under `$XDG_CONFIG_HOME/litearm-studio/`, which is
`~/.config/litearm-studio/` by default.

To uninstall, stop the program, delete the executable, and remove that directory:

```bash
rm ~/Applications/litearm-studio-0.11.0-linux-amd64
rm -rf ~/.config/litearm-studio
```

Nothing else was installed: no service, no desktop entry, no file outside those two
paths.

## 8. Troubleshooting

| Symptom | Cause and fix |
| :--- | :--- |
| `bash: ./litearm-studio-0.11.0-linux-amd64: Permission denied` | The file is not executable. Run `chmod +x` on it (see § 2.3) |
| `cannot execute binary file: Exec format error` | The file is x86-64 only, or the download was truncated by a proxy. Re-download it and check the checksum |
| `version 'GLIBC_2.35' not found` | The distribution is older than Ubuntu 22.04 / Debian 12. Build the program from source instead |
| The program exits immediately, mentioning extraction | `$TMPDIR` (usually `/tmp`) is mounted `noexec`. Run it with `TMPDIR=~/tmp ./litearm-studio-0.11.0-linux-amd64` after creating that directory |
| The UI loads but the badge stays "Connect failed" | The serial device is missing or not readable. Check § 4, then pass `--port` explicitly |
| The UI loads but never shows state | The WebSocket is blocked. Same-origin handshakes are required; a proxy or a browser extension that rewrites origins breaks it |
| Nothing opens, only "无法自动打开浏览器" in the terminal | No browser was found. Open the printed address by hand |
| `Enable` does nothing and the arm answers `ERR{0x10,0x08}` | The arm is not activated. See § 6 |
| The activation panel reads "Unsupported" | The firmware predates 1.8.0 and must be upgraded |
