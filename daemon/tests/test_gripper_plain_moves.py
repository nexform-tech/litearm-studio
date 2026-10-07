"""平动张开/闭合交给 SDK 自己的 ``open()`` / ``close()`` —— 分流、回退与中止。

Issue #72：本机夹爪两侧都有约 0.010 rad 的机械死区。守护进程自己那套「锚定在实测
位置」的控制律只能把指令领先实测一个受限的 lead（~0.0085 rad），突不破静摩擦，于是
齿爪来回粘滑、停在离限位一截的地方。SDK 的 ``open()`` / ``close()`` 用一条墙钟斜坡把
指令推过去，正是这条斜坡破开了死区。所以普通张开/闭合交给后端 ``open_plain`` /
``close_plain``：有 SDK 斜坡的后端自己驱动，仿真和其它没有的后端回落到 FSM。

这里钉这些事：

1. 普通 ``Open`` / ``Close`` 各自路由到 ``backend.open_plain`` / ``close_plain``，
   且 FSM 不被留在 SERVO；
2. 后端返回 ``False`` 时回落到 ``_motion.open`` / ``_motion.close``；
3. 带力的 ``Close(force_n=...)`` 永不走 ``close_plain``（那里位置增益是接近增益，
   SDK 的斜坡会被读成本就要检测的接触）；
4. 两个方向上，SDK 的进度回调触发中止（急停）时，worker 空转并让本 tick 的急停生效。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Optional

import pytest

from litearm_studio_daemon.gripper import calibration, constants
from litearm_studio_daemon.gripper.backend import MoveAborted
from litearm_studio_daemon.gripper.backend.sim import SimBackend
from litearm_studio_daemon.gripper.core import commands as cmd
from litearm_studio_daemon.gripper.core.worker import GateState, WorkerLoop


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A private ``$HOME``, so nothing here can read or write the bench file."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv(calibration.CALIB_ENV, raising=False)
    monkeypatch.setenv("LITEGRIP_FACTORY_CALIB", str(tmp_path / "no-factory.json"))
    return tmp_path / "home"


class _Chan:
    def __init__(self, name: str, owner: "Recorder") -> None:
        self._name, self._owner = name, owner

    def emit(self, *values: Any) -> None:
        if self._name == "alert":
            self._owner.alerts.append(values)


class Recorder:
    def __init__(self) -> None:
        self.alerts: list[tuple[Any, ...]] = []
        for name in ("telemetry", "motion_state", "conn_state", "fault",
                     "gate_state", "calib_info", "calib_progress", "log",
                     "alert", "busy"):
            setattr(self, name, _Chan(name, self))


class PlainSim(SimBackend):
    """仿真后端，外加一对可观察、可中止的 ``open_plain`` / ``close_plain``。

    仿真后端本身不实现这两个方法（基类返回 ``False``），所以它默认走 FSM ——
    这正是回退那两条用例要钉的。这里覆盖它们，好让「分流」与「中止」几条用例能看到调用。
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.open_calls: list[dict[str, Any]] = []
        self.close_calls: list[dict[str, Any]] = []
        #: 一次 ``*_plain`` 返回什么；``False`` 让 worker 回落到 FSM。
        self.handled = True
        #: 在 ``*_plain`` 中途调用一次，用来模拟 SDK 的 ``progress`` 回调。
        self.during_open: Optional[Callable[[], None]] = None
        self.during_close: Optional[Callable[[], None]] = None
        #: 之后 ``poll`` 一律回 False —— 模拟电机一声不吭（帧被 SDK 吃掉、或干脆没上电）。
        self.link_silent = False
        #: 累计发出去的 MIT 帧数，用来钉「链路判死时还发不发帧」。
        self.frames = 0

    def poll(self) -> bool:
        if self.link_silent:
            return False
        return super().poll()

    def stream_frame(self, *args: Any, **kwargs: Any) -> bool:
        self.frames += 1
        return super().stream_frame(*args, **kwargs)

    def _plain(
        self,
        calls: list[dict[str, Any]],
        attr: str,
        label: str,
        speed_mm_s: float | None,
        should_abort: Callable[[], bool] | None,
    ) -> bool:
        calls.append({"speed_mm_s": speed_mm_s, "should_abort": should_abort})
        hook: Optional[Callable[[], None]] = getattr(self, attr)
        if hook is not None:
            setattr(self, attr, None)   # 一次性：模拟回调只响一次
            hook()
        if should_abort is not None and should_abort():
            raise MoveAborted(f"{label}被中断")
        return self.handled

    def open_plain(
        self,
        *,
        speed_mm_s: float | None = None,
        should_abort: Callable[[], bool] | None = None,
    ) -> bool:
        return self._plain(self.open_calls, "during_open", "张开",
                           speed_mm_s, should_abort)

    def close_plain(
        self,
        *,
        speed_mm_s: float | None = None,
        should_abort: Callable[[], bool] | None = None,
    ) -> bool:
        return self._plain(self.close_calls, "during_close", "闭合",
                           speed_mm_s, should_abort)


