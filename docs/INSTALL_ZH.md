本文说明如何安装 LiteArm Studio 发布版，适用于直接下载发布文件、不从源码构建的用户。

# 安装 LiteArm Studio

每个版本都为两个平台发布同一个程序。程序自带 Python 运行时、机械臂 SDK、夹爪 SDK、USB DFU 烧录引擎和网页界面，无需安装 Python、Node.js，也无需下载源码仓库。

## 1. 发布文件说明

| 文件 | 平台 | 说明 |
| :--- | :--- | :--- |
| `litearm-studio-<版本号>_amd64.deb` | Ubuntu 22.04+、Debian 12+ | 安装包，见 § 2 |
| `litearm-studio-<版本号>-linux-amd64` | 其他 64 位 x86 Linux | 单文件可执行程序，见 § 3 |
| `litearm-studio-<版本号>-windows-amd64.exe` | 64 位 x86 Windows | 同一程序的 `.exe` 版本，见 § 4 |
| `<文件名>.sha256` | — | 同目录文件的 SHA-256 校验值 |

只发布以上架构。arm64 设备无法运行这些文件，请从源码构建。

**Ubuntu 和 Debian 请安装 `.deb`。** 只有它能完成单文件版做不到的三件事：自动设置执行权限、授予机械臂串口访问权限、在应用列表中添加入口。

Linux 单文件版刻意不带扩展名，因此：

- 从 GitHub 下载后权限为 `0644`，**没有执行权限**，必须先执行 `chmod +x`，否则运行时提示 `Permission denied`；
- 在文件管理器中双击，会提示「不受信任的应用程序启动器」，或把它当作文本打开。请按 § 3.3 在终端中运行。

## 2. 在 Ubuntu 或 Debian 上安装

### 2.1 下载并校验

在下载目录执行以下命令。示例使用 0.12.0 版本，请把 `version` 改成最新版本号。

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

### 2.2 安装

```bash
cd ~/Downloads
sudo apt install ./litearm-studio_0.12.0_amd64.deb
```

请使用 `apt install ./文件名.deb`，不要用 `dpkg -i`。apt 会自动处理依赖，并在系统低于 Ubuntu 22.04 / Debian 12 时拒绝安装，避免装好后因缺少 `GLIBC_2.35` 无法启动。

### 2.3 启动

安装后 `litearm-studio` 命令可直接使用，应用列表中也会出现 **LiteArm Studio**。两种方式都可以启动程序。

```bash
litearm-studio
litearm-studio --fake     # 离线模式：无需硬件的完整会话
```

程序会打印监听地址（默认 `http://127.0.0.1:8765/`）并自动打开窗口。端口被占用时会自动换用下一个空闲端口，**请以打印出的地址为准**。这个窗口就是完整的操作界面。关闭窗口不会停止程序；程序退出时会让机械臂失能。

### 2.4 安装包写入的内容

| 路径 | 用途 |
| :--- | :--- |
| `/usr/bin/litearm-studio` | 启动程序的命令 |
| `/usr/lib/litearm-studio/litearm-studio-daemon` | 自包含的可执行程序 |
| `/usr/share/applications/litearm-studio.desktop` | 应用列表入口 |
| `/usr/share/icons/hicolor/*/apps/litearm-studio.png` | 图标 |
| `/usr/lib/udev/rules.d/60-litearm-studio.rules` | 允许当前登录的桌面用户访问机械臂串口，无需加入 `dialout` 组 |

这条 udev 规则通过 systemd-logind 的 ACL（`TAG+="uaccess"`）生效，只对桌面登录有效。通过 SSH 登录时请按 § 5 操作。

### 2.5 卸载

```bash
sudo apt remove litearm-studio
```

设置文件保留在 `~/.config/litearm-studio/`，见 § 8。

## 3. 在 Linux 上安装单文件版

适用于非 Ubuntu / Debian 的 Linux，或没有 root 权限的情况。

### 3.1 下载

在你想存放程序的目录执行以下命令。

