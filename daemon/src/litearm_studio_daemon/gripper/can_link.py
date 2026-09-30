"""Raising the SocketCAN interface, so that 连接 does not need a terminal.

Opening a CAN interface is a privileged operation, and the SDK cannot open one
that is down.  Until now the operator's only route was a terminal and a sudo
password — the README says so — and that is a poor thing to ask of someone who
has just plugged a USB-CAN adapter in and pressed 连接.  This module is what runs
behind that button instead.

Three rules shape it.

*It is a convenience, not a gate.*  Nothing here may prevent the console from
trying to connect.  The interface may already be up because the operator manages
it by hand, because a systemd unit does, or because this is a virtual bus with
nothing to configure; in all three cases the attempt is still the only thing that
knows whether the link works.  Every problem this module finds is reported and
then dropped.

*It changes as little as possible.*  The interface is probed first, and when it
is already in the state the SDK needs, no privileged command runs at all and no
password dialog appears.  Only a state that is actually wrong is corrected —
which is what makes this livable as an automatic step on every connect.  An
interface configured for CAN FD is reported and then left alone even when its
bitrate differs, because the SDK drives FD by itself (it reads the interface MTU
and picks the frame format) and "correcting" it would mean rewriting a bus that
other nodes are also on, on the strength of a guess.

*The device name never reaches a shell as text.*  The privileged half is one
fixed script, and the interface name and bitrate are handed to it as positional
arguments.  A name that is not a plausible interface name is refused before any
command is built, so the worst a hostile ``--can-channel`` can do is be rejected.

Privilege is obtained with ``pkexec`` (the desktop's own polkit dialog) rather
than by handling a password here: this process never sees one, cannot log one,
and cannot leak one.
"""

from __future__ import annotations

import errno
import logging
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from . import constants

log = logging.getLogger(__name__)

#: What an interface name may look like.  Deliberately narrow: it is the one
#: piece of this module that comes from outside, and although it is passed as an
#: argument rather than spliced into the script, refusing implausible names early
#: keeps the guarantee independent of how the script is written.
DEVICE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$")

#: The privileged half, as one script.  ``$1`` is the interface, ``$2`` the
#: bitrate and ``$3`` the ``restart-ms``; none is interpolated into this text, so
#: shell metacharacters in a device name (which :data:`DEVICE_RE` has already
#: rejected) could not execute even if that check were to fail.
#:
#: The order is the one the README documents: a CAN bitrate cannot be changed
#: while the link is up, so it goes down first.  ``restart-ms`` is what stops a
#: bus-off controller from staying off (see
#: :data:`~litearm_studio_daemon.gripper.constants.CAN_LINK_RESTART_MS`), but it
#: is hardening rather than a requirement, and not every driver has it: the
#: ``gs_usb`` adapters this product ships with reject the keyword outright
#: ("Device doesn't support restart from Bus Off"), and the kernel restarts those
#: controllers itself.  ``restart-ms`` is therefore *attempted* first and dropped
#: on that one refusal — but the link is brought up either way.
#:
#: That ``either way`` is the point.  The obvious script — ``set -e``, ``down``,
#: ``type can … restart-ms …``, ``up`` — aborts on the rejected keyword *after*
#: the interface is already down, so a repair attempt turns a working-but-
#: misconfigured link into an unusable one.  The two settings are also one
#: command rather than two: a retry after a failed ``type can`` would need either
#: a second password dialog or a real config rollback, so a refusal is detected
#: before the interface is touched.  Any *other* failure is allowed to reach the
#: caller as a nonzero exit, which :meth:`CanLink.ensure` already turns into
#: ``LINK_FAILED`` plus the manual hint.  ``fd off`` matches the classic CAN the
#: rest of this console assumes (the SDK auto-detects FD on its own, but nothing
#: here configures a data bitrate); :meth:`CanLink.ensure` never reaches this
#: script for an FD bus, so there is no ``fd off`` to drop.
#:
#: The refusal is matched with a shell ``case`` rather than ``grep``: ``pkexec``
#: runs this in a minimal environment, and staying inside the shell keeps the
#: script free of commands that a stripped-down PATH might not carry.
SCRIPT = (
    "set -e\n"
    'dev="$1"\n'
    'ip link set "$dev" down\n'
    'opts="bitrate $2 fd off"\n'
    'case "$3" in\n'
    '  0|"") ;;\n'
    '  *) if out=$(ip link set "$dev" type can bitrate "$2" restart-ms "$3" fd off 2>&1); then\n'
    '       opts="bitrate $2 restart-ms $3 fd off"\n'
    '     else\n'
    '       case "$out" in\n'
    '         *"restart from Bus Off"*) ;;\n'
    '         *) printf "%s\\n" "$out" >&2; exit 1 ;;\n'
    "       esac\n"
    '     fi ;;\n'
    "esac\n"
    'ip link set "$dev" type can $opts\n'
    'ip link set "$dev" up\n'
)

