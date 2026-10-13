"""Tests for `packaging/deb.py`, the builder of the Debian package for Ubuntu users.

The module is loaded by path instead of imported: its directory is called `packaging`,
which would shadow the PyPI package of the same name inside the test session. The last
test builds a real `.deb` with `dpkg-deb`, which is why it is skipped off Debian/Ubuntu.
"""
from __future__ import annotations

import gzip
import importlib.util
import os
import pathlib
import shutil
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEB_PY = ROOT / "packaging" / "deb.py"
ICON_DIR = ROOT / "assets" / "icon-png"


def _load_deb_module():
    spec = importlib.util.spec_from_file_location("litearm_studio_deb", DEB_PY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deb = _load_deb_module()

needs_dpkg = pytest.mark.skipif(
    shutil.which("dpkg-deb") is None,
    reason="dpkg-deb only exists on Debian and Ubuntu",
)


def _fake_binary(tmp_path: pathlib.Path) -> pathlib.Path:
    """A stand-in for the 38 MB one-file executable: `payload()` never reads it."""
    binary = tmp_path / "litearm-studio-daemon"
    binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    binary.chmod(0o755)
    return binary


# ---------------------------------------------------------------- version numbers


def test_deb_version_strips_the_git_tag_prefix():
    assert deb.deb_version("v0.12.0") == "0.12.0"
    assert deb.deb_version("0.12.0") == "0.12.0"


@pytest.mark.parametrize("bad", ["", "v", "nightly", "v-1.0.0", "1.0.0-rc1", "1.0.0 beta"])
def test_deb_version_rejects_what_dpkg_would_reject(bad):
    # A hyphen would be read as the Debian revision separator, and dpkg rejects an
    # upstream version that does not start with a digit. Failing here beats shipping a
    # package that dpkg refuses with a cryptic message.
    with pytest.raises(SystemExit):
        deb.deb_version(bad)


# ------------------------------------------------------------------- control file


def _control(**overrides) -> str:
    args = {"version": "0.12.0", "arch": "amd64", "installed_size_kb": 40000}
    args.update(overrides)
    return deb.control_text(**args)


def _depends(window_backend: str = "gtk") -> list:
    line = next(line for line in _control(window_backend=window_backend).splitlines()
                if line.startswith("Depends:"))
    return [entry.strip() for entry in line[len("Depends:"):].split(",")]


def test_control_declares_the_glibc_floor():
    assert deb.GLIBC_FLOOR == "2.35"
    assert f"libc6 (>= {deb.GLIBC_FLOOR})" in _depends()


def test_control_never_pulls_a_browser_in():
    """A browser is never a dependency, whichever backend built the executable.

    The program brings its own renderer, so a machine with no browser installed must
    still work. A browser stays a `Suggests`, for people who want to open the interface
    in one — and never a `Recommends`, which would install a second browser by default
    on a workstation that already has one.
    """
    for backend in ("gtk", "qt"):
        depends = " ".join(_depends(backend))
        for browser in ("firefox", "chromium", "google-chrome", "epiphany"):
            assert browser not in depends, f"{browser} leaked into the {backend} Depends"
        assert "Suggests:" in _control(window_backend=backend)


def test_control_borrows_the_system_webkit_only_for_the_gtk_build():
    """GTK 借系统的 WebKit, Qt 自带内核 —— 这条决定了包是 63 MB 还是 243 MB。

    `libwebkit2gtk` 一个库就有 94 MB。GTK 产物把它留在系统上，用 `Depends` 要过来
    （`gir1.2-webkit2-4.1` 会一并带出 typelib 与 GTK 那条链）；Qt 全部打进产物，于是
    `Depends` 只剩 libc6。**两边写反的后果都不是构建失败**：Qt 包会白拉 126 MB 到用户
    机器上，GTK 包则一开窗就报"没有可用的 webview 后端"。
    """
    assert deb.WEBKIT_DEPENDS in _depends("gtk")
    assert _depends("qt") == [f"libc6 (>= {deb.GLIBC_FLOOR})"]


def test_control_looks_like_a_debian_control_file():
    text = _control()
    for field in ("Package: litearm-studio", "Version: 0.12.0", "Section: science",
                  "Priority: optional", "Architecture: amd64", "Installed-Size: 40000",
                  f"Maintainer: {deb.MAINTAINER}", f"Homepage: {deb.HOMEPAGE}"):
        assert field in text

    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("Description:"))
    continuation = lines[start + 1:]
    assert continuation, "the description needs an extended description"
    # Debian continues a field with a leading space and uses a lone `.` for a blank line.
    assert all(line.startswith(" ") and line.strip() for line in continuation)


