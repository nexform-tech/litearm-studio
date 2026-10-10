"""平动张开/闭合「到没到终点」的判据 —— 到了算到, 半路卡住不算。

一次平动有两条到达路径, 判据跟着它自己的目标走:

* **压限位**(``press=True``): ``close()``, 以及**没配工作行程**的 ``open()``。指令推到
  标定限位**外侧**的机械限位上, 所以堵转本身就是要的结果; 真正的失败只有在限位**内侧**
  停住 —— 那是撞上了东西。SDK 自己的 ``MoveResult.ok`` 问的是另一个问题: 停稳点距**标定**
  限位是否在 ``stop_tol``(0.02 rad ≈ 1 mm)以内。本机张开侧探到的限位比真实机械止点浅约
  2.7 mm, 于是齿爪顶到止点、却"越过"了标定限位 2.7 mm, ``ok`` 判 False。所以这条路径用
  「以**指令终点**(mm)为准, 短于终点超过 ``PRESS_REACH_TOL_MM`` 才算卡住」的替代判据。
* **普通定位**(``open()`` 且标定带了工作行程): 只走到工作位就停, 开口端留余量, **不堵转**,
  ``ok = reached and not stalled``。这时到达由 SDK 的 ``reached`` 说了算 —— 拿「必须堵转」
  去判它, 会把一次完全照做的张开报成「未到位」。

``reached`` 与 mm 判据是**或**的关系: 前者管定位, 后者管压限位, 各自对各自的移动成立。
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


def _result(*, stalled: bool, pos_rad: float, ok: bool,
            reached: bool = False) -> SimpleNamespace:
    """A ``MoveResult``-shaped object.  ``reached`` defaults to the press case,
    where the jaws stop past the target rather than on it."""
    return SimpleNamespace(
        ok=ok,
        reached=reached,
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

    with pytest.raises(Exception, match="未到位"):
        backend.open_plain(speed_mm_s=50.0)


def test_a_close_that_stalled_short_of_the_end_is_refused() -> None:
    """停在 0.1 rad ≈ 39 mm: 夹爪离闭合端还很远。"""
    backend, _ = _backend(_result(stalled=True, pos_rad=0.10, ok=False))

    with pytest.raises(Exception, match="未到位"):
        backend.close_plain(speed_mm_s=50.0)


def test_an_open_that_neither_stalled_nor_reached_is_refused() -> None:
    """跑完所有步数既没堵转、也没停在指令终点 —— 根本没到位。

    ``stalled=False`` 本身不再等于失败(定位移动就不该堵转), 判失败的是
    ``reached=False``: 这条路径只有 ``reached`` 能担保到达。
    """
    backend, _ = _backend(_result(stalled=False, reached=False,
                                  pos_rad=LIMITS.open_rad, ok=False))

    with pytest.raises(Exception, match="未到位"):
        backend.open_plain(speed_mm_s=50.0)


def test_a_work_stroke_open_that_stops_at_its_target_is_an_arrival() -> None:
    """配置带工作行程时 ``open()`` 是普通定位: 停在指令终点、**不堵转**。

    出厂标定文件写 ``work_stroke_mm = 80`` 而机械行程 86 mm, SDK 的 ``open()``
    于是只走到工作位就停, 开口端留出 6 mm 余量, ``stalled`` 恒为 False。这时唯一
    能担保到达的是 ``reached``; 再拿「必须堵转」去判, 一次完全照做的张开就会被报成
    「未到位」—— 这正是本机现场那两次失败里张开那一半。
    """
    backend, _ = _backend(_result(stalled=False, reached=True,
                                  pos_rad=LIMITS.to_rad(80.0), ok=True))

    assert backend.open_plain(speed_mm_s=50.0) is True


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