#: ``sh`` and not ``pkexec``-ing the three ``ip`` commands one at a time: each
#: ``pkexec`` invocation is authorized separately, and three password dialogs in
#: a row is not a feature.  This is an ELF binary at a fixed path, which is what
#: pkexec expects to be handed.
SHELL = "/bin/sh"

#: The argv[0] the script sees.  It ends up in shell error messages.
SCRIPT_NAME = "litegrip-can"

#: ``ip``, and the two states of the probe's answer.
IP = "ip"

LINK_OK = "ok"
"""Already in the state the SDK needs.  Nothing was run."""

LINK_CONFIGURED = "configured"
"""It was wrong, and it has been fixed."""

LINK_MISSING = "missing"
"""No such interface — the adapter is unplugged, or its driver is not loaded."""

LINK_FD = "fd"
"""Configured for CAN FD, which this console does not touch.

Not a problem: the SDK reads the interface MTU and switches to FD frames by
itself, so an FD bus may well work as it stands. What this console will not do is
downgrade it — ``fd off`` would change a bus that is shared with whatever else is
on it, on the strength of a guess.
"""

LINK_DENIED = "denied"
"""The operator dismissed the authorization dialog, or was not authorized."""

LINK_FAILED = "failed"
"""The command ran and did not work, or could not be run at all."""

#: The controller's own state, read off the ``can state`` line that only
#: ``ip -details`` prints.  ``ERROR-ACTIVE`` is the healthy one.  ``ERROR-PASSIVE``
#: is not repaired — a controller in it can still transmit, and it recovers on
#: its own once the bus does — but it is reported, because it is what a bus with
#: a marginal partner looks like.  ``BUS-OFF`` is repaired: after 256 failed
#: acknowledgements the controller takes itself off the bus and *every* send then
#: fails with ENETDOWN, whatever the ``UP`` flag says.
CAN_ERROR_ACTIVE = "ERROR-ACTIVE"
CAN_ERROR_PASSIVE = "ERROR-PASSIVE"
CAN_BUS_OFF = "BUS-OFF"

#: pkexec(1): 126 for a dismissed dialog, 127 for anything else that stopped the
#: authorization.  Both mean the same thing here — no privilege, no change — and
#: the distinction is kept only for the message.
PKEXEC_DISMISSED = 126
PKEXEC_NOT_AUTHORIZED = 127

#: ``ARPHRD_CAN``, the ``type`` value ``/sys/class/net/<dev>/type`` reports for a
#: SocketCAN interface.  Enumerating through this rather than trying ``can0``,
#: ``can1``, ``can2`` is what lets a machine whose adapter the driver called
#: ``can3``, or ``vcan0``, be configured without editing code.
ARPHRD_CAN = 280

#: Where the kernel keeps the per-interface attributes.  Overridable so the
#: enumeration can be tested against a fake tree instead of the test machine's
#: real interfaces.
SYS_CLASS_NET = "/sys/class/net"


def list_channels(sys_class_net: str = SYS_CLASS_NET) -> list[str]:
    """Every CAN interface the kernel knows about, sorted by name.

    Reads ``/sys/class/net/*/type`` and keeps the entries whose value is
    ``ARPHRD_CAN`` (280).  A missing or unreadable ``/sys/class/net`` returns an
    empty list rather than raising: a machine with no CAN support has no
    channels, which is a fact the UI shows rather than an error to handle.
    """
    root = Path(sys_class_net)
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return []
    out: list[str] = []
    for entry in entries:
        try:
            value = (entry / "type").read_text(encoding="ascii").strip()
        except OSError:
            continue
        try:
            if int(value) == ARPHRD_CAN:
                out.append(entry.name)
        except ValueError:
            continue
    return out