```bash
mkdir -p ~/Applications
cd ~/Applications
version=0.12.0
base="https://github.com/nexform-tech/litearm-studio/releases/download/v${version}"
curl -LO "$base/litearm-studio-${version}-linux-amd64"
curl -LO "$base/litearm-studio-${version}-linux-amd64.sha256"
```

### 3.2 校验

```bash
cd ~/Applications
sha256sum -c litearm-studio-0.12.0-linux-amd64.sha256
# litearm-studio-0.12.0-linux-amd64: OK
```

`.sha256` 文件里记录的是可执行文件的文件名，因此两个文件必须放在同一目录下，`sha256sum -c` 才能通过。移动了可执行文件，就要连同校验文件一起移动。

### 3.3 设置执行权限并运行

```bash
cd ~/Applications
chmod +x litearm-studio-0.12.0-linux-amd64
./litearm-studio-0.12.0-linux-amd64
```

程序会打印监听地址（默认 `http://127.0.0.1:8765/`）并自动打开窗口。端口被占用时请以打印出的地址为准。

### 3.4 运行要求

| 要求 | 说明 |
| :--- | :--- |
| glibc 2.35 及以上 | 即 Ubuntu 22.04+、Debian 12+。在 Ubuntu 20.04 上程序无法启动，终端提示缺少 `GLIBC_2.35` |
| `$TMPDIR` 可执行 | 每次启动都会向 `$TMPDIR`（默认 `/tmp`）解压约 87 MB 并从中运行。`/tmp` 以 `noexec` 挂载时无法启动，请把 `TMPDIR` 指向普通目录 |
| 浏览器 | 任意浏览器均可。`PATH` 中有 Chrome、Chromium、Edge 或 Brave 时，窗口不带地址栏；否则用默认浏览器打开标签页 |
| 串口访问权限 | 仅连接真实机械臂时需要，见 § 5 |

启动需要几秒钟，这是解压造成的，属于正常现象。

### 3.5 常用命令行参数

| 参数 | 作用 |
| :--- | :--- |
| `--fake` | 用模拟机械臂运行完整会话，无需硬件 |
| `--fake-unactivated` | 与 `--fake` 合用：模拟未激活的机械臂，激活页面会显示注册表单 |
| `--port /dev/ttyACM1` | 指定自动发现没有选中的串口设备 |
| `--http-port 9000` | 改用其他 HTTP 端口 |
| `--no-open` | 不自动打开浏览器窗口 |
| `--no-gripper` | 不启动夹爪会话 |
| `--can-channel can0` | 指定夹爪所在的 SocketCAN 接口 |
| `--no-can-setup` | 不尝试通过 `pkexec` 拉起 CAN 接口 |
| `--verbose` | 输出调试日志 |

完整参数见 `litearm-studio --help`；单文件版请执行 `./litearm-studio-0.12.0-linux-amd64 --help`。

## 4. 在 Windows 上安装

从同一发布页下载 `litearm-studio-<版本号>-windows-amd64.exe`，双击运行即可，不需要其他组件，打开的是同一个窗口。

校验下载文件：在文件所在目录执行以下命令，并将输出与 `.sha256` 文件的内容比对。

```powershell
certutil -hashfile litearm-studio-0.12.0-windows-amd64.exe SHA256
```

可执行文件没有代码签名，首次运行时 Windows 会提示「Windows 已保护你的电脑」。点击**更多信息**，再点击**仍要运行**，否则程序无法启动。**不要**为此关闭整台电脑的 SmartScreen。

## 5. 授予串口访问权限（单文件版）

安装了 `.deb` 的用户可跳过本节，安装包里的 udev 规则已经授权。

机械臂以 USB CDC 设备出现，VID:PID 为 `1d50:606f`，属于 `dialout` 组。没有访问权限时，界面能打开，但始终连不上机械臂。

```bash
sudo usermod -aG dialout "$USER"   # 注销并重新登录后生效
```

必须注销后重新登录，只打开新终端不起作用。也可以改用 udev 规则授权桌面用户，这与 `.deb` 安装的规则相同：

