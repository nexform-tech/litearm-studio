#!/usr/bin/env python3
"""Record (joint angles, firmware TCP pose) pairs from a live arm — issue #56.

This is step 2 of 3. Step 1 (`urdf_frame_poses.py`) writes the poses; this script
drives the arm through them and records one sample per pose; step 3
(`urdf_frame_fit.py`) decides whether any fixed transform reconciles them.

It needs matplotlib? No. It needs `websockets` (the daemon's own dependency):

    /home/work/litearm/.venv/bin/python scripts/urdf_frame_collect.py \
        --poses /tmp/poses.json --out /tmp/frame-samples.json --speed 0.15

⚠ The arm moves. Check the workspace is clear before you press Enter, and use
   `--dry-run` first if you want to see the plan.

What one sample contains, and why each field is needed:

* `q`            — the joint vector the firmware reports back (radians), which is
                   the input to the URDF forward kinematics. Taken from the state
                   frame *after* settling, not from what we commanded, so a
                   rejected or clipped target cannot poison the record.
* `get_tcp`      — the firmware's own FK for that exact `q`: 3 positions (m) + 3
                   rpy (radians, ZYX intrinsic = Rz(yaw)·Ry(pitch)·Rx(roll), the
                   firmware's `kin_rpy_to_rot` convention).
* `cmd_q`        — what we asked for, kept so "the arm did not go there" is
                   visible in the file instead of being silently averaged away.
* `urdf_fk`      — the URDF's `ee_frame_link` pose for that same `q`, so step 3
                   does not have to re-parse the URDF or trust a second tool.
* `settled_s` / `samples_seen` — evidence that the pose was actually still when
                   it was recorded. A sample taken mid-motion is worse than no
                   sample, because it looks like a frame mismatch.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import websockets

DEFAULT_URDF = Path(__file__).resolve().parent.parent / "public" / "description" / "litearm.urdf"
DEFAULT_WS = "ws://127.0.0.1:8765/ws"

#: 到位判据: 全部关节速度低于它 (rad/s) 且与指令角之差小于容差。
SETTLE_DQ = 2e-2
SETTLE_DQ_ABS = 2e-2
#: 从"下发完成"到开始判定静止的最短观察时间 —— movej 的应答在固件受理后就回,
#: 而不是运动结束时, 所以必须靠状态帧判断真的停了。
MIN_OBSERVE_S = 0.3
#: 单条 movej 的最长等待。
MOVE_TIMEOUT_S = 60.0


# ── URDF 正运动学 (纯 stdlib; 与 urdf-loader 的语义一致: origin 的 rpy 是
#    Rz(yaw)·Ry(pitch)·Rx(roll), 关节绕自身 z 轴转 angle) ────────────────────
def _mat_mul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def _eye() -> list[list[float]]:
    return [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]


def _rpy_mat(r: float, p: float, y: float) -> list[list[float]]:
    cr, sr = math.cos(r), math.sin(r)
    cp, sp = math.cos(p), math.sin(p)
    cy, sy = math.cos(y), math.sin(y)
    return [
        [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
        [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
        [-sp, cp * sr, cp * cr],
    ]


def _axis_angle_mat(axis: list[float], angle: float) -> list[list[float]]:
    n = math.sqrt(sum(v * v for v in axis))
    k = [v / n for v in axis]
    kx = [[0.0, -k[2], k[1]], [k[2], 0.0, -k[0]], [-k[1], k[0], 0.0]]
    s, c = math.sin(angle), math.cos(angle)
    return [
        [
            (1.0 if i == j else 0.0)
            + s * kx[i][j]
            + (1.0 - c) * sum(kx[i][x] * kx[x][j] for x in range(3))
            for j in range(3)
        ]
        for i in range(3)
    ]


def _to4(rot: list[list[float]], xyz: list[float]) -> list[list[float]]:
    m = _eye()
    for i in range(3):
        for j in range(3):
            m[i][j] = rot[i][j]
        m[i][3] = xyz[i]
    return m


def load_chain(urdf: Path) -> list[tuple[str, str, list[float], list[float], list[float] | None]]:
    """(name, type, xyz, rpy, axis) for every joint, in document order."""
    root = ET.parse(urdf).getroot()
    chain = []
    for joint in root.iter("joint"):
        origin = joint.find("origin")
        axis_el = joint.find("axis")
        xyz = [float(v) for v in (origin.get("xyz") if origin is not None else "0 0 0").split()]
        rpy = [float(v) for v in (origin.get("rpy") if origin is not None else "0 0 0").split()]
        axis = (
            [float(v) for v in axis_el.get("xyz", "0 0 0").split()]
            if axis_el is not None
            else None
        )
        chain.append((joint.get("name") or "", joint.get("type") or "", xyz, rpy, axis))
    return chain


def urdf_ee_pose(
    chain: list[tuple[str, str, list[float], list[float], list[float] | None]],
    q: list[float],
) -> dict[str, list[float]]:
    """Pose of the last link (URDF `ee_frame_link`) for joint vector `q`."""
    t = _eye()
    revolute_index = 0
    for name, kind, xyz, rpy, axis in chain:
        t = _mat_mul(t, _to4(_rpy_mat(*rpy), xyz))
        if kind != "revolute":
            continue
        angle = q[revolute_index] if revolute_index < len(q) else 0.0
        revolute_index += 1
        if axis is not None and any(axis):
            t = _mat_mul(t, _to4(_axis_angle_mat(axis, angle), [0.0, 0.0, 0.0]))
    rot = [[t[i][j] for j in range(3)] for i in range(3)]
    return {"pos": [t[i][3] for i in range(3)], "rot": rot}


# ── daemon 会话 ─────────────────────────────────────────────────────────────
class Session:
    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self.next_id = 1
        self.state: dict[str, Any] | None = None
        self.conn: dict[str, Any] | None = None

    async def pump_until(self, predicate, timeout: float) -> bool:
        """Read frames until `predicate` is satisfied or the timeout expires."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=deadline - time.monotonic())
            except asyncio.TimeoutError:
                return False
            msg = json.loads(raw)
            if msg.get("t") == "state":
                self.state = msg["state"]
            elif msg.get("t") == "conn":
                self.conn = msg
            if predicate(msg):
                return True
        return False

    async def cmd(self, method: str, params: dict[str, Any] | None = None, timeout: float = MOVE_TIMEOUT_S):
        cid = self.next_id
        self.next_id += 1
        await self.ws.send(json.dumps({"t": "cmd", "id": cid, "m": method, "p": params or {}}))
        result: dict[str, Any] = {}

        def done(msg: dict[str, Any]) -> bool:
            if msg.get("t") == "res" and msg.get("id") == cid:
                result.update(msg)
                return True
            return False

        if not await self.pump_until(done, timeout):
            raise TimeoutError(f"{method} timed out after {timeout:.0f}s")
        if result.get("error"):
            raise RuntimeError(f"{method} failed: {result['error']}")
        return result.get("v")