# ------------------------------------------------- launcher, desktop entry, udev rule


def test_desktop_entry_launches_the_wrapper():
    entry = deb.desktop_entry()
    assert entry.startswith("[Desktop Entry]\n")
    assert "Type=Application" in entry
    assert f"Exec={deb.LAUNCHER}" in entry
    assert f"Icon={deb.LAUNCHER}" in entry
    assert "Terminal=false" in entry
    assert entry.endswith("\n")


def test_desktop_entry_groups_the_window_under_our_own_icon():
    """`StartupWMClass` 必须与**窗口自己报的** WM_CLASS 相等。

    这条等式就是"任务栏里显示我们的 LOGO 还是别人的图标"的全部机制: 桌面按它把窗口归到
    这个启动条目下。两处分别写在 `packaging/deb.py`(字符串) 与 `window.py`(设进 GTK/Qt),
    谁也管不着谁 —— 所以在这里钉住, 免得以后改了一处忘了另一处 (症状是"能用但图标不对",
    最难在评审里看见的一种回归)。同一段文字与 daemon 的 `WINDOW_CLASS` 逐字比较。
    """
    from litearm_studio_daemon.window import WINDOW_CLASS

    entry = deb.desktop_entry()
    assert f"StartupWMClass={WINDOW_CLASS}" in entry
    # 图标名与 WM_CLASS 也要一致: 桌面用 `Icon=` 找图, 用 `StartupWMClass=` 找窗口。
    assert f"Icon={WINDOW_CLASS}" in entry


def test_launcher_is_a_wrapper_around_the_bundled_executable():
    script = deb.launcher_script()
    assert script.startswith("#!/bin/sh\n")
    assert f'exec {deb.INSTALL_DIR}/{deb.BINARY_NAME} "$@"' in script
    # The wrapper points the gripper at the packaged default calibration: the path
    # under /usr/lib stays put across launches (the one-file bundle unpacks to a
    # fresh temp dir each time), so the settings page can name a stable file.
    assert f"LITEGRIP_FACTORY_CALIB={deb.INSTALL_DIR}/factory_calibration.json" in script
    assert "export LITEGRIP_FACTORY_CALIB" in script


def test_udev_rule_grants_the_desktop_user_access():
    rule = deb.udev_rule()
    vendor, product = deb.VID_PID
    assert 'SUBSYSTEM=="tty"' in rule
    assert f'ATTRS{{idVendor}}=="{vendor}"' in rule
    assert f'ATTRS{{idProduct}}=="{product}"' in rule
    assert 'TAG+="uaccess"' in rule  # what removes the dialout group step
    assert 'ENV{ID_MM_DEVICE_IGNORE}="1"' in rule  # keep ModemManager off the port
    assert not rule.startswith("#!")


def test_maintainer_scripts_never_fail_an_install():
    for script in (deb.postinst_script(), deb.postrm_script()):
        assert script.startswith("#!/bin/sh\n")
        assert "set -e" in script
        assert "udevadm control --reload-rules" in script
        # A container without udev must still be able to configure the package.
        assert script.count("|| true") >= 1


# ------------------------------------------------------------------------ payload