```bash
sudo tee /etc/udev/rules.d/60-litearm-studio.rules >/dev/null <<'EOF'
SUBSYSTEM=="tty", ATTRS{idVendor}=="1d50", ATTRS{idProduct}=="606f", ENV{ID_MM_DEVICE_IGNORE}="1", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=tty
```

两种方式设置完成后，都需要重新插拔机械臂。

## 6. 夹爪（仅 Linux，可选）

夹爪与机械臂共用 CAN 总线，需要一个 SocketCAN 接口。默认情况下，程序会通过 `pkexec` 请求拉起该接口，并弹出图形化授权窗口。这个窗口依赖运行中的 polkit 代理，在纯 SSH 会话中不会出现。

- 自行拉起接口，并加上 `--no-can-setup` 跳过授权窗口；
- 加上 `--no-gripper`，完全不使用夹爪；
- 接口不是程序记住的那个时，用 `--can-channel <设备名>` 指定。

夹爪功能仅包含在 Linux 版中。Windows 版没有这个功能，而不是被禁用：所依赖的 SDK 在 Windows 上无法导入。

## 7. 首次运行：激活

新机械臂首次使用前必须激活，否则「使能」无效，其他功能不受影响。请确认电脑已联网、机械臂已连接，然后：

1. 进入「设置」页面，点击「授权激活」；页面显示「已激活」时无需操作；
2. 页面显示「未激活」时，填写表单；
3. 勾选「同意《激活注册信息同意书》」；
4. 点击「提交并激活」。

页面显示「已激活」即成功。提示「没有这台机器的凭据」时，点击「复制」，将机器编号发送给供应商。其他提示的处理办法见 [用户手册](USER_MANUAL_ZH.md) §1.4。

激活是本软件唯一需要联网的操作。激活仅对当前这一台机械臂有效，更换机械臂需重新激活，且无法在软件中撤销。

## 8. 设置文件位置

程序只保存少量设置（目前是上次使用的 SocketCAN 接口），位于 `$XDG_CONFIG_HOME/litearm-studio/`，默认是 `~/.config/litearm-studio/`。

卸载程序不会删除这些设置，需要手动清理：

```bash
sudo apt remove litearm-studio                          # 安装包方式
rm ~/Applications/litearm-studio-0.12.0-linux-amd64     # 单文件方式
rm -rf ~/.config/litearm-studio
```

## 9. 常见问题

| 现象 | 原因与处理 |
| :--- | :--- |
| `bash: ./litearm-studio-0.12.0-linux-amd64: Permission denied` | 单文件版没有执行权限。执行 `chmod +x`（见 § 3.3），或改装 `.deb` |
| `cannot execute binary file: Exec format error` | 文件只支持 x86-64，或下载被代理截断。重新下载并校验 |
| `version 'GLIBC_2.35' not found` | 系统低于 Ubuntu 22.04 / Debian 12，请从源码构建 |
| `apt install` 报 `libc6 (>= 2.35)` 无法满足 | 原因同上，由 apt 在安装前报出，请从源码构建 |
| 程序启动后立即退出，提示解压失败 | `$TMPDIR`（通常是 `/tmp`）以 `noexec` 挂载。先创建 `~/tmp`，再执行 `TMPDIR=~/tmp litearm-studio` |
| 界面能打开，但顶栏一直显示「连接失败」 | 串口设备不存在或没有读取权限。检查 § 5，并用 `--port` 显式指定设备 |
| 界面能打开，但一直没有状态 | WebSocket 被拦截。握手要求同源，改写来源的代理或浏览器扩展会导致失败 |
| 终端只提示「无法自动打开浏览器」，没有窗口 | 没有找到浏览器，请手动打开终端打印出的地址 |
| 点「使能」没有反应 | 机械臂尚未激活，见 § 7 |
| 激活页面提示「固件不支持」 | 固件版本低于 1.8.0，需要先升级固件，见 [用户手册](USER_MANUAL_ZH.md) §5.7 |