def _ready_loop(tmp_path: Path) -> tuple[WorkerLoop, PlainSim, Recorder, list[float]]:
    """A connected, enabled loop on a nominal template — where a plain move is allowed.

    A template answers ``geometry=False`` (张开/闭合), so the gate is ``TEMPLATE`` and
    a plain ``Open``/``Close`` passes; a millimetre target would not.
    """
    now = [0.0]
    backend = PlainSim(clock=lambda: now[0])
    signals = Recorder()
    loop = WorkerLoop(backend, signals, clock=lambda: now[0],
                      sleep=lambda _s: None, watchdog_s=None)
    loop.submit(cmd.Connect())
    loop.tick_once(0.005)
    loop.submit(cmd.Enable())
    loop.tick_once(0.005)
    loop.submit(cmd.LoadTemplate("normal"))
    for _ in range(5):
        now[0] += 0.005
        loop.tick_once(0.005)
    assert loop.gate is GateState.TEMPLATE
    assert loop.enabled and loop.measured_rad() is not None
    return loop, backend, signals, now


# ── 闭合 ────────────────────────────────────────────────────────────────────

def test_a_plain_close_is_handed_to_the_backends_own_close(
        home: Path, tmp_path: Path) -> None:
    loop, backend, signals, now = _ready_loop(tmp_path)
    backend.close_calls.clear()

    loop.submit(cmd.Close(source="test"))
    now[0] += 0.005
    loop.tick_once(0.005)

    assert len(backend.close_calls) == 1, backend.close_calls
    call = backend.close_calls[0]
    # 速度滑杆在这里仍然算数：操作员设的速度要传给 SDK。
    assert call["speed_mm_s"] == loop.motion.params.speed_mm_s
    # 急停要能穿进一次会阻塞整段行程的调用，所以中止钩子必须在。
    assert call["should_abort"] is not None
    # FSM 没有被留在 SERVO：这一动是后端做的，worker 只是把位置重新驻留。
    assert loop.motion.state.value == "HOLD", loop.motion.state
    # 后端驱动期间状态帧停了，所以驻留前必须重读，否则会命令闭合前的位姿。
    assert loop._tele.position_mm is not None


def test_a_backend_without_a_close_falls_through_to_the_fsm(
        home: Path, tmp_path: Path) -> None:
    loop, backend, signals, now = _ready_loop(tmp_path)
    # ``close_plain`` 返回 False 就是「这个后端没有 SDK close，请走 FSM」。
    backend.handled = False
    backend.close_calls.clear()

    loop.submit(cmd.Close(source="test"))
    now[0] += 0.005
    loop.tick_once(0.005)

    assert len(backend.close_calls) == 1, backend.close_calls   # 问过后端
    assert loop.motion.state.value == "SERVO", loop.motion.state  # 但 FSM 接手了


def test_a_force_carrying_close_never_delegates(home: Path, tmp_path: Path) -> None:
    loop, backend, signals, now = _ready_loop(tmp_path)
    backend.close_calls.clear()

    loop.submit(cmd.Close(force_n=20.0, source="test"))
    now[0] += 0.005
    loop.tick_once(0.005)

    assert backend.close_calls == [], backend.close_calls
    # 带力的闭合留在 FSM：位置增益是接近增益，SDK 的斜坡会被读成接触。
    assert loop.motion.state.value in ("SERVO", "HOLD_FORCE"), loop.motion.state


def test_an_estop_during_the_sdk_close_aborts_it(home: Path, tmp_path: Path) -> None:
    """一段阻塞后端的调用里，急停仍然要能把它打断。

    这是委派方案唯一真正的代价：调用会占住 tick 线程整段行程。SDK 的 ``progress``
    回调是它给的唯一中断点，worker 把急停接在那里；回调一响，``close_plain`` 就抛
    ``MoveAborted`` 撤出 SDK 的控制环，本 tick 随后的急停处理再失能电机。
    """
    loop, backend, signals, now = _ready_loop(tmp_path)
    backend.close_calls.clear()
    backend.during_close = lambda: loop.estop("测试")

    loop.submit(cmd.Close(source="test"))
    now[0] += 0.005
    loop.tick_once(0.005)

    assert len(backend.close_calls) == 1, backend.close_calls
    assert loop.estopped, "急停应已触发"
    assert not loop.enabled, "急停应已失能电机"
    assert loop.motion.state.value != "SERVO", loop.motion.state


# ── 张开 ────────────────────────────────────────────────────────────────────