def test_payload_installs_the_executable_the_launcher_and_every_icon_size(tmp_path):
    entries = deb.payload(_fake_binary(tmp_path))
    modes = {path.as_posix(): mode for path, _source, mode in entries}

    assert modes[f"usr/lib/{deb.PACKAGE}/{deb.BINARY_NAME}"] == 0o755
    # The default gripper calibration ships beside the executable, at the path the
    # launcher exports as LITEGRIP_FACTORY_CALIB.
    assert modes[f"usr/lib/{deb.PACKAGE}/factory_calibration.json"] == 0o644
    assert modes[f"usr/bin/{deb.LAUNCHER}"] == 0o755
    assert modes[f"usr/share/applications/{deb.PACKAGE}.desktop"] == 0o644
    assert modes[f"usr/lib/udev/rules.d/60-{deb.PACKAGE}.rules"] == 0o644
    assert modes[f"usr/share/doc/{deb.PACKAGE}/copyright"] == 0o644

    icons = [path for path in modes if path.startswith("usr/share/icons/hicolor/")]
    assert len(icons) == len(list(ICON_DIR.glob("icon-*.png"))) > 0
    assert "usr/share/icons/hicolor/256x256/apps/litearm-studio.png" in modes


def test_stage_writes_a_control_file_and_an_md5sums_file(tmp_path):
    root, installed_kb = deb.stage(
        tmp_path / "root", _fake_binary(tmp_path), version="0.12.0", arch="amd64")

    control = (root / "DEBIAN" / "control").read_text(encoding="utf-8")
    assert "Installed-Size: " in control
    assert installed_kb == int(control.split("Installed-Size: ")[1].splitlines()[0])
    assert (root / "DEBIAN" / "postinst").stat().st_mode & 0o111
    assert (root / "DEBIAN" / "postrm").stat().st_mode & 0o111

    md5sums = (root / "DEBIAN" / "md5sums").read_text(encoding="utf-8")
    assert "usr/bin/litearm-studio" in md5sums
    assert "DEBIAN/control" not in md5sums


def test_payload_installs_the_whole_directory_when_the_build_is_onedir(tmp_path):
    """目录形态的产物整棵树都要装进去，而且落在**同一个**路径上。

    包是用目录形态装的（dpkg 本来就是装一棵树，代价为零，换来每次启动少解包 ~300 ms），
    所以这条盯三件事：树里的每个文件都在、可执行文件仍然落在
    `/usr/lib/<pkg>/<name>`（launcher、文档、udev 规则都指着那个路径），以及**每个文件
    带着自己的模式进包**（`deb.bundled_daemon` 照搬 `st_mode`，不按类型统一规范化）。
    """
    built = tmp_path / "litearm-studio-daemon"
    (built / "_internal" / "litearm_studio_daemon").mkdir(parents=True)
    exe = built / deb.BINARY_NAME
    exe.write_bytes(b"#!/bin/true\n")
    exe.chmod(0o755)
    bundle = built / "_internal" / "base_library.zip"
    bundle.write_bytes(b"zip")
    # ⚠ 显式 chmod: `write_bytes` 留下的是**运行者的 umask**, 而这条断言问的是
    #   "每个文件是不是带着自己的模式进的包"（见 `deb.bundled_daemon`），不是 umask 是
    #   多少。取 0o640 而不是 0o644 是刻意的: 那是"照搬源文件"与"统一规范化成 0o644"
    #   之间的分界线, 所以这条现在既与 umask 无关, 又真的能证伪一个规范化实现。
    bundle.chmod(0o640)
    (built / "_internal" / "litearm_studio_daemon" / "factory_calibration.json").write_bytes(b"{}")

    modes = {path.as_posix(): mode for path, _source, mode in deb.payload(built)}

    assert modes[f"usr/lib/{deb.PACKAGE}/{deb.BINARY_NAME}"] == 0o755
    assert modes[f"usr/lib/{deb.PACKAGE}/_internal/base_library.zip"] == 0o640
    assert (f"usr/lib/{deb.PACKAGE}/_internal/litearm_studio_daemon/"
            "factory_calibration.json") in modes
    # 目录**本身**不产生条目 —— dpkg 只记录文件，多出来的目录条目会让 md5sums 变脏。
    assert not [path for path in modes if path.endswith("_internal")]


