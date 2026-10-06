#!/usr/bin/env python3
"""Generate the joint poses the URDF/firmware frame identification needs.

This is step 1 of 3 for issue #56. It only writes a JSON file; it never talks to
the arm. Deterministic, so the same file can be regenerated on another machine.

The poses are centred on the app's Ready Pose and spread each joint over a
fraction of its URDF limit, with a different sine frequency per joint so the
samples are not all correlated (a correlated set cannot tell "joint zero offset"
apart from "base frame rotated").

    python3 scripts/urdf_frame_poses.py gen-poses.json --count 28
"""
from __future__ import annotations

import argparse
import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

#: 与 `src/features/solo/soloUtils.ts` 的 HOME_JOINTS 一致 —— 采样围绕它展开，
#: 这样每条指令的开始与结束都在操作员熟悉的位置附近。
READY_POSE = [0.0, 0.5, 0.0, -1.0, 0.0, 0.6, 0.0]

DEFAULT_URDF = Path(__file__).resolve().parent.parent / "public" / "description" / "litearm.urdf"


def joint_limits(urdf: Path) -> list[tuple[str, float, float]]:
    """Every revolute joint's (name, lower, upper), in URDF document order."""
    root = ET.parse(urdf).getroot()
    out: list[tuple[str, float, float]] = []
    for joint in root.iter("joint"):
        if joint.get("type") != "revolute":
            continue
        limit = joint.find("limit")
        if limit is None:
            continue
        out.append(
            (
                joint.get("name") or "",
                float(limit.get("lower", "-1")),
                float(limit.get("upper", "1")),
            )
        )
    return out


def gen_poses(count: int, amplitude: float, limits: list[tuple[str, float, float]]) -> list[dict]:
    """`count` joint vectors, each joint sampled over its own limit."""
    n = len(limits)
    poses: list[dict] = []
    for i in range(count):
        # 每个关节一个不同的正弦频率 (j 与 j+1..j+5): 7 个关节在同一批样本里
        # 取到互不相同的相位组合, 单关节单独动和整臂联动都覆盖到。
        freqs = [i + 1, i + 2, (i + 1) + 3, (i + 1) + 4, (i + 1) + 5, i + 3, i + 4]
        q: list[float] = []
        for j, (_, lo, hi) in enumerate(limits):
            centre = READY_POSE[j] if j < len(READY_POSE) else 0.0
            half_range = min(abs(lo - centre), abs(hi - centre))
            reach = half_range * amplitude
            q.append(round(centre + reach * math.sin(freqs[j] * 2.0 * math.pi * i / count), 6))
        poses.append(
            {
                "index": i + 1,
                "q": q,
                "note": f"sine i={i + 1} amplitude={amplitude}",
            }
        )
    return poses


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", type=Path, help="where to write the pose file")
    ap.add_argument("--count", type=int, default=28, help="how many poses (default 28)")
    ap.add_argument("--amplitude", type=float, default=0.6, help="fraction of each joint's limit to use (default 0.6)")
    ap.add_argument("--urdf", type=Path, default=DEFAULT_URDF)
    args = ap.parse_args()

    limits = joint_limits(args.urdf)
    if not limits:
        print(f"no revolute joints found in {args.urdf}")
        return 1
    poses = gen_poses(args.count, args.amplitude, limits)
    args.out.write_text(
        json.dumps(
            {
                "schema": 1,
                "source": str(args.urdf),
                "joint_names": [name for name, _, _ in limits],
                "joint_limits": [[lo, hi] for _, lo, hi in limits],
                "ready_pose": READY_POSE[: len(limits)],
                "poses": poses,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote {len(poses)} poses to {args.out}")
    print(f"joints: {', '.join(name for name, _, _ in limits)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
