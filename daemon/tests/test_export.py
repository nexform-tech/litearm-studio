"""`POST /api/export` —— 导出文件的落点与它如实回答的四件事。

这一条接口是 issue #104 / #100 的落点: 页面够不到窗口宿主, 只能把字节交回来, 由持有
窗口的这一侧弹保存对话框、写文件、回答"存到哪 / 取消了 / 没窗口 / 存失败"。所以这里
钉的是**四种回答各自成立**, 以及两个不该被绕过的判据 (名字与同源)。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from litearm_studio_daemon import server
from litearm_studio_daemon.server import create_app, export_filename
from litearm_studio_daemon.session import Session

VERSION = "9.9.9-test"


def _client(save_path=None, **kwargs):
    session = Session(port_finder=lambda: None)
    app = create_app(session, version=VERSION, repo_dist=Path("/nonexistent-ui"),
                     save_path=save_path, **kwargs)
    return TestClient(app)


def test_export_writes_the_bytes_where_the_dialog_said(tmp_path) -> None:
    """最要紧的一条: 字节落到操作员选定的那个路径上, 内容一个字节不差。"""
    offered: list[str] = []
    target = tmp_path / "litearm-logs-2026.jsonl"

    def save_path(name: str) -> str:
        offered.append(name)
        return str(target)

    response = _client(save_path).post("/api/export?name=litearm-logs-2026.jsonl",
                                       content=b'{"seq":1}\n{"seq":2}\n')

    assert response.status_code == 200
    assert response.json() == {"ok": True, "saved": True, "path": str(target)}
    assert target.read_bytes() == b'{"seq":1}\n{"seq":2}\n'
    assert offered == ["litearm-logs-2026.jsonl"]


def test_export_reports_a_cancelled_dialog_and_writes_nothing(tmp_path) -> None:
    """取消: 如实说取消, 磁盘上什么都不多出来 —— 页面据此一个字都不提示。"""
    response = _client(lambda name: None).post("/api/export?name=x.jsonl", content=b"data")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "saved": False, "reason": "cancelled"}
    assert list(tmp_path.iterdir()) == []


def test_export_points_a_windowless_daemon_back_at_the_browser() -> None:
    """无界面运行 (`--no-open`): 没有对话框可弹, 页面据此回退到浏览器下载。

    这不是失败 —— 台架/服务端就是这么用的, 把"没窗口"说成"存失败"会让页面弹一条假错误。
    """
    response = _client(None).post("/api/export?name=x.csv", content=b"a,b\n")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "saved": False, "reason": "no-window"}


def test_export_reports_a_failed_write_instead_of_pretending(tmp_path) -> None:
    """对话框给了路径但写不进去 (磁盘满/没权限): 如实回错误, 不假装存好了。"""
    missing = tmp_path / "gone" / "x.jsonl"
    response = _client(lambda name: str(missing)).post("/api/export?name=x.jsonl",
                                                       content=b"data")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["error"] == "write-failed"
    assert body["detail"]


def test_export_never_lets_the_page_choose_the_path(tmp_path) -> None:
    """页面给的名字只进对话框的预填框: 带路径的名字被收成纯文件名, 存到哪仍由操作员定。"""
    offered: list[str] = []
    target = tmp_path / "passwd"
    client = _client(lambda name: offered.append(name) or str(target))

    response = client.post("/api/export?name=../../etc/passwd", content=b"data")

    assert response.status_code == 200
    assert response.json()["path"] == str(target)
    assert offered == ["passwd"]


def test_export_rejects_a_name_that_is_not_a_name(tmp_path) -> None:
    """收不出文件名的请求是坏请求 —— 400 说清楚, 不去弹一个没有名字的对话框。"""
    called: list[str] = []
    client = _client(lambda name: called.append(name) or str(tmp_path / "x"))

    response = client.post("/api/export?name=..", content=b"data")

    assert response.status_code == 400
    assert response.json()["error"] == "bad-name"
    assert called == []


def test_export_refuses_another_origin() -> None:
    """别的网页不该能把保存对话框弹到操作员脸上 (与 `/ws` 同一套同源判据)。"""
    response = _client(lambda name: "/tmp/x").post(
        "/api/export?name=x.jsonl", content=b"data",
        headers={"Origin": "http://evil.example"})

    assert response.status_code == 403
    assert response.json()["error"] == "cross-origin"


def test_export_refuses_a_body_over_the_cap(monkeypatch) -> None:
    """这份字节写盘前要整个待在内存里, 所以有一条明确的拒绝线。"""
    monkeypatch.setattr(server, "MAX_EXPORT_BYTES", 8)
    response = _client(lambda name: "/tmp/x").post("/api/export?name=x.jsonl",
                                                   content=b"0123456789")

    assert response.status_code == 413
    assert response.json()["error"] == "too-large"


@pytest.mark.parametrize("suggested, expected", [
    ("litearm-logs-2026.jsonl", "litearm-logs-2026.jsonl"),
    ("../../etc/passwd", "passwd"),
    ("..\\..\\windows\\system32\\evil.csv", "evil.csv"),
    ("/absolute/path.jsonl", "path.jsonl"),
    ("  spaced.jsonl  ", "spaced.jsonl"),
    ("", ""),
    ("..", ""),
    ("a" * 200 + ".jsonl", ("a" * 200 + ".jsonl")[:120]),
])
def test_export_filename_keeps_a_name_and_nothing_else(suggested, expected) -> None:
    assert export_filename(suggested) == expected


def test_export_filename_drops_control_characters() -> None:
    """控制字符会让对话框与文件系统各自理解出不同的名字。"""
    assert export_filename("litearm\n-logs\x00.jsonl") == "litearm-logs.jsonl"