def _onedir_with_one_theme_file(tmp_path: pathlib.Path) -> tuple:
    """一个最小目录形态产物：图标主题里一个真文件、一个指向它的别名链接。

    图标主题正是链接最多的地方（v0.22.2 的包里有 6036 条），所以这里照着它的形状造。
    """
    built = tmp_path / "litearm-studio-daemon"
    (built / "_internal" / "share" / "icons" / "Adwaita" / "22").mkdir(parents=True)
    (built / "_internal" / deb.BINARY_NAME).write_bytes(b"#!/bin/true\n")
    real = built / "_internal" / "share" / "icons" / "Adwaita" / "22" / "about.svg"
    real.write_bytes(b"<svg>about</svg>" * 8000)  # ~120 KB：够大到"少复制一份"看得见
    alias = built / "_internal" / "share" / "icons" / "Adwaita" / "16"
    alias.mkdir(parents=True)
    (alias / "about.svg").symlink_to(os.path.relpath(real, alias))
    return built, real, alias / "about.svg"


def test_a_symlink_in_the_bundle_is_installed_as_a_symlink(tmp_path):
    """目录形态里的符号链接要原样装成链接，而不是把它指向的内容再复制一份。

    ⚠ 这条是实测出来的教训：图标主题里 6036 项是**别名链接**，而 `shutil.copyfile`
    跟着链接走、`is_file()` 也说"是文件"，于是 22.7 MB 的真实主题文件在 `.deb` 里变成
    71.0 MB 的副本 —— v0.22.2 的安装体积里 48 MB 是这么白来的。
    """
    built, real, alias = _onedir_with_one_theme_file(tmp_path)
    entries = {path: source for path, source, _mode in deb.payload(built)}
    root = pathlib.Path(f"usr/lib/{deb.PACKAGE}/_internal/share/icons/Adwaita")

    assert isinstance(entries[root / "16" / "about.svg"], deb.Symlink)
    assert entries[root / "16" / "about.svg"].target == os.readlink(alias)
    # 链接文本是相对的、目录形状又一样，所以装好之后它指回的是同一棵树里的那份。
    assert entries[root / "22" / "about.svg"] == real


def test_stage_keeps_the_link_and_does_not_pay_for_it_twice(tmp_path):
    """staged 出来的是真链接，md5sums 不列它，Installed-Size 也不重复计它。

    `du`（也就是 `Installed-Size` 的口径）对链接只算它自己那几十个字节，目标是算在
    它真正所在的路径上的 —— 这里用"加不加这条别名，体积一样"来钉住。
    """
    built, real, alias = _onedir_with_one_theme_file(tmp_path)
    root, installed_kb = deb.stage(
        tmp_path / "root", built, version="0.12.0", arch="amd64")

    staged_dir = root / f"usr/lib/{deb.PACKAGE}/_internal/share/icons/Adwaita"
    staged_alias = staged_dir / "16" / "about.svg"
    assert staged_alias.is_symlink()
    assert os.readlink(staged_alias) == os.readlink(alias)
    # 链接在装好的树里指得回包内那份（不是断链），读出来的内容还是原来的。
    assert staged_alias.resolve() == (staged_dir / "22" / "about.svg").resolve()
    assert staged_alias.read_bytes().startswith(b"<svg>about</svg>")
    # 真文件照旧是普通文件，而且还有执行位之外的原始权限。
    assert not (staged_dir / "22" / "about.svg").is_symlink()

    md5sums = (root / "DEBIAN" / "md5sums").read_text(encoding="utf-8")
    assert "Adwaita/22/about.svg" in md5sums
    # debhelper 的规矩：链接不进 md5sums（`dpkg --verify` 只校验列出来的东西）。
    assert "Adwaita/16/about.svg" not in md5sums

    # 少了链接的那一份复制，体积应该一样（差值只有链接文本那几十字节）。
    built_without = tmp_path / "solo"
    shutil.copytree(built, built_without, symlinks=True)
    (built_without / "_internal/share/icons/Adwaita/16/about.svg").unlink()
    _root, without_kb = deb.stage(
        tmp_path / "root2", built_without, version="0.12.0", arch="amd64")
    assert installed_kb - without_kb <= 1, "别名链接被当成一整份副本计进去了"


