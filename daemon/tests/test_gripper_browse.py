"""``gripper.list_dir`` —— 控制机的目录列举，供设置页的标定选择器用。

纯函数层，根目录可注入（``home=``），所以整棵树都建在 ``tmp_path`` 上，不碰运行
测试那台机器的家目录。钉的是：列什么、怎么排序、每个 ``*.json`` 怎么复用
``inspect_file`` 的校验结果并把它平铺成浏览选标定用的行，以及哪些输入该被拒绝。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from conftest import MEASURED_CALIBRATION
from litearm_studio_daemon.errors import GripperBrowseError
from litearm_studio_daemon.gripper import calibration
from litearm_studio_daemon.gripper.browse import list_dir


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A private ``$HOME``，好把 ``~`` 与相对路径的展开钉在这里。"""
    root = tmp_path / "home"
    root.mkdir()
    monkeypatch.setenv("HOME", str(root))
    monkeypatch.delenv(calibration.CALIB_ENV, raising=False)
    return root


def _write(path: Path, payload: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _rows(home: Path, **kwargs: Any) -> dict[str, dict]:
    listed = list_dir(str(home), home=home, **kwargs)
    return {e["name"]: e for e in listed["entries"]}


# ── 列什么、怎么排 ──────────────────────────────────────────────────────────

def test_only_directories_and_json_files_are_listed_dirs_first(home: Path) -> None:
    (home / "zeta").mkdir()
    (home / "Alpha").mkdir()
    (home / ".hidden").mkdir()               # 点开头照列：~/.litegrip 就是点目录
    _write(home / "b_cal.json", MEASURED_CALIBRATION)
    _write(home / "A_cal.json", MEASURED_CALIBRATION)
    _write(home / ".dot.json", MEASURED_CALIBRATION)
    _write(home / "broken.json", {})
    (home / "README.txt").write_text("不是标定文件", encoding="utf-8")

    entries = list_dir(str(home), home=home)["entries"]
    names = [e["name"] for e in entries]
    # 目录在前、文件在后，各组内按大小写不敏感的字典序。
    assert names == [".hidden", "Alpha", "zeta",
                     ".dot.json", "A_cal.json", "b_cal.json", "broken.json"]
    assert [e["type"] for e in entries] == ["dir"] * 3 + ["file"] * 4
    # 非 *.json 的普通文件不属于这个选择器。
    assert "README.txt" not in names


def test_the_json_suffix_is_case_insensitive(home: Path) -> None:
    _write(home / "upper.JSON", MEASURED_CALIBRATION)
    assert [e["name"] for e in list_dir(str(home), home=home)["entries"]] == ["upper.JSON"]


def test_a_directory_named_like_a_calibration_is_still_a_directory(home: Path) -> None:
    """先判 ``is_dir()``，所以名叫 ``x.json`` 的目录可进入，永不被当成文件读。"""
    (home / "x.json").mkdir()
    row = _rows(home)["x.json"]
    assert row["type"] == "dir" and "valid" not in row


# ── 每个 *.json 复用 inspect_file 的结论 ───────────────────────────────────

def test_a_valid_calibration_carries_a_browse_row(home: Path) -> None:
    path = _write(home / "ok.json", MEASURED_CALIBRATION)

    row = _rows(home, channel="can0")["ok.json"]

    # 行 = 文件元数据 + candidate_dict 的全部字段，逐字节相同 —— 前端只有一个行渲染器。
    expected = calibration.candidate_dict(
        calibration.inspect_file(path, channel="can0"), "can0")
    assert {k: row[k] for k in expected} == expected
    assert row["valid"] is True and row["provenance"] == "user_file"
    assert row["source"] == "measured" and row["mount"] == "normal"
    assert row["type"] == "file" and row["name"] == "ok.json"
    assert row["path"] == str(path)
    assert isinstance(row["size"], int) and row["mtime"] > 0


def test_a_malformed_json_is_listed_with_its_problems(home: Path) -> None:
    _write(home / "bad.json", {})

    row = _rows(home)["bad.json"]

    assert row["type"] == "file" and row["valid"] is False
    assert row["problems"]                       # 不是空手：操作员看得到为什么不行
    assert row["closedRad"] is None and row["openRad"] is None


def test_an_oversize_json_is_listed_but_not_inspected(home: Path) -> None:
    """超限不读文件（读它会耗过命令超时），但照样给一行，说清为什么没校验。"""
    (home / "big.json").write_text("x" * 200, encoding="utf-8")

    row = _rows(home, max_inspect_bytes=10)["big.json"]

    assert row["valid"] is False
    assert any("字节" in p for p in row["problems"])


def test_an_unreadable_json_becomes_an_invalid_row(home: Path) -> None:
    if os.geteuid() == 0:                     # pragma: no cover - root 无视权限位
        pytest.skip("root 无视权限位")
    path = _write(home / "secret.json", MEASURED_CALIBRATION)
    os.chmod(path, 0o000)
    try:
        row = _rows(home)["secret.json"]
        assert row["readable"] is False and row["valid"] is False
        assert any("无法读取" in p for p in row["problems"])
    finally:
        os.chmod(path, 0o600)


# ── 起点的解析 ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("given", [None, "", "   "])
def test_no_path_means_the_home_directory(home: Path, given: object) -> None:
    assert list_dir(given, home=home)["path"] == str(home)


def test_a_tilde_and_a_relative_path_resolve_against_the_home(home: Path) -> None:
    (home / "sub").mkdir()
    assert list_dir("~", home=home)["path"] == str(home)
    assert list_dir("~/sub", home=home)["path"] == str(home / "sub")
    # 相对路径按家目录展开，不相对进程 CWD（CWD 未定义，是个坑）。
    assert list_dir("sub", home=home)["path"] == str(home / "sub")


def test_a_file_or_a_missing_path_is_refused(home: Path) -> None:
    path = _write(home / "ok.json", MEASURED_CALIBRATION)
    with pytest.raises(GripperBrowseError):
        list_dir(str(path), home=home)
    with pytest.raises(GripperBrowseError):
        list_dir(str(home / "nope"), home=home)


def test_parent_walks_up_and_stops_at_the_filesystem_root(
        home: Path, tmp_path: Path) -> None:
    nested = home / "a" / "b"
    nested.mkdir(parents=True)
    assert list_dir(str(nested), home=home)["parent"] == str(home / "a")

    root = Path(os.sep)
    try:
        listed = list_dir(str(root), home=home)
    except GripperBrowseError:                # pragma: no cover - 没有可列举的根
        pytest.skip("根目录不可列举")
    assert listed["path"] == str(root) and listed["parent"] is None


# ── 边界 ────────────────────────────────────────────────────────────────────

def test_the_listing_is_capped_and_says_so(home: Path) -> None:
    for i in range(5):
        (home / f"d{i}").mkdir()

    capped = list_dir(str(home), home=home, max_entries=3)
    assert capped["truncated"] is True and len(capped["entries"]) == 3

    whole = list_dir(str(home), home=home)
    assert whole["truncated"] is False and len(whole["entries"]) == 5


def test_an_unreadable_directory_is_listed_but_greyed(home: Path) -> None:
    if os.geteuid() == 0:                     # pragma: no cover - root 无视权限位
        pytest.skip("root 无视权限位")
    locked = home / "locked"
    locked.mkdir()
    os.chmod(locked, 0o000)
    try:
        row = _rows(home)["locked"]
        assert row["type"] == "dir" and row["readable"] is False
    finally:
        os.chmod(locked, 0o700)


def test_symlinks_are_followed_for_classification_and_marked(
        home: Path, tmp_path: Path) -> None:
    real_dir = tmp_path / "real_dir"
    real_dir.mkdir()
    _write(tmp_path / "real.json", MEASURED_CALIBRATION)
    os.symlink(real_dir, home / "link_dir")
    os.symlink(tmp_path / "real.json", home / "link.json")
    os.symlink(tmp_path / "gone.json", home / "dead.json")   # 断链

    rows = _rows(home)

    assert rows["link_dir"]["type"] == "dir" and rows["link_dir"]["symlink"] is True
    assert rows["link.json"]["type"] == "file" and rows["link.json"]["symlink"] is True
    # 断链既非目录也非常规文件，不收 —— 单层列举也不会成环。
    assert "dead.json" not in rows