def test_a_plain_open_is_handed_to_the_backends_own_open(
        home: Path, tmp_path: Path) -> None:
    loop, backend, signals, now = _ready_loop(tmp_path)
    backend.open_calls.clear()

    loop.submit(cmd.Open(source="test"))
    now[0] += 0.005
    loop.tick_once(0.005)

    assert len(backend.open_calls) == 1, backend.open_calls
    call = backend.open_calls[0]
    assert call["speed_mm_s"] == loop.motion.params.speed_mm_s
    assert call["should_abort"] is not None
    assert loop.motion.state.value == "HOLD", loop.motion.state
    assert loop._tele.position_mm is not None
    # 张开不会碰闭合那条路：两个方向各走各的。
    assert backend.close_calls == [], backend.close_calls


def test_a_backend_without_an_open_falls_through_to_the_fsm(
        home: Path, tmp_path: Path) -> None:
    loop, backend, signals, now = _ready_loop(tmp_path)
    backend.handled = False
    backend.open_calls.clear()

    loop.submit(cmd.Open(source="test"))
    now[0] += 0.005
    loop.tick_once(0.005)

    assert len(backend.open_calls) == 1, backend.open_calls   # 问过后端
    assert loop.motion.state.value == "SERVO", loop.motion.state  # 但 FSM 接手了


def test_an_estop_during_the_sdk_open_aborts_it(home: Path, tmp_path: Path) -> None:
    loop, backend, signals, now = _ready_loop(tmp_path)
    backend.open_calls.clear()
    backend.during_open = lambda: loop.estop("测试")

    loop.submit(cmd.Open(source="test"))
    now[0] += 0.005
    loop.tick_once(0.005)

    assert len(backend.open_calls) == 1, backend.open_calls
    assert loop.estopped, "急停应已触发"
    assert not loop.enabled, "急停应已失能电机"
    assert loop.motion.state.value != "SERVO", loop.motion.state


# ── 阻塞调用之后的链路时钟 ──────────────────────────────────────────────────

def _refusal_alerts(signals: Recorder) -> list[str]:
    return [str(a) for a in signals.alerts if "链路已断" in str(a)]


def test_a_blocking_move_does_not_leave_the_link_reading_dead(
        home: Path, tmp_path: Path) -> None:
    """一次 ``*_plain`` 会占住 tick 线程整段行程 (秒级), 远超 LINK_STALE_MS。

    链路时钟只在这一循环自己的 ``poll`` 里前进, 而那段行程里收帧的是后端的斜坡,
    不是这个循环 —— 不重新对时的话, 回来的第一个 tick 就会把链路判死, 于是拒发那个
    本可以重新叫醒电机的驻留帧, 控制台就再也好不了 (真机上实测卡死过)。
    """
    loop, backend, signals, now = _ready_loop(tmp_path)
    backend.open_calls.clear()

    def block() -> None:
        now[0] += 1.5                 # 一趟 1.5 s 的行程
        backend.link_silent = True    # 帧被后端吃掉了, 本循环的 poll 看不到

    backend.during_open = block
    loop.submit(cmd.Open(source="test"))
    loop.tick_once(0.005)

    assert loop._stale_ms() <= constants.LINK_STALE_MS, (
        f"阻塞调用之后链路时钟应已重新对时，实为 {loop._stale_ms():.0f} ms")

    # 而且下一个移动不会再被判「链路已断」—— 卡死的正是这一步。
    backend.open_calls.clear()
    loop.submit(cmd.Open(source="test"))
    now[0] += 0.005
    loop.tick_once(0.005)

    assert backend.open_calls, "阻塞调用之后的移动仍应照常派发"
    assert _refusal_alerts(signals) == [], _refusal_alerts(signals)


def test_a_dead_link_still_refuses_a_move_but_never_stops_the_frames(
        home: Path, tmp_path: Path) -> None:
    """链路判死时, 新动作照拒 —— 但帧要继续发。

    帧是唯一能把链路叫回来的东西: 电机只在被寻址时才回帧, 所以"链路断就不发帧"
    是个自锁 —— 断一次就永远发不出下一帧。拒新动作与停发帧是两件事, 这里把两件
    都钉住。
    """
    loop, backend, signals, now = _ready_loop(tmp_path)
    backend.link_silent = True
    now[0] += 1.0                                  # 静默超过 LINK_STALE_MS
    loop.tick_once(0.005)
    assert loop._link_dead(), "静默 1 s 之后应判链路已断"

    loop.submit(cmd.Close(source="test"))
    before = backend.frames
    now[0] += 0.005
    loop.tick_once(0.005)

    assert backend.close_calls == [], "链路已断时不应派发新动作"
    assert _refusal_alerts(signals), "应有一条「链路已断」的拒绝"
    assert backend.frames > before, "链路已断也必须继续发帧, 否则永远醒不过来"