def test_a_link_that_leaves_the_bundle_is_copied_and_a_dangling_one_is_skipped(tmp_path):
    """包外的链接与断链都不该留成链接：前者装到目标机上还是包外（靠不住），后者是断链。

    两种情况都退回原来的行为——能读到内容就复制内容，读不到就跳过（与改之前一致）。
    """
    built = tmp_path / "litearm-studio-daemon"
    icons = built / "_internal" / "share" / "icons" / "Adwaita"
    icons.mkdir(parents=True)
    (built / "_internal" / deb.BINARY_NAME).write_bytes(b"#!/bin/true\n")

    outside = tmp_path / "elsewhere.svg"
    outside.write_bytes(b"<svg>outside</svg>")
    (icons / "borrowed.svg").symlink_to(outside)
    (icons / "broken.svg").symlink_to("nowhere.svg")

    entries = {path.as_posix(): source for path, source, _mode in deb.payload(built)}
    staged = f"usr/lib/{deb.PACKAGE}/_internal/share/icons/Adwaita"

    # 包外那条退回"复制内容"——装到目标机上以后它必须是真文件，不能还是一个指向包外的链接。
    assert not isinstance(entries[f"{staged}/borrowed.svg"], deb.Symlink)
    assert f"{staged}/broken.svg" not in entries            # 断链照旧跳过（与改之前一致）

    root, _kb = deb.stage(tmp_path / "root", built, version="0.12.0", arch="amd64")
    borrowed = root / staged / "borrowed.svg"
    assert not borrowed.is_symlink()
    assert borrowed.read_bytes() == b"<svg>outside</svg>"


# ------------------------------------------------------------------ the real thing


@needs_dpkg
def test_builds_a_debian_package_with_the_expected_layout(tmp_path):
    out = tmp_path / "out"
    assert deb.main([
        "--binary", str(_fake_binary(tmp_path)),
        "--version", "v0.12.0",
        "--arch", "amd64",
        "--outdir", str(out),
        "--work", str(tmp_path / "work"),
    ]) == 0

    package = out / "litearm-studio_0.12.0_amd64.deb"
    assert package.is_file()

    def dpkg_deb(*args: str) -> str:
        return subprocess.run(["dpkg-deb", *args, str(package)],
                              capture_output=True, text=True, check=True).stdout

    fields = dpkg_deb("--field")
    assert "Package: litearm-studio" in fields
    assert "Version: 0.12.0" in fields
    assert "Architecture: amd64" in fields
    assert f"Depends: libc6 (>= {deb.GLIBC_FLOOR})" in fields

    listing = dpkg_deb("--contents")
    for expected in (
        "/usr/bin/litearm-studio",
        f"/usr/lib/litearm-studio/{deb.BINARY_NAME}",
        "/usr/share/applications/litearm-studio.desktop",
        "/usr/lib/udev/rules.d/60-litearm-studio.rules",
        "/usr/share/icons/hicolor/256x256/apps/litearm-studio.png",
        "/usr/share/doc/litearm-studio/copyright",
    ):
        assert expected in listing

    extract = tmp_path / "extract"
    subprocess.run(["dpkg-deb", "--extract", str(package), str(extract)], check=True)
    rule = (extract / "usr/lib/udev/rules.d/60-litearm-studio.rules").read_text(encoding="utf-8")
    assert 'TAG+="uaccess"' in rule
    launcher = extract / "usr/bin/litearm-studio"
    assert launcher.stat().st_mode & 0o111
    assert f"/usr/lib/litearm-studio/{deb.BINARY_NAME}" in launcher.read_text(encoding="utf-8")


# ------------------------------------------------- the window-backend variable (#188)