@dataclass(frozen=True)
class LinkState:
    """What ``ip -details link show <dev>`` said about the interface."""

    exists: bool
    up: bool = False
    bitrate: int | None = None
    fd: bool = False
    can_state: str = ""
    """``ERROR-ACTIVE`` / ``ERROR-PASSIVE`` / ``BUS-OFF`` / ``STOPPED``.

    Empty when ``ip`` did not say — a device that is not a CAN interface, or a
    version whose ``can state`` line this does not recognise.  An empty value
    never triggers anything: silence is not evidence of a fault.
    """
    restart_ms: int | None = None
    """The bus-off restart delay ``ip`` reports, or ``None`` if it did not say.

    Reported, never demanded: ``matches`` deliberately ignores it.  A ``gs_usb``
    adapter rejects ``restart-ms`` and the kernel restarts its controller itself,
    so requiring a non-zero value here would send every connect on the hardware
    this product ships with through a repair that cannot set it.  It is kept so
    that :meth:`describe` can say what the driver actually has.
    """

    def matches(self, bitrate: int) -> bool:
        """Is this the state the SDK needs?  If so, nothing has to happen.

        Only the properties the gripper needs to talk: the interface exists, is
        administratively up, carries the bitrate asked for, is classic CAN, and
        the controller is not off the bus.  ``restart_ms`` is not among them —
        see the field's docstring.
        """
        return (
            self.exists
            and self.up
            and self.bitrate == bitrate
            and not self.fd
            and not self.deaf
        )

    @property
    def deaf(self) -> bool:
        """Bus-off: unable to transmit, however healthy the flags look.

        This is the state that made the console lie.  ``ip`` still prints
        ``UP,LOWER_UP`` and the bitrate it was configured with, so every field
        this module used to look at reads correct, the interface is left alone,
        and the first frame that tries to leave comes back as ENETDOWN — which
        the SDK passes through as its own message.  Reading the controller's
        state is what tells the two apart.
        """
        return self.can_state == CAN_BUS_OFF

    def describe(self) -> str:
        if not self.exists:
            return "不存在"
        if self.bitrate is None:
            return "已 up，但未配置比特率" if self.up else "已存在，未配置比特率，未 up"
        mode = "CAN FD" if self.fd else "经典 CAN"
        # The restart delay is reported verbatim when ``ip`` prints it.  It is not
        # a requirement (see ``matches``): ``gs_usb`` prints ``0`` because it has no
        # such knob, and a driver that carries it prints what it was set to, so the
        # number answers "which of the two is this" without this module guessing.
        restart = f"，bus-off 重启 {self.restart_ms}ms" if self.restart_ms is not None else ""
        # The controller's state is worth printing whenever it is not the healthy
        # one — including ERROR-PASSIVE, which is not repaired and would
        # otherwise be invisible in a message that reads like everything is fine.
        trouble = (
            f"，控制器 {self.can_state}"
            if self.can_state and self.can_state != CAN_ERROR_ACTIVE
            else ""
        )
        return (
            f"{'已 up' if self.up else '未 up'}，{mode}，比特率 {self.bitrate}"
            f"{restart}{trouble}"
        )


def parse_link(text: str, returncode: int = 0) -> LinkState:
    """Read ``ip``'s answer.

    Pure, and the only place that knows the shape of that output, so the awkward
    cases — a device that does not exist, one that exists but has never been
    given a bitrate, one running CAN FD — are pinned by tests on real
    transcripts rather than discovered on the bench.

    ``text`` is ``ip``'s stdout and stderr together: the "does not exist" answer
    is a nonzero exit with everything on stderr, and both readers want the same
    answer.
    """
    if returncode != 0 or "does not exist" in text:
        return LinkState(exists=False)

    # The flags between <> carry the administrative state: "UP" there means
    # `ip link set <dev> up` has been done.  The `state UP` further along is the
    # operational state, which for CAN depends on whether anything is on the bus.
    flags: set[str] = set()
    opening = text.find("<")
    closing = text.find(">", opening + 1)
    if opening != -1 and closing != -1:
        flags = {flag.strip() for flag in text[opening + 1 : closing].split(",")}

    # ``\b`` anchors this to a word boundary, because an FD interface prints
    # "bitrate 1000000 dbitrate 2000000" and the nominal bitrate is the one this
    # console uses.  ip happens to print the nominal one first, so the anchor is
    # not what makes today's transcript read correctly — it is what keeps the
    # reading from depending on that order.
    found = re.search(r"\bbitrate (\d+)", text)
    bitrate = int(found.group(1)) if found else None
    # "fd on" only appears when FD is on; classic CAN prints no fd keyword at
    # all.  So an interface that names a bitrate and does not say "fd on" is a
    # classic one — which is what the probe is for.
    fd = re.search(r"\bfd on\b", text) is not None
    # ``can state`` and not ``state``: the line above it carries the operstate,
    # whose value for CAN depends on whether anything is on the bus — reading
    # that one would call a working interface down (see the ``lo`` transcript).
    # ``can state`` is the controller's own answer, and it is the only line that
    # distinguishes a bus-off interface from a working one.
    state_line = re.search(r"\bcan state (\S+)", text)
    can_state = state_line.group(1) if state_line else ""
    # The delay sits at the end of that same ``can state`` line ("can state
    # ERROR-ACTIVE restart-ms 100").  ``\b`` keeps this from reading the
    # ``restart-ms`` of some other interface if ``ip`` ever prints more than one.
    restart_line = re.search(r"\brestart-ms (\d+)", text)
    restart_ms = int(restart_line.group(1)) if restart_line else None

    return LinkState(
        exists=True,
        up="UP" in flags,
        bitrate=bitrate,
        fd=fd,
        can_state=can_state,
        restart_ms=restart_ms,
    )


