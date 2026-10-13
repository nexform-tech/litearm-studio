"""`fatal` 的两条出路: 接回父控制台、没有控制台时弹对话框。

为什么值得单测: 这两条**只在冻结的 Windows 产物里**起作用 (GUI 子系统的 exe, `sys.stdout`
与 `sys.stderr` 都是 `None`), 而那正是谁也没法随手跑一遍的形态 —— 单测是唯一能在 Linux
CI 上钉住它们的地方。这与 `window._on_ui_thread` (同一类平台分支) 用的是同一条理由:
在 Linux 上把 `sys.platform` 换成 `win32` 再喂一个假的 `ctypes`, 走的就是 Windows 那条路。

⚠ 这里替换的是 `sys.modules["ctypes"]`, 不是 `fatal` 的模块属性: `fatal` 是在**函数里**
`import ctypes` 的 (那样在没装 ctypes 的怪异环境里也起得来), 所以只有模块表是它的入口。
"""
from __future__ import annotations

import builtins
import io
import json
import subprocess
import sys
import time
import types
import urllib.request
from pathlib import Path
from typing import Any, List, Optional, Tuple

import pytest

from litearm_studio_daemon import fatal, obs, window
from litearm_studio_daemon.server import pick_free_http_port


def _fake_ctypes(monkeypatch, *, attached: bool = True,
                 raise_on_box: bool = False) -> List[Tuple[Any, ...]]:
    """把 `ctypes` 换成一个假的 Win32 —— 返回所有调用, 供断言。

    `AttachConsole` 与 `MessageBoxW` 是这两条路各自唯一真正碰系统的调用, 所以只需要它们。
    """
    calls: List[Tuple[Any, ...]] = []

    def attach_console(flag: int) -> int:
        calls.append(("AttachConsole", flag))
        return 1 if attached else 0

    def message_box(hwnd: Any, text: str, title: str, flags: int) -> int:
        if raise_on_box:
            raise OSError("没有桌面会话")
        calls.append(("MessageBoxW", hwnd, text, title, flags))
        return 1

    kernel32 = types.SimpleNamespace(AttachConsole=attach_console)
    user32 = types.SimpleNamespace(MessageBoxW=message_box)
    monkeypatch.setitem(sys.modules, "ctypes",
                        types.SimpleNamespace(windll=types.SimpleNamespace(
                            kernel32=kernel32, user32=user32)))
    return calls


def _frozen_windows(monkeypatch) -> None:
    monkeypatch.setattr(fatal.sys, "platform", "win32")
    monkeypatch.setattr(fatal.sys, "frozen", True, raising=False)


@pytest.fixture(autouse=True)
def isolated_streams(monkeypatch) -> None:
    """`ensure_streams` 动的是**进程级**的东西: 两个流, 加一个模块级的落点。

    每个用例都要原样还回去 —— 否则第一个装过落点的用例会让后面每一个都活在"stderr 没人
    看得见"里, 而那些断言本来是在测自己布置的前提。`setattr` 到当前值上是让 monkeypatch
    记下旧值再还回来, 因为代码要改的就是它。
    """
    monkeypatch.setattr(fatal, "_sink", None)
    monkeypatch.setattr(fatal.sys, "stdout", fatal.sys.stdout)
    monkeypatch.setattr(fatal.sys, "stderr", fatal.sys.stderr)


# ------------------------------------------------------ 接回父控制台 (从终端启动)

def test_a_source_run_leaves_the_streams_alone(monkeypatch) -> None:
    """源码直跑的管道不能被接管。

    `--log-stdout | jq` 正是靠这两个流是管道才成立的; 把 `CONOUT$` 重开上去, 输出就从
    管道理到了控制台, 那边只剩一个空输入。
    """
    monkeypatch.setattr(fatal.sys, "platform", "win32")
    monkeypatch.delattr(fatal.sys, "frozen", raising=False)
    calls = _fake_ctypes(monkeypatch)

    assert fatal.attach_parent_console() is False
    assert calls == []


def test_off_windows_there_is_nothing_to_attach_to(monkeypatch) -> None:
    """判据是平台, 不是"有没有 frozen" —— Linux 上 `AttachConsole` 根本不存在。"""
    monkeypatch.setattr(fatal.sys, "platform", "linux")
    monkeypatch.setattr(fatal.sys, "frozen", True, raising=False)

    assert fatal.attach_parent_console() is False


