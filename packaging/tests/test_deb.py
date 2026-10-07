"""Tests for `packaging/deb.py`, the builder of the Debian package for Ubuntu users.

The module is loaded by path instead of imported: its directory is called `packaging`,
which would shadow the PyPI package of the same name inside the test session. The last
test builds a real `.deb` with `dpkg-deb`, which is why it is skipped off Debian/Ubuntu.
"""
from __future__ import annotations

import importlib.util
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


def test_control_declares_the_glibc_floor():
    assert deb.GLIBC_FLOOR == "2.35"
    assert f"Depends: libc6 (>= {deb.GLIBC_FLOOR})" in _control()


def test_control_never_pulls_a_browser_in():
    # Any browser works and the program degrades to a normal tab, so a browser must never
    # be a dependency: `Recommends` would install a second browser by default on a
    # workstation that already has one.
    depends = [line for line in _control().splitlines() if line.startswith("Depends:")]
    assert depends == [f"Depends: libc6 (>= {deb.GLIBC_FLOOR})"]
    assert "Suggests:" in _control()


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


def test_launcher_is_a_wrapper_around_the_bundled_executable():
    script = deb.launcher_script()
    assert script.startswith("#!/bin/sh\n")
    assert f'exec {deb.INSTALL_DIR}/{deb.BINARY_NAME} "$@"' in script


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