def manual_hint(device: str, bitrate: int) -> str:
    """The commands an operator can paste instead, and what the alerts quote.

    The same three commands the README documents, in the same order, so that a
    failure here leads to the procedure the operator may already know — and the
    ones that work on every driver.  ``restart-ms`` is deliberately **not** in
    here: the ``gs_usb`` adapters this product ships with refuse the keyword, and
    an operator who pastes a hint has no ``set -e``-free retry to fall back on —
    the ``down`` and the ``up`` are joined by ``&&``, so a refusal leaves the
    interface down.  Where the driver does support it, the daemon's own script
    still applies it; the hint is the lowest common denominator.
    """
    return (
        f"sudo ip link set {device} down && "
        f"sudo ip link set {device} type can bitrate {bitrate} fd off && "
        f"sudo ip link set {device} up"
    )


@dataclass(frozen=True)
class LinkOutcome:
    """What happened, in the two forms the caller needs."""

    state: str
    detail: str
    before: LinkState | None = None
    after: LinkState | None = None

    @property
    def needs_attention(self) -> bool:
        """Worth interrupting the operator about, as opposed to logging.

        A link that was raised is a privileged thing that just happened, so it is
        logged; it is not a problem, so it does not raise a banner.
        """
        return self.state in (LINK_MISSING, LINK_DENIED, LINK_FAILED)