def test_the_window_backend_is_normalised_the_way_build_py_normalises_it(monkeypatch):
    """One variable drives the frozen bundle **and** the package's `Depends`.

    `build.py` strips and lower-cases it; this side has to agree. `=GTK` used to slip
    through here (argparse applies `choices` only to a supplied value, never to a
    `default`), so a GTK bundle shipped in a package that omitted `gir1.2-webkit2-4.1` —
    it installs, starts, and dies with no usable webview backend.
    """
    monkeypatch.setenv(deb.WINDOW_BACKEND_ENV, "  GTK  ")
    assert deb.window_backend_from_env() == "gtk"
    assert deb.WEBKIT_DEPENDS in deb.depends_for(deb.window_backend_from_env())


@pytest.mark.parametrize("value", ["gtk", "qt", "native"])
def test_every_value_build_py_accepts_is_accepted_here(monkeypatch, value):
    monkeypatch.setenv(deb.WINDOW_BACKEND_ENV, value)
    assert deb.window_backend_from_env() == value


def test_an_unset_variable_is_the_documented_default(monkeypatch):
    monkeypatch.delenv(deb.WINDOW_BACKEND_ENV, raising=False)
    assert deb.window_backend_from_env() == deb.DEFAULT_WINDOW_BACKEND == "gtk"


def test_an_unknown_window_backend_fails_the_way_it_does_in_build_py(monkeypatch):
    monkeypatch.setenv(deb.WINDOW_BACKEND_ENV, "gtk2")
    with pytest.raises(SystemExit):
        deb.window_backend_from_env()


def test_the_parser_leaves_the_environment_alone_until_it_is_asked(monkeypatch):
    """`--help` must not die on a bad environment, and `main()` must still refuse it.

    Reading the environment as the argument's `default=` would evaluate it while the
    parser is being built — and would keep argparse's `choices` out of the decision.
    """
    monkeypatch.setenv(deb.WINDOW_BACKEND_ENV, "bogus")
    assert deb.build_parser().parse_args([]).window_backend is None
    with pytest.raises(SystemExit):
        deb.window_backend_from_env()


# ----------------------------------------------------------- icons and doc files (#193)


def test_a_missing_icon_set_fails_the_build(monkeypatch, tmp_path):
    """A package with no icons still installs and runs — the only symptom is a blank icon
    in the menu and the dock, which no test and no headless build can see."""
    empty = tmp_path / "icon-png"
    empty.mkdir()
    monkeypatch.setattr(deb, "ICON_DIR", empty)
    with pytest.raises(SystemExit, match="no icons"):
        deb.payload(_fake_binary(tmp_path))


def test_an_icon_without_a_size_fails_the_build(monkeypatch, tmp_path):
    icons = tmp_path / "icon-png"
    icons.mkdir()
    (icons / "icon-final.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    monkeypatch.setattr(deb, "ICON_DIR", icons)
    with pytest.raises(SystemExit, match="does not carry its size"):
        deb.payload(_fake_binary(tmp_path))


def test_the_package_ships_a_debian_changelog(tmp_path):
    entries = {path.as_posix() for path, _source, _mode in deb.payload(_fake_binary(tmp_path))}
    assert f"usr/share/doc/{deb.PACKAGE}/changelog.Debian.gz" in entries


def test_the_changelog_is_one_debian_can_parse(monkeypatch, tmp_path):
    """lintian wants the file; `dpkg-parsechangelog` is the check that it is a changelog."""
    parser = shutil.which("dpkg-parsechangelog")
    if parser is None:
        pytest.skip("dpkg-parsechangelog is not installed")
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1700000000")
    path = tmp_path / "changelog.Debian"
    path.write_bytes(gzip.decompress(deb.changelog_debian("1.2.3")))
    fields = subprocess.run([parser, "-l", str(path)], capture_output=True, text=True,
                            check=True).stdout
    assert "Version: 1.2.3" in fields
    assert deb.MAINTAINER in fields


def test_the_changelog_is_reproducible(monkeypatch):
    """Same tree, same bytes: the gzip mtime is pinned and the date comes from
    `SOURCE_DATE_EPOCH`."""
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1700000000")
    assert deb.changelog_debian("1.2.3") == deb.changelog_debian("1.2.3")
