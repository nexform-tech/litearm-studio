"""Calibration provenance, validation, and JSON I/O.

Why this module exists
----------------------
The SDK's ``load_calibration(path)`` reads ``[path, factory_calibration.json]``
in order and returns ``True`` for BOTH, distinguishing them only with a
``log.info`` call (gripper.py:726-749).  A factory file belongs to a nominal
unit, not necessarily to the gripper on the bench, so silently loading it makes
every mm and force reading wrong with nothing on screen to show it.  Worse,
calling nothing at all leaves ``GripperConfig``'s defaults in place —
``pos_closed_rad=0.0`` / ``pos_open_rad=1.14`` — and under those the SDK's own
clamp ``max(open, min(closed, x))`` collapses to a constant, so every target maps
to one angle.

The defence is structural rather than defensive:

1. Read and validate the file ourselves, before asking the SDK for anything.
2. Classify the provenance, and treat "no user file" and "unusable numbers" as
   distinct, separately-handled states.
3. Always hand the SDK an explicit path that we have already confirmed exists,
   so its fallback branch can never fire unnoticed.
4. Cross-check what the SDK actually applied against what we expected, and check
   the calibration against the angle the encoder is reporting.

The last of those is what carries the weight, and it is worth being explicit
about why, because an earlier version of this module leaned on something weaker.
It classified ``zero_position_rad <= max_position_rad`` as the signature of the
uncalibrated defaults and refused it as a problem.  That test does separate the
defaults ``(0.0, 1.14)`` from the real files on this bench — but it separates them
for a reason that has nothing to do with whether they are calibrated: those files
happen to come from grippers whose fingers are mounted so that the encoder angle
*shrinks* as the jaws open.  A gripper mounted the other way round has the
identical signature and is perfectly calibrated, and refusing it made such a unit
impossible to calibrate at all.  So the ordering is reported and the file-only
guess is gone; what refuses a calibration now is
:func:`~litearm_studio_daemon.gripper.units.frame_mismatch`, which compares the file against
the encoder and cannot be fooled by a mounting direction.

Pure layer: no Qt, no SDK at import time, no I/O beyond reading the JSON files
it is pointed at.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Mapping

from . import constants
from .units import Limits, derive_scale

# ── provenance ──────────────────────────────────────────────────────────────
PROVENANCE_USER = "user_file"
PROVENANCE_TEMPLATE = "template"
PROVENANCE_FACTORY = "factory_fallback"
PROVENANCE_INVALID = "invalid_user_file"
PROVENANCE_MISSING = "missing"
PROVENANCE_MEMORY = "in_memory_unsaved"

PROVENANCE_LABELS = {
    PROVENANCE_USER: "实测标定",
    PROVENANCE_TEMPLATE: "标称模板（从未实测）",
    PROVENANCE_FACTORY: "出厂标定（回退）",
    PROVENANCE_INVALID: "标定无效",
    PROVENANCE_MISSING: "未标定",
    PROVENANCE_MEMORY: "内存标定（未保存）",
}

#: Provenance → the wire's ``source`` field (``docs/GRIPPER_INTEGRATION.md``
#: §4.1).  The daemon's names are finer-grained than the wire's, and the mapping
#: lives here rather than in the session so the two cannot drift apart.
WIRE_SOURCES = {
    PROVENANCE_USER: "measured",
    PROVENANCE_MEMORY: "measured",
    PROVENANCE_TEMPLATE: "template",
    PROVENANCE_FACTORY: "factory",
    PROVENANCE_INVALID: "missing",
    PROVENANCE_MISSING: "missing",
}

#: Template names, in declaration order.  Mirrors the SDK's ``CALIB_TEMPLATES``
#: so the pure layer can list and validate a name without importing the SDK.
TEMPLATE_NAMES = ("normal", "reverse")

#: Environment override for the calibration file, same variable the SDK reads.
CALIB_ENV = "LITEGRIP_CALIB"

# The three keys the SDK requires; it indexes them unguarded (gripper.py:745),
# so a file missing one raises KeyError from inside the SDK rather than a
# diagnosable error.  We validate before it ever gets there.
REQUIRED_KEYS = ("zero_position_rad", "max_position_rad", "rad_to_mm")

# Keys the SDK's save_calibration() writes.  We mirror the full set so a file we
# produce is loadable by the SDK unchanged.
_SAVED_KEYS = (
    "channel",
    "can_id",
    "mst_id",
    "canfd_mode",
    "zero_position_rad",
    "max_position_rad",
    "travel_range_rad",
    "rad_to_mm",
    "motor_type",
    "kp",
    "kd",
    "grasp_torque_threshold",
)


def default_user_path(channel: str = "can0") -> Path:
    """This channel's own calibration file (``~/.litegrip/<channel>_calibration.json``).

    Mirrors the SDK's ``default_calib_path``: one gripper per channel, one file
    per channel, so two units on one machine cannot overwrite each other's
    direction and travel.  ``LITEGRIP_CALIB`` overrides it with one explicit
    path for every channel.
    """
    env = os.environ.get(CALIB_ENV)
    if env:
        return Path(env).expanduser()
    return Path.home() / ".litegrip" / f"{channel}_calibration.json"


def legacy_user_path() -> Path:
    """The pre-per-channel location, still read so old files keep working.

    Deliberately *not* ``default_user_path()``: the legacy file is a row of its
    own in the resolution order (§5.3), and naming it here keeps the two apart
    even when ``LITEGRIP_CALIB`` is set.
    """
    return Path.home() / ".litegrip" / "litegrip_calibration.json"


def template_path(name: str) -> Path:
    """The file behind a template name.

    Resolved through the SDK's own ``CALIB_TEMPLATES`` when the SDK is
    importable, so the two cannot disagree about which file ``"reverse"`` is;
    falls back to the package directory (which is where the SDK keeps them) when
    it is not.  An unknown name is a ``ValueError`` — the caller is a command
    handler, not a file resolver.
    """
    if name not in TEMPLATE_NAMES:
        raise ValueError(f"未知的标定模板 {name!r}；可用的是 "
                         f"{', '.join(repr(n) for n in TEMPLATE_NAMES)}")
    try:
        import litegrip

        table = getattr(litegrip, "CALIB_TEMPLATES", None)
        if isinstance(table, dict) and name in table:
            return Path(str(table[name])).expanduser()
        base = Path(litegrip.__file__).resolve().parent
    except Exception:  # noqa: BLE001 - only without the SDK installed
        base = Path(__file__).resolve().parent
    return base / f"calibration_{name}.json"


def list_templates() -> list[str]:
    return list(TEMPLATE_NAMES)


def packaged_factory_path() -> Path:
    """This console's own bundled default calibration.

    Ships next to this module (``gripper/factory_calibration.json``), so it is
    found however the daemon is run — from the source tree, from an installed
    wheel, or from a PyInstaller bundle (``sys._MEIPASS``).  Keeping it here
    rather than leaning on ``litegrip``'s copy is the point: the SDK's file
    describes whichever unit *it* shipped and changes with the pinned SDK
    version, while this one is the default the console commits to — used for
    every channel until a measured calibration is imported.
    """
    return Path(__file__).resolve().parent / "factory_calibration.json"


def factory_path() -> Path:
    """The default calibration file, in the order the launcher and the SDK allow.

    * ``LITEGRIP_FACTORY_CALIB`` wins first, and stays first for two reasons: the
      Debian package sets it to a path under ``/usr/lib`` that is stable across
      launches (the one-file bundle unpacks to a fresh temporary directory each
      time), which is what lets the settings page name one file; and the test
      suite points it at a nonexistent path to *disable* the default.
    * Next is the console's own packaged copy (:func:`packaged_factory_path`),
      which is what a source checkout or an installed wheel uses.
    * Last is whatever ``litegrip`` ships itself, reachable only when the
      console's copy is missing.
    """
    env = os.environ.get("LITEGRIP_FACTORY_CALIB")
    if env:
        return Path(env).expanduser()
    packaged = packaged_factory_path()
    if packaged.is_file():
        return packaged
    try:
        import litegrip

        return Path(litegrip.__file__).resolve().parent / "factory_calibration.json"
    except Exception:  # pragma: no cover - only without the SDK installed
        return packaged


def is_bundled_factory(path: str | os.PathLike[str] | None) -> bool:
    """Whether ``path`` *is* the console's bundled default calibration.

    The console ships ``factory_calibration.json`` (inside this package, and via
    the deb).  It is normally chosen automatically (row 5), but an operator
    can also browse to and import it, which pins it as row 1 — and that file is
    not an ordinary row-1 file: its own ``channel`` field hard-codes ``can0`` (a
    per-channel cross-check would refuse it on any other interface), and it is a
    default rather than a measurement.  Recognising it lets row 1 special-case
    both.
    """
    if not path:
        return False
    try:
        return Path(path).expanduser().resolve() == factory_path().resolve()
    except OSError:  # pragma: no cover - unresolvable path
        return False


#: Warning attached to the bundled default, so the operator can see on the
#: calibration page that the numbers are the shipped ones, not a measurement.
BUNDLED_FACTORY_WARNING = (
    "正在使用随程序打包的默认标定（factory_calibration.json）："
    "若与本机夹爪不是同一台，所有 mm 与力的读数都会是错的"
)


def bundled_default(channel: str | None, mount: str | None,
                    travel_mm: float) -> CalibrationInfo | None:
    """The packaged ``factory_calibration.json`` as the *default* calibration.

    Returns the file as a :class:`CalibrationInfo` when it exists and its
    recorded orientation fits the declared ``mount``; ``None`` when it cannot
    serve one (a missing file, an unreadable one, or a ``reverse`` declaration
    the normal-oriented shipped file does not describe — the caller then falls
    through to the named template, which carries the right direction).

    Adopted as a *user* calibration, not ``factory`` provenance: it is the
    console's own default rather than data pulled off some other machine, so the
    gate lets motion through immediately and the operator does not have to
    acknowledge a file they never chose.  The warning says where the numbers
    came from.  It is only reached after every *measured* source (rows 1–4) has
    been tried, so it never displaces a real measurement.
    """
    fact = factory_path()
    if not fact.is_file():
        return None
    info = inspect_file(fact, travel_mm, provenance=PROVENANCE_USER,
                        channel=channel)
    if info.limits is None:
        return None
    if info.limits.reversed_mount != (mount == "reverse"):
        return None
    return _with_warning(info, BUNDLED_FACTORY_WARNING)


def sdk_root() -> Path | None:
    """Where the ``litegrip`` package was imported from, one level up."""
    try:
        import litegrip

        return Path(litegrip.__file__).resolve().parent.parent
    except Exception:  # pragma: no cover - only without the SDK installed
        return None


def friendly_path(path: str | os.PathLike[str] | None) -> str:
    """A path written the way a person reads it, for display only.

    Loading always uses the absolute path, and must: the SDK resolves its
    factory file through ``dirname(__file__)`` and a frozen build resolves it
    under ``sys._MEIPASS``, neither of which survives being made relative.  So
    this exists to be *shown* and never to be opened.

    The two paths that have a meaningful home are shown relative to it — the
    SDK's own file relative to the SDK, anything under the home directory with a
    leading ``~``.  ``litegrip/factory_calibration.json`` says where that file
    lives; ``/opt/litegrip/litegrip/factory_calibration.json`` only says
    which machine it was checked out on.
    """
    if not path:
        return "—"
    resolved = Path(path).expanduser()
    root = sdk_root()
    if root is not None:
        try:
            return str(resolved.relative_to(root))
        except ValueError:
            pass
    try:
        return "~/" + str(resolved.relative_to(Path.home()))
    except ValueError:
        return str(resolved)


@dataclass(frozen=True)
class CalibrationInfo:
    """Everything the UI and the gate need to know about the active calibration."""

    provenance: str
    limits: Limits | None
    path: str | None = None
    raw: Mapping[str, Any] = field(default_factory=dict)
    problems: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    max_stroke_mm: float = constants.DEFAULT_TRAVEL_MM
    #: The template name, when the calibration in effect is a named template.
    #: The SDK is loaded with ``template=`` in that case, never with a path: a
    #: template copied into the user directory would pass for a measurement.
    template: str | None = None
    #: The channel the record belongs to, when it is known.
    channel: str | None = None

    @property
    def label(self) -> str:
        return PROVENANCE_LABELS.get(self.provenance, self.provenance)

    @property
    def wire_source(self) -> str:
        """The ``source`` this calibration reports on the wire (§4.1)."""
        return WIRE_SOURCES.get(self.provenance, "missing")

    @property
    def usable(self) -> bool:
        """True when the numbers are trustworthy enough to display and to plan with."""
        return self.limits is not None and not self.problems

    @property
    def motion_allowed(self) -> bool:
        """True when the backend should let the motor be *driven* at all.

        Strictly narrower than :attr:`usable`, and the difference is the point:
        an in-memory probe result is *usable* — its numbers are self-consistent
        and the UI should show them — but it is not *saved*, so nothing about it
        survives a restart and a move planned against it cannot be reproduced.
        A cross-check failure is narrower still: the numbers are unusable because
        the hardware is not running on them.

        The template case is allowed here and narrowed by the *gate*, which
        permits only the commands that do not depend on geometry (open, close,
        release).  Keeping that split means this property stays a statement
        about the file, and the gate stays the statement about what may move.
        """
        return self.usable and self.provenance in (
            PROVENANCE_USER, PROVENANCE_TEMPLATE, PROVENANCE_FACTORY,
        )

    @property
    def is_user(self) -> bool:
        return self.provenance == PROVENANCE_USER

    @property
    def is_factory(self) -> bool:
        return self.provenance == PROVENANCE_FACTORY

    def describe(self) -> str:
        """One-line summary for logs and the status bar."""
        if self.limits is None:
            return f"{self.label}: {'; '.join(self.problems) or '无数据'}"
        lim = self.limits
        return (
            f"{self.label} | 闭合 {lim.closed_rad:.6f} rad / 张开 {lim.open_rad:.6f} rad "
            f"| 可命令行程 {lim.max_stroke_mm:.1f} mm "
            f"| 记录极限跨度 {lim.stroke_mm:.1f} mm ({lim.rad_to_mm:.2f} mm/rad) "
            f"| {mounting_label(lim)} | 来源 {self.path or '—'}"
        )

    def headline(self) -> str:
        """The banner's one line, in millimetres.

        ``describe`` is the log line and keeps the radians, because a log is
        read while chasing a fault.  This is the banner, which is read while
        deciding whether to move the gripper, so it says only what that decision
        turns on — and it says the commanded travel rather than the span the file
        implies, because that is the number the slider spans and the one the
        operator set.

        The mounting direction earns its place on this line for the same reason
        the travel is here: it is the one other fact that decides whether 闭合
        means what the operator thinks it means, it is invisible everywhere else
        on the page, and a gripper whose two ends are recorded the wrong way round
        looks exactly like a correctly calibrated one from the outside.
        """
        lim = self.limits
        if lim is None:
            return self.label
        return f"{self.label}：行程 {lim.max_stroke_mm:.1f} mm · {mounting_label(lim)}"

    def summary(self) -> list[tuple[str, str]]:
        """The rows an operator acts on, always on screen.

        Two rows, and not three: where the numbers came from and how wide the
        gripper is.  Which file said so belongs with the file buttons, where the
        operator opens and saves it, and repeating it here would be the same
        clutter in a shorter form.  The rad values and gains that back these two
        are real and are one checkbox away — they are what gets read while
        something is wrong, not what anyone reads before pressing 闭合.
        """
        lim = self.limits
        return [
            ("来源", self.label),
            ("行程", f"{lim.max_stroke_mm:.1f} mm" if lim else "—"),
        ]

    def as_table(self) -> list[tuple[str, str]]:
        """Key/value rows for the calibration page.

        The two millimetre rows are deliberately the derived ones, and the file's
        own scale sits next to them rather than replacing them: when the two
        disagree, this table is where an operator sees by how much, and
        :func:`validate_limits` has already said why.
        """
        lim = self.limits
        raw = self.raw
        rows = [
            ("来源", self.label),
            ("文件", friendly_path(self.path)),
            ("zero_position_rad (闭合)", _fmt(lim.closed_rad) if lim else "—"),
            ("max_position_rad (张开)", _fmt(lim.open_rad) if lim else "—"),
            ("travel_range_rad", _fmt(lim.travel_rad) if lim else "—"),
            ("装配方向", mounting_label(lim) if lim else "—"),
            ("rad_to_mm (按行程推导)", _fmt(lim.rad_to_mm) if lim else "—"),
            ("rad_to_mm (文件自带)", _fmt(file_scale(raw))),
            ("记录极限跨度", f"{lim.stroke_mm:.2f} mm" if lim else "—"),
            ("行程上限 (可命令)", f"{self.max_stroke_mm:.1f} mm"),
            ("channel", str(raw.get("channel", "—"))),
            ("can_id", _fmt_hex(raw.get("can_id"))),
            ("mst_id", _fmt_hex(raw.get("mst_id"))),
            ("kp", str(raw.get("kp", "—"))),
            ("kd", str(raw.get("kd", "—"))),
            ("grasp_torque_threshold", str(raw.get("grasp_torque_threshold", "—"))),
        ]
        return rows


def _fmt(value: float | None) -> str:
    return "—" if value is None else f"{value:.6f}"


def mounting_label(limits: Limits) -> str:
    """How the linkage is assembled, in words.

    Shown wherever an operator decides whether to trust a millimetre reading,
    because it is the one property of a calibration that no amount of looking at
    the numbers can settle: the same two angles, read in the same order, describe
    a correct gripper and a gripper whose ends were recorded the wrong way round,
    and only the hardware can say which.  Naming the case at least makes the
    question visible; it is what turns "闭合 and 张开 are swapped" from a mystery
    into a one-line fix on the calibration page.
    """
    if limits.travel_rad <= 0:
        return "装配方向未知（两个角相同）"
    if limits.reversed_mount:
        return "反向装配（张开角更大）"
    return "正向装配（闭合角更大）"


def _fmt_hex(value: Any) -> str:
    try:
        return f"0x{int(value):02X}"
    except (TypeError, ValueError):
        return "—"


# ── reading and validating ──────────────────────────────────────────────────
def parse_calibration_json(text: str) -> tuple[dict[str, Any] | None, list[str]]:
    """Parse calibration JSON.  Returns ``(data, problems)``.

    Never raises on malformed input — a bad file must surface as a diagnosable
    problem, not as a ``KeyError`` from inside the SDK.
    """
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, [f"JSON 解析失败: {exc}"]
    if not isinstance(data, dict):
        return None, [f"顶层应为对象，实际是 {type(data).__name__}"]

    missing = [k for k in REQUIRED_KEYS if k not in data]
    if missing:
        return data, [f"缺少必需字段: {', '.join(missing)}"]

    numeric: list[str] = []
    for key in REQUIRED_KEYS:
        try:
            float(data[key])
        except (TypeError, ValueError):
            numeric.append(f"{key}={data[key]!r} 不是数值")
    if numeric:
        return data, numeric
    return data, []


def limits_from_raw(
    raw: Mapping[str, Any], max_stroke_mm: float = constants.DEFAULT_TRAVEL_MM
) -> Limits:
    """Build :class:`Limits` from parsed calibration JSON.

    ``zero_position_rad`` is the closed position and ``max_position_rad`` the
    open one — mapping the SDK's names onto our own, since "max_position" reads
    as "largest angle" but means "fully open".  On a reverse-mounted gripper the
    two coincide, which is the only case where the SDK's name is not misleading
    and is a good illustration of why the ordering carries no information.

    The angles are taken from the file; the millimetres-per-rad is not.  It is
    derived from them and from the operator's measured travel
    (:func:`~litearm_studio_daemon.gripper.units.derive_scale`), because the file's own copy
    of it is the nominal stroke of whichever unit that file was written for.  The
    file's value is not discarded, though — :func:`validate_limits` compares the
    two, and the disagreement is how a file from another gripper is caught.
    """
    closed = float(raw["zero_position_rad"])
    opened = float(raw["max_position_rad"])
    return Limits(
        closed_rad=closed,
        open_rad=opened,
        rad_to_mm=derive_scale(abs(closed - opened), max_stroke_mm),
        max_stroke_mm=float(max_stroke_mm),
    )


def file_scale(raw: Mapping[str, Any]) -> float | None:
    """The ``rad_to_mm`` a calibration file carries, or ``None`` if it has none.

    Returned even when it is zero or negative: it is not used as a conversion
    factor any more, only compared against what the SDK applied and against the
    travel the operator measured, and "the file says 0" is exactly the kind of
    evidence an operator chasing a wrong reading needs to see.
    """
    try:
        return float(raw["rad_to_mm"])
    except (KeyError, TypeError, ValueError):
        return None


def validate_limits(
    limits: Limits,
    max_stroke_mm: float = constants.DEFAULT_TRAVEL_MM,
    file_rad_to_mm: float | None = None,
) -> tuple[list[str], list[str]]:
    """Return ``(problems, warnings)``.  Problems block motion; warnings do not.

    ``file_rad_to_mm`` is the scale the file itself carries, when it has one.
    Supplying it turns on a check on the stroke that scale implies.

    That check is deliberately a wide one, and deliberately not a comparison
    against the travel the operator measured.  A file the SDK or an older
    console wrote carries the *nominal* stroke it was configured with — 120 mm
    by default, as the operator's own file does — divided by the span it
    recorded, so the implied stroke says which nominal was set rather than how
    wide this gripper's jaws are, and it reads 120 mm for a 60 mm unit and a
    120 mm unit alike.  Comparing it with the measurement would therefore fire
    on every file written that way, including the operator's own, and a warning
    that is always on is a warning nobody reads.  What is left worth catching is
    a file whose implied stroke is not even the right order of magnitude.
    """
    problems: list[str] = []
    warnings: list[str] = []

    # Not a problem, and deliberately not silent either.  This is the one
    # property of a calibration that a file alone can neither confirm nor refute:
    # a reverse-mounted gripper and a file whose angles came from somewhere else
    # look exactly alike here.  What settles it is the encoder — see
    # ``frame_mismatch`` — so all this does is say which case was recorded, in
    # the one place an operator reads before commanding a move.
    if limits.reversed_mount:
        warnings.append(
            f"闭合角 ({limits.closed_rad:.6f} rad) 小于张开角 ({limits.open_rad:.6f} rad)："
            "按反向装配解释 —— 张开时角度变大。若本机其实是正向装配，"
            "说明这份标定把两个极限记反了，请用实测位置确认后再运动"
        )

    if limits.travel_rad <= 0:
        problems.append("行程 (travel_range_rad) 必须为正")

    # This is the derived scale, so a travel setting that cannot produce one
    # (zero, negative, NaN) lands here as well as on the check above.
    if limits.rad_to_mm <= 0:
        problems.append(
            f"由行程 {limits.travel_rad:.6f} rad 与设定行程 {max_stroke_mm:.1f} mm "
            "推出的 mm/rad 无效；请检查标定页上的行程设定"
        )
    elif not (constants.RAD_TO_MM_MIN <= limits.rad_to_mm <= constants.RAD_TO_MM_MAX):
        problems.append(
            f"推导出的 rad_to_mm={limits.rad_to_mm:.2f} 超出合理范围 "
            f"[{constants.RAD_TO_MM_MIN}, {constants.RAD_TO_MM_MAX}] —— "
            f"行程设定 {max_stroke_mm:.1f} mm 与这份标定的 "
            f"{limits.travel_rad:.6f} rad 不可能属于同一台夹爪"
        )

    if not problems and file_rad_to_mm is not None:
        if file_rad_to_mm <= 0:
            warnings.append(
                f"文件自带的 rad_to_mm={file_rad_to_mm:g} 无效（应为正）；"
                f"系数按设定的行程 {max_stroke_mm:.1f} mm 推导，该文件无法用于交叉核对"
            )
        else:
            implied = limits.travel_rad * file_rad_to_mm
            if not (
                constants.STROKE_MIN_MM <= implied <= constants.STROKE_MAX_MM
            ):
                warnings.append(
                    f"文件自带的 rad_to_mm={file_rad_to_mm:.2f} 意味着行程 {implied:.1f} mm，"
                    f"超出了夹爪可能的范围 "
                    f"[{constants.STROKE_MIN_MM:.0f}, {constants.STROKE_MAX_MM:.0f}] mm —— "
                    f"该文件多半属于另一台夹爪，甚至可能是笔误。"
                    f"mm 与滑块已按设定的 {max_stroke_mm:.1f} mm 重新推导"
                )
    return problems, warnings


def inspect_file(
    path: str | os.PathLike[str],
    max_stroke_mm: float = constants.DEFAULT_TRAVEL_MM,
    *,
    provenance: str = PROVENANCE_USER,
    template: str | None = None,
    channel: str | None = None,
) -> CalibrationInfo:
    """Read and validate one calibration file, without applying it.

    The single place a file becomes a :class:`CalibrationInfo`, so every row of
    the resolution order below is validated identically: the three required keys
    must be present and numeric, the travel must be positive, and the derived
    millimetres per rad must fall inside the plausible band.  The SDK validates
    nothing (it indexes the keys unguarded), so a malformed file must never reach
    it.
    """
    target = Path(path).expanduser()
    try:
        text = target.read_text(encoding="utf-8")
    except OSError as exc:
        return CalibrationInfo(
            provenance=PROVENANCE_INVALID, limits=None, path=str(target),
            channel=channel, template=template, problems=(f"无法读取: {exc}",),
            max_stroke_mm=max_stroke_mm,
        )

    raw, problems = parse_calibration_json(text)
    if problems or raw is None:
        return CalibrationInfo(
            provenance=PROVENANCE_INVALID, limits=None, path=str(target),
            raw=raw or {}, channel=channel, template=template,
            problems=tuple(problems), max_stroke_mm=max_stroke_mm,
        )

    limits = limits_from_raw(raw, max_stroke_mm)
    hard, soft = validate_limits(limits, max_stroke_mm, file_scale(raw))
    return CalibrationInfo(
        provenance=provenance if not hard else PROVENANCE_INVALID,
        limits=limits if not hard else None,
        path=str(target),
        raw=raw,
        channel=channel,
        template=template,
        problems=tuple(hard),
        warnings=tuple(soft),
        max_stroke_mm=max_stroke_mm,
    )


def file_channel(raw: Mapping[str, Any]) -> str | None:
    """The ``channel`` a calibration file declares, or ``None`` when it omits it."""
    value = raw.get("channel")
    return str(value) if value else None


def template_for_path(path: str | os.PathLike[str]) -> str | None:
    """Which template this path *is*, or ``None``.

    A file that happens to be the SDK's nominal template must be labelled a
    template wherever it came from.  Copying one into the user calibration
    directory and calling it a measurement is the failure §D4 exists to prevent,
    and a pinned path pointing straight at the shipped file is the same file.
    """
    target = Path(path).expanduser()
    for name in TEMPLATE_NAMES:
        try:
            if target.resolve() == template_path(name).resolve():
                return name
        except OSError:  # pragma: no cover - unresolvable path
            continue
    return None


def resolve(
    channel: str = "can0",
    *,
    path: str | os.PathLike[str] | None = None,
    mount: str | None = None,
    travel_mm: float = constants.DEFAULT_TRAVEL_MM,
    template: str | None = None,
    env: Mapping[str, str] | None = None,
) -> CalibrationInfo:
    """Determine which calibration is in effect, and whether it is safe.

    The order is ``docs/GRIPPER_INTEGRATION.md`` §5.3, first hit wins, and the
    result carries its provenance:

    =====  ===============================================  ================
    #      Source                                             provenance
    =====  ===============================================  ================
    1      ``path`` (the per-channel record's pinned file)    measured
    2      ``~/.litegrip/<channel>_calibration.json``          measured
    3      ``LITEGRIP_CALIB``                                 measured, flagged
    4      ``~/.litegrip/litegrip_calibration.json``          measured, legacy
    5      bundled ``factory_calibration.json`` (mount-aware)  measured (default)
    6      SDK template named by ``mount``                    template
    7      nothing                                            missing
    =====  ===============================================  ================

    ``template`` (an explicit choice) short-circuits the whole table: the
    operator asked for that direction by name, and answering with a file instead
    is the silent substitution the name exists to prevent.

    The daemon never asks the SDK what it loaded.  The SDK cannot tell its own
    fallback from a real file — both return ``True`` — so the decision is made
    here, from the filesystem, and the SDK is then told explicitly which file or
    which template to apply.
    """
    environment = os.environ if env is None else env
    stroke = float(travel_mm)

    if template is not None:
        candidate = template_path(template)
        info = inspect_file(candidate, stroke, provenance=PROVENANCE_TEMPLATE,
                            template=template, channel=channel)
        return _with_warning(
            info,
            f"这是 SDK 自带的标称模板（{template}），从未在本机实测："
            "它只声明装配方向与标称几何，毫米读数仅供对方向，不能用于定位",
        )

    # 1 — the file this channel's record pins.
    if path:
        target = Path(path).expanduser()
        if not target.is_file():
            # A pinned path that has gone away is a fact the operator must see,
            # not a reason to quietly adopt whichever file is next in the list.
            return CalibrationInfo(
                provenance=PROVENANCE_MISSING, limits=None, path=str(target),
                channel=channel, problems=(f"指定的标定文件不存在: {target}",),
                max_stroke_mm=stroke,
            )
        name = template_for_path(target)
        if name is None and is_bundled_factory(target):
            # The console's own default file, pinned *explicitly* — the operator
            # browsed to and imported the shipped ``factory_calibration.json``.
            # Two things make it not-an-ordinary-row-1 file: its ``channel`` field
            # hard-codes can0 (the cross-check would refuse it on every other
            # interface), and it is a shipped default rather than a measurement,
            # so it is adopted and flagged instead of cross-checked.  (Chosen
            # *automatically* it would instead arrive via :func:`bundled_default`
            # at row 5.)
            return _with_warning(
                inspect_file(target, stroke, provenance=PROVENANCE_USER,
                             channel=channel),
                BUNDLED_FACTORY_WARNING,
            )
        info = inspect_file(
            target, stroke,
            provenance=PROVENANCE_TEMPLATE if name else PROVENANCE_USER,
            template=name, channel=channel,
        )
        return _channel_checked(info, channel, stroke)

    # 2 — this channel's own file.
    own = Path.home() / ".litegrip" / f"{channel}_calibration.json"
    if own.is_file():
        return _channel_checked(
            inspect_file(own, stroke, provenance=PROVENANCE_USER, channel=channel),
            channel, stroke)

    # 3 — the environment override.
    override = environment.get(CALIB_ENV)
    if override:
        env_path = Path(override).expanduser()
        if env_path.is_file():
            name = template_for_path(env_path)
            info = inspect_file(
                env_path, stroke,
                provenance=PROVENANCE_TEMPLATE if name else PROVENANCE_USER,
                template=name, channel=channel,
            )
            return _channel_checked(
                _with_warning(info, f"标定文件来自环境变量 {CALIB_ENV}={override}"), channel, stroke)

    # 4 — the pre-per-channel location.
    legacy = legacy_user_path()
    if legacy.is_file():
        name = template_for_path(legacy)
        info = inspect_file(
            legacy, stroke,
            provenance=PROVENANCE_TEMPLATE if name else PROVENANCE_USER,
            template=name, channel=channel,
        )
        info = _with_warning(
            info, f"正在使用旧版单文件标定 {legacy}（建议迁移到 "
                  f"{own}，两台夹爪共用一份时通道是唯一身份键）")
        return _channel_checked(info, channel, stroke)

    # 5 — the console's packaged default (``factory_calibration.json``), when it
    # fits the declared mount.  It sits here, *below* the measured sources, so a
    # real file for this channel always wins; and *above* the named template, so
    # a fresh install drives on the shipped numbers rather than the nominal
    # 120 mm template.  A mount the shipped file cannot describe (reverse) falls
    # through to that template below.
    bundled = bundled_default(channel, mount, stroke)
    if bundled is not None:
        return bundled

    # 6 — a named template, when the operator has declared a mount.
    if mount in TEMPLATE_NAMES:
        return resolve(channel, mount=mount, travel_mm=stroke, template=mount)

    # 7 — nothing.
    return CalibrationInfo(
        provenance=PROVENANCE_MISSING, limits=None, path=None, channel=channel,
        problems=(
            f"未找到任何标定文件（已尝试 {own} 与 {factory_path()}）",
            "请先运行 zero() 实测，或声明装配方向以载入标称模板",
        ),
        max_stroke_mm=stroke,
    )


def _with_warning(info: CalibrationInfo, warning: str) -> CalibrationInfo:
    return replace(info, warnings=tuple(info.warnings) + (warning,))


def _channel_checked(info: CalibrationInfo, channel: str,
                     travel_mm: float) -> CalibrationInfo:
    """Refuse to adopt a file whose own ``channel`` names another interface.

    The channel is the only thing that tells two grippers apart when both sit at
    CAN ID 0x08 (§5.3's "channel field matches, or is absent").  A mismatch is
    reported as a problem rather than a warning, because motion planned on
    another unit's geometry is wrong by a constant nobody can see.
    """
    if not channel:
        return info
    declared = file_channel(info.raw)
    if declared and declared != channel:
        return replace(
            info,
            provenance=PROVENANCE_INVALID,
            limits=None,
            problems=info.problems + (
                f"标定文件声明的 channel={declared} 与本通道 {channel} 不一致 —— "
                "同一台机器上两台夹爪共用 CAN ID 时通道是唯一身份键，"
                "拒绝把它用在本次会话上",
            ),
        )
    return info


def candidate_dict(info: CalibrationInfo, channel: str) -> dict[str, Any]:
    """One ``*.json`` row of ``gripper.list_dir`` (the file picker).

    ``inUse`` is deliberately absent here: which candidate is *in effect* is the
    session's answer (it knows what the backend applied), not the resolver's.
    """
    limits = info.limits
    return {
        "path": info.path,
        "source": info.wire_source,
        "provenance": info.provenance,
        "template": info.template,
        "channel": channel,
        "valid": info.usable,
        "problems": list(info.problems),
        "warnings": list(info.warnings),
        "closedRad": None if limits is None else limits.closed_rad,
        "openRad": None if limits is None else limits.open_rad,
        "fileRadToMm": file_scale(info.raw),
        "mount": None if limits is None else (
            "reverse" if limits.reversed_mount else "normal"),
    }


def sdk_source(info: CalibrationInfo) -> tuple[str, str] | None:
    """How to tell the SDK which calibration to apply: ``("template", name)``.

    Returns ``None`` — load nothing — for every provenance motion must not
    proceed on.  The SDK's no-argument call is never used: it falls back to the
    bundled factory file and returns success either way, so the caller could not
    tell which file moved the jaws.
    """
    if info.provenance == PROVENANCE_TEMPLATE and info.template:
        return ("template", info.template)
    if info.provenance in (PROVENANCE_USER, PROVENANCE_FACTORY) and info.path:
        return ("path", info.path)
    return None


def in_memory(
    zero_rad: float,
    open_rad: float,
    rad_to_mm: float,
    max_stroke_mm: float = constants.DEFAULT_TRAVEL_MM,
    **extra: Any,
) -> CalibrationInfo:
    """Wrap fresh probe results as an unsaved calibration.

    The probe's own ``rad_to_mm`` arrives with the angles and is kept as the raw
    evidence — it is what the SDK would write to a file, so it is what a cross
    check and a cross-machine comparison need — but the limits built here derive
    their scale from the angles and the travel like every other path, or the
    reading a just-probed gripper moves by would change the moment the result
    was saved and read back.

    Deliberately still gated: an in-memory result is not a saved calibration,
    because nothing would survive a restart.
    """
    limits = limits_from_raw(
        {"zero_position_rad": zero_rad, "max_position_rad": open_rad},
        max_stroke_mm,
    )
    hard, soft = validate_limits(limits, max_stroke_mm, file_rad_to_mm=rad_to_mm)
    raw = {
        "zero_position_rad": zero_rad,
        "max_position_rad": open_rad,
        "travel_range_rad": limits.travel_rad,
        "rad_to_mm": rad_to_mm,
        **extra,
    }
    warnings = list(soft)
    if not hard:
        warnings.append("尚未保存到文件；请保存后再运动")
    return CalibrationInfo(
        provenance=PROVENANCE_MEMORY,
        limits=limits if not hard else None,
        path=None,
        raw=raw,
        problems=tuple(hard),
        warnings=tuple(warnings),
        max_stroke_mm=max_stroke_mm,
    )


def cross_check(
    info: CalibrationInfo,
    applied: Limits | None,
    *,
    angle_tol_rad: float = 1e-4,
    rad_to_mm_rel_tol: float = 1e-3,
) -> list[str]:
    """Compare what the backend actually applied against what we asked for.

    This is the fourth defence, and the only one that observes the outcome
    rather than the intent.  Everything up to here constrains what we *hand* the
    SDK — read the file ourselves, validate it, pass an explicit path.  None of
    that proves the SDK obeyed: ``load_calibration`` can still take its fallback
    branch, and a backend may apply a config from somewhere else entirely.

    A mismatch here means the numbers on screen do not describe the gripper in
    front of the operator, which is the failure mode the whole module exists to
    prevent.  It is reported as a warning rather than a problem because the
    caller has already moved by the time it can be computed; the gate treats a
    non-empty result as a reason to refuse *further* motion.
    """
    if info.limits is None:
        if applied is None:
            return [f"请求载入的标定不可用（{info.label}）"]
        return [
            f"请求载入的标定不可用（{info.label}），但后端仍应用了一组限位 "
            f"({applied.closed_rad:.6f}, {applied.open_rad:.6f}) rad —— 运动已拒绝"
        ]
    if applied is None:
        return [f"已载入 {info.path}，但后端未报告任何限位 —— 无法确认标定是否生效"]

    expect = info.limits
    problems: list[str] = []
    for name, want, got in (
        ("zero_position_rad (闭合)", expect.closed_rad, applied.closed_rad),
        ("max_position_rad (张开)", expect.open_rad, applied.open_rad),
    ):
        if abs(want - got) > angle_tol_rad:
            problems.append(f"{name}: 文件为 {want:.6f} rad，实际生效 {got:.6f} rad")

    # Compared against the FILE's scale and not ``expect.rad_to_mm``, which is
    # the derived one: what is being checked here is that the SDK read this file
    # rather than falling back to another, and the file's own value is the only
    # evidence of that.  The derived scale is applied separately, after this
    # passes — see ``RealBackend.load_calibration``.
    want_mm = file_scale(info.raw) or expect.rad_to_mm
    if want_mm == 0 or applied.rad_to_mm == 0:
        if want_mm != applied.rad_to_mm:
            problems.append(
                f"rad_to_mm: 文件为 {want_mm}，实际生效 {applied.rad_to_mm}"
            )
    elif abs(want_mm - applied.rad_to_mm) / abs(want_mm) > rad_to_mm_rel_tol:
        rel = abs(want_mm - applied.rad_to_mm) / abs(want_mm)
        problems.append(
            f"rad_to_mm: 文件为 {want_mm:.2f}，实际生效 {applied.rad_to_mm:.2f} "
            f"(相差 {rel * 100:.1f}%)"
        )

    if problems:
        return [
            f"标定交叉核对失败：{info.path} 未被如实应用 —— 界面读数与实机不符，请勿运动",
            *problems,
        ]
    return []


# ── writing ─────────────────────────────────────────────────────────────────
def build_save_dict(
    limits: Limits,
    *,
    channel: str = "can0",
    can_id: int = 0x08,
    mst_id: int = 0x18,
    canfd_mode: bool = False,
    motor_type: str = "DM4310",
    kp: float = constants.KP_MOVE,
    kd: float = constants.KD_DEFAULT,
    grasp_torque_threshold: float = 0.5,
) -> dict[str, Any]:
    """Build a calibration dict in the SDK's schema (see ``_SAVED_KEYS``)."""
    data = {
        "channel": channel,
        "can_id": can_id,
        "mst_id": mst_id,
        "canfd_mode": canfd_mode,
        "zero_position_rad": limits.closed_rad,
        "max_position_rad": limits.open_rad,
        "travel_range_rad": limits.travel_rad,
        "rad_to_mm": limits.rad_to_mm,
        "motor_type": motor_type,
        "kp": kp,
        "kd": kd,
        "grasp_torque_threshold": grasp_torque_threshold,
    }
    assert set(data) == set(_SAVED_KEYS), "save schema drifted from the SDK's"
    return data


def write_calibration(path: str | os.PathLike[str], data: Mapping[str, Any]) -> str:
    """Write a calibration JSON file, creating parent directories."""
    target = Path(path).expanduser()
    if target.parent:
        target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(dict(data), indent=2), encoding="utf-8")
    return str(target)