class CanLink:
    """Puts the interface into the state the SDK needs, once per connect."""

    def __init__(
        self,
        channel: str = constants.CAN_CHANNEL,
        bitrate: int = constants.CAN_BITRATE,
        *,
        run: Callable[[Sequence[str], float], subprocess.CompletedProcess] | None = None,
        which: Callable[[str], str | None] | None = None,
    ) -> None:
        self.channel = channel
        self.bitrate = int(bitrate)
        self._run = run or self._run_process
        self._which = which or shutil.which

    # ── the one entry point ─────────────────────────────────────────────────
    def ensure(self) -> LinkOutcome:
        """Probe, decide, and only then ask for privilege.

        Returns rather than raises for everything it can anticipate.  It may
        still raise if a subprocess misbehaves in a way not anticipated here; the
        worker treats that as one more thing not to fail the connection over.
        """
        problem = self._implausible()
        if problem is not None:
            return LinkOutcome(LINK_FAILED, problem)

        tools = self._tools()
        if tools is None:
            return LinkOutcome(LINK_FAILED, self._no_tools_message())

        ip, pkexec = tools
        before = self.probe(ip)
        if before.matches(self.bitrate):
            return LinkOutcome(
                LINK_OK,
                f"{self.channel} 已就绪（{before.describe()}），未改动",
                before=before,
                after=before,
            )
        if not before.exists:
            # No manual command is offered here, on purpose: the three that
            # would be quoted all fail on a device that does not exist, and a
            # hint that cannot work is worse than none.  What is worth saying is
            # the cause, and how to find out whether it is the cause or the name
            # — ``--can-channel`` naming an adapter the driver called can1 looks
            # exactly like an unplugged one from here.
            return LinkOutcome(
                LINK_MISSING,
                f"{self.channel} 不存在：USB-CAN 没插上，或者它的驱动没加载"
                f"（也可能是名字不对，用「ip link」看系统里叫什么）。"
                "连接仍会尝试，失败时请检查硬件",
                before=before,
            )

        if before.fd:
            # Deliberately not corrected, even when the bitrate differs.  The SDK
            # reads the interface MTU (72 = FD) and drives FD frames on its own,
            # so this bus may be exactly what its owner wants.  Correcting it
            # would mean ``fd off``, which changes a bus shared with every other
            # node on it — and the case for the bitrate repair does not carry
            # over: there the console is certain the link cannot work, here it is
            # not certain of anything.
            return LinkOutcome(
                LINK_FD,
                f"{self.channel} 已配置为 CAN FD（{before.describe()}），未改动："
                "改它会把总线上其他节点也一起改掉。SDK 会自己按 FD 通信，"
                "若连接失败请手动配置这个接口",
                before=before,
                after=before,
            )

        argv = [
            pkexec,
            SHELL,
            "-c",
            SCRIPT,
            SCRIPT_NAME,
            self.channel,
            str(self.bitrate),
            str(constants.CAN_LINK_RESTART_MS),
        ]
        result = self._run(argv, constants.CAN_LINK_SETUP_TIMEOUT_S)

        # A nonzero exit means the privileged half did not run, and the two
        # reasons for that are worth telling apart: a dismissed dialog is the
        # operator's decision and leaves the interface alone, while a script that
        # ran and failed is a fault.  Neither is the same as "the state is still
        # wrong", which is why the success path below does not trust this code
        # either — the bus is asked again, and that answer is the one reported.
        if result.returncode:
            reason = self.denied_reason(result.returncode, result.stderr or "")
            denied = result.returncode in (PKEXEC_DISMISSED, PKEXEC_NOT_AUTHORIZED)
            return LinkOutcome(
                LINK_DENIED if denied else LINK_FAILED,
                f"{self.channel} 未被改动：{reason}。"
                f"手动执行：{manual_hint(self.channel, self.bitrate)}",
                before=before,
            )

        after = self.probe(ip)
        if after.matches(self.bitrate):
            return LinkOutcome(
                LINK_CONFIGURED,
                f"{self.channel} 原为「{before.describe()}」，已配置为"
                f"比特率 {self.bitrate} 并 up",
                before=before,
                after=after,
            )
        if after.deaf:
            # Raised and configured, and still off the bus.  That is an answer,
            # and it is the one worth the extra sentence: a controller only
            # reaches bus-off by sending frames nobody acknowledged, so the
            # problem is on the other side of the wire rather than in the
            # interface — and the console cannot tell which of those it is, but
            # it can name all three.
            return LinkOutcome(
                LINK_FAILED,
                f"{self.channel} 已重新配置并 up，但控制器仍是总线关闭（BUS-OFF）："
                "发出去的帧没有任何节点应答。驱动器没上电、比特率不是 "
                f"{self.bitrate}，或者接线与终端电阻有问题。"
                f"手动执行：{manual_hint(self.channel, self.bitrate)}",
                before=before,
                after=after,
            )
        return LinkOutcome(
            LINK_FAILED,
            f"{self.channel} 配置后仍不是期望状态（现在是「{after.describe()}」）。"
            f"手动执行：{manual_hint(self.channel, self.bitrate)}",
            before=before,
            after=after,
        )

    def probe(self, ip: str | None = None) -> LinkState:
        """Ask the kernel what the interface looks like.  Unprivileged."""
        binary = ip or (self._which(IP) or IP)
        result = self._run(
            [binary, "-details", "link", "show", self.channel],
            constants.CAN_LINK_PROBE_TIMEOUT_S,
        )
        text = f"{result.stdout or ''}{result.stderr or ''}"
        return parse_link(text, result.returncode or 0)

    @property
    def hint(self) -> str:
        """The manual equivalent, for a message that has to stand alone."""
        return manual_hint(self.channel, self.bitrate)

    # ── internals ───────────────────────────────────────────────────────────
    def _implausible(self) -> str | None:
        if not DEVICE_RE.match(self.channel or ""):
            return (
                f"接口名「{self.channel}」不像一个网络接口名，不会拿它去提权。"
                "用 --can-channel 指定，例如 can0"
            )
        if not constants.CAN_BITRATE_MIN <= self.bitrate <= constants.CAN_BITRATE_MAX:
            return (
                f"比特率 {self.bitrate} 超出 ip 接受的范围 "
                f"({constants.CAN_BITRATE_MIN}–{constants.CAN_BITRATE_MAX})，"
                "不会拿它去提权"
            )
        return None

    def _tools(self) -> tuple[str, str] | None:
        ip = self._which(IP)
        pkexec = self._which("pkexec")
        if not ip or not pkexec:
            return None
        return ip, pkexec

    def _no_tools_message(self) -> str:
        return (
            f"找不到 ip 或 pkexec，无法自动准备 {self.channel}。"
            f"手动执行：{self.hint}"
        )

    def _run_process(
        self, argv: Sequence[str], timeout_s: float
    ) -> subprocess.CompletedProcess:
        """Run it, and turn every way it can fail into a result.

        There is no shell here and no string command: ``argv`` is a list, always.
        """
        try:
            return subprocess.run(  # noqa: S603 - fixed argv, no shell
                list(argv),
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired:
            # The realistic cause is an authorization dialog nobody answered.
            log.warning("命令超时（%.0f s）：%s", timeout_s, argv[0])
            return subprocess.CompletedProcess(
                list(argv), PKEXEC_NOT_AUTHORIZED, "", f"等待超过 {timeout_s:.0f} 秒未完成"
            )
        except OSError as exc:
            log.warning("无法执行 %s：%s", argv[0], exc)
            return subprocess.CompletedProcess(list(argv), 127, "", str(exc))

    @staticmethod
    def denied_reason(returncode: int, stderr: str) -> str:
        """Why the privileged half did not happen, in words.

        ``pkexec`` is the only thing that normally produces these codes, and
        saying which of the two it was saves the operator from wondering whether
        they mistyped a password or were refused outright.
        """
        if returncode == PKEXEC_DISMISSED:
            return "已取消授权（未改动接口）"
        if returncode == PKEXEC_NOT_AUTHORIZED:
            return f"授权未通过：{stderr.strip() or 'pkexec 未授权'}"
        return stderr.strip() or f"命令以 {returncode} 退出"


# ═══════════════════════════════════════════════════════════════════════════
# Reading a transport failure
# ═══════════════════════════════════════════════════════════════════════════

#: ``OSError`` numbers that mean "this interface cannot carry a frame right now"
#: rather than "the motor did something".  ``ENETDOWN`` is what ``send`` returns
#: for a down or bus-off controller; the other two are the interface having
#: disappeared underneath an already-open socket — the adapter unplugged, or its
#: driver reloaded and the name reassigned.
LINK_ERRNOS = frozenset({errno.ENETDOWN, errno.ENXIO, errno.ENODEV})

#: The same numbers as ``OSError.__str__`` writes them.  Needed because the SDK
#: stringifies the exception in places (``HardwareError(f"使能失败: {e}")``), and
#: matching the number rather than the text after it is deliberate: that text is
#: localised, so "Network is down" and "网络已断开" are the same failure and only
#: this form is the same in both.
_ERRNO_TEXT = re.compile(r"\[Errno (\d+)\]")


def link_failure(exc: BaseException, channel: str = "") -> str | None:
    """Why a transport error is the CAN interface's fault, or ``None``.

    An ``ENETDOWN`` reaching the operator as the SDK's own words is what this
    exists to end: "使能失败: [Errno 100] 网络已断开" names neither the interface
    nor what to do about it, and 100 is not even a motor code — it is the kernel
    saying the interface cannot send.  The caller turns a hit here into a
    :class:`~litearm_studio_daemon.gripper.backend.LinkDown`, which the GUI shows as a link
    problem instead of a motor one.

    The chain walk comes first because that is where the errno actually lives
    after the SDK wraps it: ``raise HardwareError(...)`` inside an ``except``
    sets ``__context__``, and ``__cause__`` is set when it chains explicitly.
    Both are followed, with a visited set so a cycle cannot hang the tick.
    """
    seen: set[int] = set()
    node: BaseException | None = exc
    while node is not None and id(node) not in seen:
        seen.add(id(node))
        if isinstance(node, OSError) and node.errno in LINK_ERRNOS:
            return _link_message(int(node.errno), channel)
        node = node.__cause__ if node.__cause__ is not None else node.__context__

    found = _ERRNO_TEXT.search(str(exc))
    if found is not None and int(found.group(1)) in LINK_ERRNOS:
        return _link_message(int(found.group(1)), channel)
    return None


def _link_message(number: int, channel: str) -> str:
    where = channel or "CAN 接口"
    name = errno.errorcode.get(number, f"errno {number}")
    return (
        f"{where} 发不出帧（{name}）：接口未 up、适配器被拔掉，或者控制器处于"
        "总线关闭。请检查适配器与接线，然后重新连接——连接时会自动重新配置接口"
    )
