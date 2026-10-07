"""平动张开/闭合「到没到限位」的判据 —— 压在限位上算到, 半路卡住不算。

``press=True`` 的 ``open()`` / ``close()`` 是把指令推到标定限位**外侧**的机械限位上,
所以堵转本身就是要的结果; 真正的失败只有一种: 在限位**内侧**停住, 那是撞上了东西。

SDK 自己的 ``MoveResult.ok`` 问的是另一个问题 —— 停稳点距**标定**限位是否在
``stop_tol``(0.02 rad ≈ 1 mm)以内。本机张开侧探到的限位比真实机械止点浅约 2.7 mm,
于是齿爪顶到止点、却"越过"了标定限位 2.7 mm, ``ok`` 判 False —— 全开一次就报一次
「张开未顶到限位：行程中被挡住」。这组用例钉住替代判据: 以**指令终点**(mm)为准, 短于
终点超过 ``PRESS_REACH_TOL_MM`` 才算卡住。
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Callable

import pytest

from litearm_studio_daemon.gripper import constants
from litearm_studio_daemon.gripper.backend.real import RealBackend
from litearm_studio_daemon.gripper.calibration import CalibrationInfo
from litearm_studio_daemon.gripper.units import Limits


#: 本机实测: 闭合 0.837 rad → 0 mm, 张开 -0.814 rad → 88 mm(记录极限), 指令顶 87 mm。
LIMITS = Limits(closed_rad=0.837148, open_rad=-0.813878,
                rad_to_mm=53.298, max_stroke_mm=87.0)


def _result(*, stalled: bool, pos_rad: float, ok: bool) -> SimpleNamespace:
    """A ``MoveResult``-shaped object, with only the fields under test."""
    return SimpleNamespace(
        ok=ok,
        stalled=stalled,
        state=SimpleNamespace(position_rad=pos_rad),
    )


class _FakeGripper:
    """Just enough of ``LiteGrip`` for ``open_plain``/``close_plain``."""

    is_connected = True
    is_enabled = True

    def __init__(self, result: Any) -> None:
        self._result = result
        self.calls: list[dict[str, Any]] = []

    def _record(self, speed_mm_s: float | None,
                progress: Callable[[Any], None] | None) -> Any:
        self.calls.append({"speed_mm_s": speed_mm_s, "progress": progress})
        return self._result

    def open(self, speed_mm_s: float | None = None, *, progress=None) -> Any:
        return self._record(speed_mm_s, progress)

    def close(self, speed_mm_s: float | None = None, *, progress=None) -> Any:
        return self._record(speed_mm_s, progress)


def _backend(result: Any) -> tuple[RealBackend, _FakeGripper]:
    gripper = _FakeGripper(result)
    backend = RealBackend(gripper=gripper)
    backend._info = CalibrationInfo(provenance="measured", limits=LIMITS, max_stroke_mm=87.0)
    return backend, gripper


def test_an_open_that_pressed_past_a_shallow_limit_is_an_arrival() -> None:
    """顶到机械止点、越过标定限位 —— ``ok=False`` 也照样算到了。

    这正是本机的那次: 停在 -0.8646 rad = 90.7 mm, 比 87 mm 的指令终点还远 3.7 mm。
    """
    backend, gripper = _backend(_result(stalled=True, pos_rad=-0.86461, ok=False))

    assert backend.open_plain(speed_mm_s=50.0) is True
    assert len(gripper.calls) == 1


def test_a_close_that_pressed_onto_the_stop_is_an_arrival() -> None:
    backend, _ = _backend(_result(stalled=True, pos_rad=0.838, ok=True))

    assert backend.close_plain(speed_mm_s=50.0) is True


def test_an_open_that_stalled_short_of_the_end_is_refused() -> None:
    """停在 -0.6 rad ≈ 76.8 mm: 离张开端还有 10 mm, 是撞上了东西。"""
    backend, _ = _backend(_result(stalled=True, pos_rad=-0.60, ok=False))

    with pytest.raises(Exception, match="未顶到限位"):
        backend.open_plain(speed_mm_s=50.0)


def test_a_close_that_stalled_short_of_the_end_is_refused() -> None:
    """停在 0.1 rad ≈ 39 mm: 夹爪离闭合端还很远。"""
    backend, _ = _backend(_result(stalled=True, pos_rad=0.10, ok=False))

    with pytest.raises(Exception, match="未顶到限位"):
        backend.close_plain(speed_mm_s=50.0)


def test_a_move_that_never_stalled_never_arrived() -> None:
    """跑完所有步数也没堵转 —— 根本没碰到终点。"""
    backend, _ = _backend(_result(stalled=False, pos_rad=LIMITS.open_rad, ok=False))

    with pytest.raises(Exception, match="未顶到限位"):
        backend.open_plain(speed_mm_s=50.0)


def test_the_tolerance_is_the_documented_one() -> None:
    """差 1 mm 以内算到 (压紧段收窄后本来就停得住差这个量级)。"""
    short_mm = 0.999
    pos_rad = LIMITS.to_rad(LIMITS.max_stroke_mm - short_mm)
    assert short_mm <= constants.PRESS_REACH_TOL_MM
    backend, _ = _backend(_result(stalled=True, pos_rad=pos_rad, ok=False))

    assert backend.open_plain(speed_mm_s=50.0) is True


# ── 压紧的力度 ──────────────────────────────────────────────────────────────

def test_the_backend_lowers_the_sdks_press_lead(
        monkeypatch: pytest.MonkeyPatch) -> None:
    """后端把 SDK 的 ``stop_lead_mm`` 调低 —— 平动张开/闭合走的就是它。

    ``open()`` / ``close()`` 硬编码 ``press=True``, 所以压紧力矩
    ``kp × stop_lead_mm / rad_to_mm`` 里唯一由本控制台决定的就是这个领先上限。
    这里钉住它被设成 :data:`PRESS_STOP_LEAD_MM`, 且确实低于 SDK 自己的默认值 ——
    否则这次「冲限位的度」一点没变。
    """
    from litearm_studio_daemon.gripper.backend import real as real_mod

    built: list[Any] = []

    class _FakeSDK:
        """只够走到 ``RealBackend.__init__`` 里那次赋值。"""

        def __init__(self, config: Any = None) -> None:
            self.config = config
            #: SDK ``MotionConfig`` 的默认值, 用来证明这里确实把它压下去了。
            self.motion_config = SimpleNamespace(stop_lead_mm=0.7)
            built.append(self)

    monkeypatch.setattr(real_mod, "LiteGrip", _FakeSDK)
    real_mod.RealBackend(channel="can0")

    assert len(built) == 1
    assert built[0].motion_config.stop_lead_mm == constants.PRESS_STOP_LEAD_MM
    assert constants.PRESS_STOP_LEAD_MM < 0.7