async def wait_settled(session: Session, cmd_q: list[float], timeout: float) -> tuple[bool, float, int]:
    """Wait until the arm is still and at `cmd_q`. Returns (ok, seconds, frames)."""
    start = time.monotonic()
    frames = 0
    stable_since: float | None = None
    while time.monotonic() - start < timeout:
        await asyncio.sleep(0.05)
        st = session.state
        if st is None:
            continue
        frames += 1
        q = [float(v) for v in st.get("q", [])]
        dq = [float(v) for v in st.get("dq", [])]
        if len(q) != len(cmd_q) or len(dq) != len(cmd_q):
            continue
        still = max(abs(v) for v in dq) < SETTLE_DQ
        at_target = max(abs(q[i] - cmd_q[i]) for i in range(len(q))) < SETTLE_DQ_ABS
        if still and at_target and time.monotonic() - start > MIN_OBSERVE_S:
            if stable_since is None:
                stable_since = time.monotonic()
            elif time.monotonic() - stable_since >= 0.2:
                return True, time.monotonic() - start, frames
        else:
            stable_since = None
    return False, time.monotonic() - start, frames


async def run(args: argparse.Namespace) -> int:
    plan = json.loads(args.poses.read_text(encoding="utf-8"))
    poses = plan["poses"]
    chain = load_chain(args.urdf)
    n_urdf = sum(1 for _, kind, *_ in chain if kind == "revolute")

    samples: list[dict[str, Any]] = []
    async with websockets.connect(args.ws) as ws:
        session = Session(ws)
        await session.pump_until(lambda m: m.get("t") == "conn", 5.0)
        n = int((session.conn or {}).get("n") or 0) or n_urdf
        fw = (session.conn or {}).get("firmware") or "?"
        print(f"connected: n={n} firmware={fw}  (URDF has {n_urdf} revolute joints)")
        if n != n_urdf:
            print(f"refusing: the daemon reports {n} joints but the URDF has {n_urdf}")
            return 2

        enabled = bool((session.state or {}).get("enabled"))
        if not enabled:
            if args.dry_run:
                print("dry-run: arm is not enabled; would call enable() (does not move)")
            else:
                print("enabling (does not move the arm)")
                await session.cmd("enable", timeout=20.0)
                await session.pump_until(lambda m: (m.get("state") or {}).get("enabled") is True, 10.0)

        if args.dry_run:
            for p in poses:
                print(f"  pose {p['index']:>3}: q={[round(v, 3) for v in p['q']]}")
            print(f"dry-run: {len(poses)} poses, nothing was sent")
            return 0

        print(f"about to command {len(poses)} poses at speed {args.speed}. Ctrl-C stops the script;")
        print("the arm stays where it is (it does not abort the motion command).")
        if not args.yes:
            input("press Enter when the workspace is clear (Ctrl-C to abort): ")

        for pose in poses:
            q = [float(v) for v in pose["q"]]
            print(f"[{pose['index']:>3}/{len(poses)}] movej {[round(v, 2) for v in q]}", flush=True)
            try:
                await session.cmd("movej", {"q": q, "speed": args.speed})
            except (TimeoutError, RuntimeError) as exc:
                print(f"  skipped: {exc}")
                samples.append({"index": pose["index"], "cmd_q": q, "error": str(exc)})
                continue
            ok, settled_s, frames = await wait_settled(session, q, args.settle_timeout)
            if not ok:
                print(f"  did not settle within {args.settle_timeout:.0f}s; recording anyway (flagged)")
            state_q = [float(v) for v in (session.state or {}).get("q", [])]
            try:
                tcp = await session.cmd("get_tcp", timeout=5.0)
            except (TimeoutError, RuntimeError) as exc:
                print(f"  get_tcp failed: {exc}")
                samples.append({"index": pose["index"], "cmd_q": q, "error": f"get_tcp: {exc}"})
                continue
            if not isinstance(tcp, (list, tuple)) or len(tcp) < 6:
                print(f"  get_tcp returned {tcp!r}; skipping")
                samples.append({"index": pose["index"], "cmd_q": q, "error": "get_tcp empty"})
                continue
            tcp = [float(v) for v in tcp[:6]]
            samples.append(
                {
                    "index": pose["index"],
                    "cmd_q": q,
                    "q": state_q,
                    "get_tcp": tcp,
                    "urdf_fk": urdf_ee_pose(chain, state_q),
                    "settled": ok,
                    "settled_s": round(settled_s, 3),
                    "samples_seen": frames,
                }
            )
            print(f"  settled={ok} in {settled_s:.1f}s  tcp=({tcp[0]:+.4f},{tcp[1]:+.4f},{tcp[2]:+.4f})")

    usable = [s for s in samples if "get_tcp" in s and s.get("settled")]
    out = {
        "schema": 1,
        "daemon_ws": args.ws,
        "firmware": fw,
        "n": n,
        "speed": args.speed,
        "source_poses": str(args.poses),
        "urdf": str(args.urdf),
        "joint_names": plan.get("joint_names", []),
        "samples": samples,
        "usable": len(usable),
    }
    args.out.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"\nwrote {args.out}: {len(samples)} samples, {len(usable)} usable (settled)")
    if len(usable) < 3:
        print("⚠ fewer than 3 usable samples — step 3 needs at least 2, 3+ to be meaningful")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--poses", type=Path, required=True, help="from urdf_frame_poses.py")
    ap.add_argument("--out", type=Path, default=Path("frame-samples.json"))
    ap.add_argument("--ws", default=DEFAULT_WS)
    ap.add_argument("--urdf", type=Path, default=DEFAULT_URDF)
    ap.add_argument("--speed", type=float, default=0.15, help="movej speed (default 0.15, deliberately slow)")
    ap.add_argument("--settle-timeout", type=float, default=20.0, help="seconds to wait for each pose to settle")
    ap.add_argument("--dry-run", action="store_true", help="print the plan and exit without moving")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args()
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\ninterrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