def test_a_frozen_windows_build_rewires_both_streams(monkeypatch) -> None:
    """接上了就把两个流都换成新的控制台。

    两个都换是重点: `--log-stdout` 写 stderr, 而 `print` 与 uvicorn 走 stdout, 只接一半
    的话"看不到输出"会变成"看不到一半输出"。
    """
    _frozen_windows(monkeypatch)
    monkeypatch.setattr(fatal.sys, "stdout", None)
    monkeypatch.setattr(fatal.sys, "stderr", None)
    calls = _fake_ctypes(monkeypatch, attached=True)
    opened: List[Tuple[str, dict]] = []
    monkeypatch.setattr(builtins, "open",
                        lambda name, *a, **k: opened.append((name, k)) or io.StringIO())

    assert fatal.attach_parent_console() is True
    assert isinstance(sys.stdout, io.StringIO)
    assert isinstance(sys.stderr, io.StringIO)

    assert calls == [("AttachConsole", -1)]  # ATTACH_PARENT_PROCESS
    assert [name for name, _ in opened] == ["CONOUT$", "CONOUT$"]
    # 行缓冲: 控制台另一端是人, 卡在缓冲区里等于没打出来。
    assert all(kwargs.get("buffering") == 1 for _, kwargs in opened)


def test_a_stream_with_a_destination_of_its_own_is_left_alone(monkeypatch) -> None:
    """命令行给的落点 (`> log.txt`) 不能被抢走。

    抢走的样子很隐蔽: 文件明明建出来了却是空的, 而人以为刚才那次输出记下来了 ——
    这正是"报错机制把人误导到别处"那一类, 比不报还坏。
    """
    _frozen_windows(monkeypatch)
    redirected = io.StringIO()
    monkeypatch.setattr(fatal.sys, "stdout", redirected)
    monkeypatch.setattr(fatal.sys, "stderr", None)
    _fake_ctypes(monkeypatch)
    opened: List[str] = []
    monkeypatch.setattr(builtins, "open",
                        lambda name, *a, **k: opened.append(name) or io.StringIO())

    assert fatal.attach_parent_console() is True
    assert sys.stdout is redirected, "有去处的那个流被换掉了"
    assert isinstance(sys.stderr, io.StringIO), "缺的那个没补上"
    assert opened == ["CONOUT$"]


def test_both_streams_present_means_nothing_to_attach(monkeypatch) -> None:
    """两个流都有去处时连 `AttachConsole` 都不调 —— 没什么可接的。"""
    _frozen_windows(monkeypatch)
    calls = _fake_ctypes(monkeypatch)

    assert fatal.attach_parent_console() is False
    assert calls == []


def test_no_parent_console_means_nothing_happens(monkeypatch) -> None:
    """双击启动 (Explorer) 时没有父控制台 —— 这里必须什么都不做, 而不是报错。

    这是**最常见的那条路**: 双击之后若在这里抛异常, 每个用户都会中招。
    """
    _frozen_windows(monkeypatch)
    monkeypatch.setattr(fatal.sys, "stdout", None)
    monkeypatch.setattr(fatal.sys, "stderr", None)
    calls = _fake_ctypes(monkeypatch, attached=False)

    assert fatal.attach_parent_console() is False
    assert sys.stdout is None and sys.stderr is None, "接不上时不该动它们"
    assert calls == [("AttachConsole", -1)]


def test_a_broken_windll_is_not_a_startup_failure(monkeypatch) -> None:
    """`ctypes` 本身出问题也只算"这次看不到输出"。

    报错机制自己炸掉, 比"没报"更难查 —— 而调用点在启动路径上, 那里没有东西接得住它。
    """
    _frozen_windows(monkeypatch)
    monkeypatch.setitem(sys.modules, "ctypes", None)  # `import ctypes` 抛 ImportError

    assert fatal.attach_parent_console() is False


# ------------------------------------------------------ 两个流: 没有也得让它们存在

def test_real_streams_are_left_alone(monkeypatch) -> None:
    """源码直跑 / 接了终端时不该动它们 —— 换掉等于把输出丢进 `nul`。"""
    assert fatal.ensure_streams() is False
    assert fatal._sink is None


