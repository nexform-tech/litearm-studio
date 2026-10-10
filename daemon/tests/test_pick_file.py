"""`POST /api/pick-file` —— 选标定文件的落点与它如实回答的三件事。

与 `POST /api/export` (见 `test_export.py`) 同一套路, 只是换了个方向: 设置页的"浏览…"
要的是一份**控制机上已经存在**的 `*.json` 的主机路径, 而页面跑在 webview 里给不出这个
路径。所以由持有窗口的这一侧弹原生打开对话框, 页面只拿回一个路径。这里钉的是**三种回答
各自成立** (挑中了 / 取消了 / 没窗口), 以及同源判据不被绕过。
"""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from litearm_studio_daemon import server
from litearm_studio_daemon.server import create_app
from litearm_studio_daemon.session import Session

VERSION = "9.9.9-test"


def _client(pick_path=None, **kwargs):
    session = Session(port_finder=lambda: None)
    app = create_app(session, version=VERSION, repo_dist=Path("/nonexistent-ui"),
                     pick_path=pick_path, **kwargs)
    return TestClient(app)


def test_pick_file_answers_with_the_path_the_dialog_chose(tmp_path) -> None:
    """最要紧的一条: 操作员挑中的那个路径原样回到页面, 起始目录也传给了对话框。"""
    asked: list = []
    target = tmp_path / "can0_calibration.json"

    def pick_path(initial_dir):
        asked.append(initial_dir)
        return str(target)

    response = _client(pick_path).post("/api/pick-file?dir=%2Fhome%2Fu%2F.litegrip")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "picked": True, "path": str(target)}
    assert asked == ["/home/u/.litegrip"]


def test_pick_file_passes_no_directory_when_the_page_gives_none(tmp_path) -> None:
    """页面没给起始目录 → 钩子收到 `None`, 对话框落回平台默认目录。"""
    asked: list = []

    def pick_path(initial_dir):
        asked.append(initial_dir)
        return str(tmp_path / "x.json")

    response = _client(pick_path).post("/api/pick-file")

    assert response.status_code == 200
    assert response.json()["picked"] is True
    assert asked == [None]


def test_pick_file_reports_a_cancelled_dialog() -> None:
    """取消: 如实说取消, 页面据此一个字都不提示。"""
    response = _client(lambda initial_dir: None).post("/api/pick-file")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "picked": False, "reason": "cancelled"}


def test_pick_file_points_a_windowless_daemon_back_at_the_page() -> None:
    """无界面运行 (`--no-open`): 没有对话框可弹, 页面据此如实告知选不了文件。

    这不是失败 —— 台架/服务端本就是无界面跑的, 把"没窗口"说成"失败"会让页面弹假错误。
    """
    response = _client(None).post("/api/pick-file")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "picked": False, "reason": "no-window"}


def test_pick_file_accepts_the_page_that_lives_on_this_daemon(tmp_path) -> None:
    """页面自己那一发请求带着 Origin —— 同源就放行, 否则生产里"浏览…"全都会被 403。"""
    response = _client(lambda initial_dir: str(tmp_path / "x.json")).post(
        "/api/pick-file",
        headers={"Origin": "http://127.0.0.1:8765", "Host": "127.0.0.1:8765"})

    assert response.status_code == 200
    assert response.json()["picked"] is True


def test_pick_file_refuses_another_origin() -> None:
    """别的网页不该能把我们的打开对话框弹到操作员脸上 (与 `/ws`、`/api/export` 同一套判据)。"""
    response = _client(lambda initial_dir: "/tmp/x.json").post(
        "/api/pick-file", headers={"Origin": "http://evil.example"})

    assert response.status_code == 403
    assert response.json()["error"] == "cross-origin"


# ── 接线: "没有窗口" 与 "操作员取消了" 不是同一件事 ─────────────────────────

def test_a_windowless_process_has_no_picker_hook_at_all() -> None:
    """⚠ 无界面运行时钩子必须是 `None`, 不能是一个恒返回 `None` 的闭包。

    后者会被接口读成 `cancelled`, 页面便什么都不说 —— 操作员按了"浏览…"却毫无反应。
    """
    assert server._open_picker([], window=False) is None


def test_a_windowed_process_asks_the_window_that_exists() -> None:
    """有窗口时问窗口: 拿到路径就回路径 (起始目录透传), 还没建好/已关掉则回 `None`。"""
    seen: list = []

    class _Handle:
        def ask_open_path(self, initial_dir):
            seen.append(initial_dir)
            return "/tmp/can0.json"

    pick = server._open_picker([_Handle()], window=True)
    assert pick is not None and pick("/home/u") == "/tmp/can0.json"
    assert seen == ["/home/u"]
    assert server._open_picker([], window=True)("/home/u") is None