def test_a_missing_stream_gets_a_sink_that_looks_like_a_stream(monkeypatch) -> None:
    """`None` 换成 `os.devnull` —— 而且它得**像**一个流。

    ⚠ 踩过的坑就在这两个属性上: uvicorn 的 `DefaultFormatter.__init__` 要
    `sys.stdout.isatty()`, 而 `isatty` 返回 `False` 只是"不涂颜色", 返回
    `AttributeError` 是**程序起不来**。`fileno()` 同理: 有些库顺着它往下走, 一个真 fd
    才堵得住那条路, 假对象堵不住。
    """
    monkeypatch.setattr(fatal.sys, "stdout", None)
    monkeypatch.setattr(fatal.sys, "stderr", None)

    assert fatal.ensure_streams() is True
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        assert stream is not None
        assert stream.isatty() is False
        assert isinstance(stream.fileno(), int)
        stream.write(f"丢给 {name} 的东西不该炸\n")  # 不抛就是全部要求
        stream.flush()
    # 两个流是同一个落点就够了 —— 分开反而多一个 fd。
    assert sys.stdout is sys.stderr


def test_the_sink_is_not_mistaken_for_a_place_to_report(monkeypatch) -> None:
    """⚠ 装了落点之后, `show_fatal` **仍然必须弹对话框**。

    落点写得进去, 所以"能不能写"这条判据在它面前会给出 `True` —— 于是一句"窗口起不来"
    被写进 `nul`, 操作员那边什么都没有。这正是 `_sink` 存在的唯一理由。
    """
    monkeypatch.setattr(fatal.sys, "stdout", None)
    monkeypatch.setattr(fatal.sys, "stderr", None)
    monkeypatch.setattr(fatal.sys, "platform", "win32")
    calls = _fake_ctypes(monkeypatch)
    fatal.ensure_streams()

    assert fatal.show_fatal("没有可用的 webview 后端") is True

    assert [call[0] for call in calls] == ["MessageBoxW"]


# ------------------------------------------------------ 报错: 有控制台写日志, 没有则弹窗

def test_show_fatal_speaks_through_a_usable_stderr(capsys) -> None:
    """终端里跑的时候不要弹窗 —— 那只是打扰, 而且会挡住操作员正在看的输出。"""
    assert fatal.show_fatal("打不开应用窗口") is True

    assert "打不开应用窗口" in capsys.readouterr().err


def test_show_fatal_boxes_when_there_is_no_stderr(monkeypatch) -> None:
    """GUI 子系统的产物没有 stderr —— 对话框是唯一的出路, 而且必须抢前台。

    不抢前台的对话框藏在别的窗口后面, 而它要报的正是"窗口起不来": 那一刻它等于没报。
    """
    monkeypatch.setattr(fatal.sys, "platform", "win32")
    monkeypatch.setattr(fatal.sys, "stderr", None)
    calls = _fake_ctypes(monkeypatch)

    assert fatal.show_fatal("没有可用的 webview 后端") is True

    assert len(calls) == 1
    kind, hwnd, text, title, flags = calls[0]
    assert kind == "MessageBoxW"
    assert hwnd is None
    assert text == "没有可用的 webview 后端"
    assert title == window.APP_NAME
    assert flags & 0x00000010  # MB_ICONERROR
    assert flags & 0x00010000  # MB_SETFOREGROUND


def test_a_closed_stderr_counts_as_no_stderr(monkeypatch) -> None:
    """`is not None` 不够: 父进程退出后 stderr 还在, 但已经写不进去了。

    那时若继续往它写, 异常会从启动路径上冒出去 —— 于是"报不出错"变成"多一个错"。
    """
    class _Closed:
        def write(self, _: str) -> int:
            raise ValueError("I/O operation on closed file")

        def flush(self) -> None:
            raise ValueError("I/O operation on closed file")

    monkeypatch.setattr(fatal.sys, "platform", "win32")
    monkeypatch.setattr(fatal.sys, "stderr", _Closed())
    calls = _fake_ctypes(monkeypatch)

    assert fatal.show_fatal("端口被占用") is True
    assert calls[0][2] == "端口被占用"


def test_a_box_that_cannot_open_is_reported_not_raised(monkeypatch) -> None:
    """没有桌面会话时 `MessageBoxW` 会失败 —— 那也是"没送到", 不是异常。"""
    monkeypatch.setattr(fatal.sys, "platform", "win32")
    monkeypatch.setattr(fatal.sys, "stderr", None)
    _fake_ctypes(monkeypatch, raise_on_box=True)

    assert fatal.show_fatal("没有可用的 webview 后端") is False


# ------------------------------------------------------ 未捕获异常的兜底 (packaging/launcher.py)

def test_report_exception_names_the_error_and_the_full_record(monkeypatch) -> None:
    """对话框只放最后几行 traceback, 加上"完整记录在哪"。

    一屏放不下几百行, 而人先要读的是最后那条错误; 完整的那份在 `obs` 的 JSONL 文件里,
    所以这里必须把路径给出去, 否则操作员拿到的是一句读得懂但查不下去的话。
    """
    sent: List[str] = []
    monkeypatch.setattr(fatal, "show_fatal", lambda message: sent.append(message) or True)
    monkeypatch.setattr(obs, "log_path", lambda: "/tmp/litearm/daemon.jsonl")

    try:
        raise RuntimeError("窗口的后端起不来")
    except RuntimeError as exc:
        assert fatal.report_exception(exc) is True

    assert "窗口的后端起不来" in sent[0]
    assert "RuntimeError" in sent[0]
    assert "/tmp/litearm/daemon.jsonl" in sent[0]


def test_the_tail_keeps_the_last_lines_of_a_deep_traceback() -> None:
    """尾巴必须是**最后**几行 —— 那是错误与它出错的那一行所在的位置。"""

    def dive(depth: int) -> None:
        if depth:
            return dive(depth - 1)
        raise ValueError("到底了")

    try:
        dive(40)
    except ValueError as exc:
        lines = fatal._exception_lines(exc, keep=6)

    assert len(lines) == 6
    assert "到底了" in lines[-1]


def test_a_report_that_cannot_be_built_is_survivable(monkeypatch) -> None:
    """兜底里的兜底: 连 `traceback` 都取不到时, 也只能返回 False。"""
    monkeypatch.setattr(fatal, "_exception_lines",
                        lambda exc, keep=6: (_ for _ in ()).throw(RuntimeError("炸了")))

    assert fatal.report_exception(ValueError("原始错误")) is False


@pytest.mark.parametrize("path,expected", [(None, ""), ("", ""), ("/tmp/x.jsonl", "/tmp/x.jsonl")])
def test_the_log_hint_is_only_there_when_there_is_a_path(monkeypatch, path,
                                                        expected: str) -> None:
    """取不到路径就少一行, 而不是编一个路径出来 —— 对话框里不该有谎话。"""
    monkeypatch.setattr(obs, "log_path", lambda: path)

    hint = fatal._log_hint()

    assert (expected in hint) if expected else (hint == "")


# ------------------------------------------------------ 端到端: 没有任何流的产物照样要能起来

def _health_ok(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=0.3) as resp:
            return json.loads(resp.read()).get("ok") is True
    except Exception:  # noqa: BLE001 - 连不上就是"还没起来"
        return False


def test_the_daemon_serves_when_there_are_no_streams_at_all(tmp_path: Path) -> None:
    """GUI 子系统的产物里两个流都是 `None` —— 在那里程序必须照常起到能连。

    ⚠ **必须是端到端**, 在子进程里跑真的 `main()` (真的 uvicorn, 真的端口):

    * 单元测试里把 `serve` 换掉, 就正好绕过了踩过的那一脚 —— uvicorn 的
      `DefaultFormatter.__init__` 读 `sys.stdout.isatty()`, 它抛在 `serve()` **里面**
      配日志的时候, 而配日志之前的路径全是好的;
    * 两个流是进程级的: 在这个进程里设成 `None` 会把 pytest 自己的捕获一起改掉。

    子进程里 stdout / stderr 都是 `None`, 所以失败信息只能从日志文件里读 —— 而那份文件
    正是这一步要在没有控制台时仍然写下去的权威历史。
    """
    port = pick_free_http_port("127.0.0.1", start=18765, tries=50)
    code = (
        "import sys\n"
        "sys.stdout = None\n"
        "sys.stderr = None\n"
        "from litearm_studio_daemon.__main__ import main\n"
        f"raise SystemExit(main(['--fake', '--no-open', '--http-port', '{port}',\n"
        f"                       '--log-dir', r'{tmp_path}']))\n"
    )
    proc = subprocess.Popen([sys.executable, "-c", code],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if _health_ok(port):
                return
            if proc.poll() is not None:
                break
            time.sleep(0.05)
        log = tmp_path / "daemon.jsonl"
        pytest.fail("没有流时守护进程起不来 (退出码 %r):\n%s"
                    % (proc.returncode, log.read_text(encoding="utf-8")[-2000:]
                       if log.is_file() else "(没有日志文件)"))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:  # pragma: no cover - 收尾失败不该掩盖断言
            proc.kill()
