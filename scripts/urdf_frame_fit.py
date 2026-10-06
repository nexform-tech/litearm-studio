#!/usr/bin/env python3
"""Decide what kind of mismatch #56 is, from recorded samples.

This is step 3 of 3. Input is the JSON from `urdf_frame_collect.py` (or a
hand-made file with the same shape). Nothing here touches the arm; pure stdlib.

    python3 scripts/urdf_frame_fit.py /tmp/frame-samples.json

It answers one question with two tests:

**Test A — is the mismatch a fixed transform?** Do the URDF's poses and the
firmware's poses correspond under *one* rotation + translation, the same one for
every sample? That is the "the model is the same arm, mounted or tooled
differently" hypothesis. If it holds, the fix is a constant transform in the
viewport and no firmware source is needed.

**Test B — is the URDF even the same arm?** Are inter-sample distances preserved
between the two frames? A rigid transform preserves them; a different set of link
lengths or joint axes does not. This one needs no fitted parameters, so it cannot
be fooled by overfitting a single sample.

The printout ends with a verdict naming which fix (if any) is available. Read the
verdict, not the parameters: a low residual means "constant transform", a high one
means "no constant transform" and no amount of fitting is evidence to the contrary.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

Mat3 = list[list[float]]
Vec3 = list[float]

#: 残差在这个量级以内就当作"同一个刚体" —— 固件发的是 f32, 关节零位/回程差
#: 在真机上通常也有一两毫米, 所以 2mm 是"刚好能解释"的门槛而不是精确值。
CONGRUENT_MM = 2.0
#: 超过它就明确不是常数变换能解释的。
MISMATCH_MM = 20.0


# ── 线性代数 (纯 stdlib, 不依赖 numpy) ──────────────────────────────────────
def _jacobi_eig(a_in: Sequence[Sequence[float]], sweeps: int = 100) -> tuple[list[float], list[list[float]]]:
    """Eigen-decomposition of a symmetric matrix. Returns (values, matrix).

    The returned matrix's **columns** are the eigenvectors, in the same order as
    the values, which are not sorted. Works for any n; n=3 is used for the
    Procrustes rotation and n=4 for Horn's quaternion.
    """
    n = len(a_in)
    a = [list(row) for row in a_in]
    v = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    for _ in range(sweeps):
        p, q, off = 0, 1, 0.0
        for i in range(n):
            for j in range(i + 1, n):
                if abs(a[i][j]) > off:
                    off, p, q = abs(a[i][j]), i, j
        if off < 1e-15:
            break
        theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q])
        t = math.copysign(1.0, theta) / (abs(theta) + math.sqrt(theta * theta + 1.0))
        c, s = 1.0 / math.sqrt(t * t + 1.0), t / math.sqrt(t * t + 1.0)
        for k in range(n):
            akp, akq = a[k][p], a[k][q]
            a[k][p] = c * akp - s * akq
            a[k][q] = s * akp + c * akq
        for k in range(n):
            apk, aqk = a[p][k], a[q][k]
            a[p][k] = c * apk - s * aqk
            a[q][k] = s * apk + c * aqk
        for k in range(n):
            vkp, vkq = v[k][p], v[k][q]
            v[k][p] = c * vkp - s * vkq
            v[k][q] = s * vkp + c * vkq
    return [a[i][i] for i in range(n)], v


def _rot_from_quat(w: float, x: float, y: float, z: float) -> Mat3:
    n = math.sqrt(w * w + x * x + y * y + z * z)
    w, x, y, z = w / n, x / n, y / n, z / n
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]


def _nearest_rotation(m: Mat3) -> Mat3:
    """The orthogonal matrix closest to `m` (a projected average of rotations)."""
    h = [[sum(m[k][i] * m[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    vals, vecs = _jacobi_eig(h)
    order = sorted(range(3), key=lambda i: vals[i], reverse=True)
    col = [[vecs[r][order[c]] for c in range(3)] for r in range(3)]  # V, columns sorted by descending sigma
    # 保证 det=+1: 若 U 与 V 的行列式异号, 翻转最后一个奇异向量。
    u = [[sum(m[i][k] * col[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    if _det(u) < 0:
        for i in range(3):
            col[i][2] = -col[i][2]
        u = [[sum(m[i][k] * col[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    return [[sum(u[i][k] * col[j][k] for k in range(3)) for j in range(3)] for i in range(3)]


def _det(m: Mat3) -> float:
    return (
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    )


def _mat_vec(m: Mat3, v: Vec3) -> Vec3:
    return [sum(m[i][j] * v[j] for j in range(3)) for i in range(3)]


def _mat_mul(a: Mat3, b: Mat3) -> Mat3:
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def _transpose(m: Mat3) -> Mat3:
    return [[m[j][i] for j in range(3)] for i in range(3)]


def _mat_to_rpy_deg(r: Mat3) -> Vec3:
    """ZYX intrinsic, the firmware's convention (R = Rz(yaw)·Ry(pitch)·Rx(roll))."""
    sp = max(-1.0, min(1.0, -r[2][0]))
    pitch = math.asin(sp)
    if abs(math.cos(pitch)) > 1e-6:
        roll = math.atan2(r[2][1], r[2][2])
        yaw = math.atan2(r[1][0], r[0][0])
    else:  # 万向锁: 与固件 kin_rot_to_rpy 一致地强制 yaw=0
        roll, yaw = math.atan2(-r[1][2], r[1][1]), 0.0
    return [math.degrees(v) for v in (roll, pitch, yaw)]


def fit_rigid(src: Sequence[Vec3], dst: Sequence[Vec3]) -> tuple[Mat3, Vec3]:
    """The rotation Q and translation o minimising Σ‖Q·src + o − dst‖².

    Horn's absolute-orientation method: the optimal rotation is a unit quaternion,
    and that quaternion is the eigenvector of the 4x4 matrix `n` below belonging to
    its largest eigenvalue.
    """
    n = len(src)
    cs = [sum(p[i] for p in src) / n for i in range(3)]
    cd = [sum(p[i] for p in dst) / n for i in range(3)]
    a = [[p[i] - cs[i] for i in range(3)] for p in src]
    b = [[p[i] - cd[i] for i in range(3)] for p in dst]
    sxx = sum(a[k][0] * b[k][0] for k in range(n))
    sxy = sum(a[k][0] * b[k][1] for k in range(n))
    sxz = sum(a[k][0] * b[k][2] for k in range(n))
    syx = sum(a[k][1] * b[k][0] for k in range(n))
    syy = sum(a[k][1] * b[k][1] for k in range(n))
    syz = sum(a[k][1] * b[k][2] for k in range(n))
    szx = sum(a[k][2] * b[k][0] for k in range(n))
    szy = sum(a[k][2] * b[k][1] for k in range(n))
    szz = sum(a[k][2] * b[k][2] for k in range(n))
    n_mat = [
        [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
        [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
        [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
        [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
    ]
    vals, vecs = _jacobi_eig(n_mat)
    best = max(range(4), key=lambda i: vals[i])
    q = _rot_from_quat(vecs[0][best], vecs[1][best], vecs[2][best], vecs[3][best])
    o = [cd[i] - sum(q[i][j] * cs[j] for j in range(3)) for i in range(3)]
    return q, o


def fit_orientation(src: Sequence[Mat3], dst: Sequence[Mat3]) -> Mat3:
    """The rotation Q minimising Σ‖Q·src − dst‖² (left-sided Procrustes).

    The optimal Q is the mean of `dst_k · src_kᵀ`, projected back onto the
    rotations. For exactly-consistent data the mean is already a rotation, so the
    projection only removes f32 noise.
    """
    n = len(src)
    mean: Mat3 = [[0.0] * 3 for _ in range(3)]
    for k in range(n):
        product = _mat_mul(dst[k], _transpose(src[k]))
        for i in range(3):
            for j in range(3):
                mean[i][j] += product[i][j] / n
    return _nearest_rotation(mean)


# ── 报告 ────────────────────────────────────────────────────────────────────
def _mm(v: float) -> str:
    return f"{v * 1000.0:8.3f}"


def load_samples(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    samples = data.get("samples", data if isinstance(data, list) else [])
    usable = [s for s in samples if "get_tcp" in s and "urdf_fk" in s and "q" in s]
    return data, usable


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("samples", type=Path)
    ap.add_argument("--out", type=Path, default=None, help="also write the fitted transform as JSON")
    args = ap.parse_args()

    meta, usable = load_samples(args.samples)
    print(f"file: {args.samples}")
    if meta.get("firmware"):
        print(f"firmware: {meta['firmware']}   joints: {meta.get('n')}   samples: {len(meta.get('samples', []))}")
    if len(usable) < 2:
        print(f"\nonly {len(usable)} usable samples — need at least 2 (3+ to be meaningful)")
        return 2
    if any(not s.get("settled", True) for s in usable):
        print("⚠ some samples were recorded without settling; residuals may be motion noise, not geometry")

    urdf_pos = [s["urdf_fk"]["pos"] for s in usable]
    urdf_rot = [s["urdf_fk"]["rot"] for s in usable]
    fw_pos = [s["get_tcp"][:3] for s in usable]
    fw_rot = [
        [
            [
                math.cos(s["get_tcp"][5]) * math.cos(s["get_tcp"][4]),
                math.cos(s["get_tcp"][5]) * math.sin(s["get_tcp"][4]) * math.sin(s["get_tcp"][3]) - math.sin(s["get_tcp"][5]) * math.cos(s["get_tcp"][3]),
                math.cos(s["get_tcp"][5]) * math.sin(s["get_tcp"][4]) * math.cos(s["get_tcp"][3]) + math.sin(s["get_tcp"][5]) * math.sin(s["get_tcp"][3]),
            ],
            [
                math.sin(s["get_tcp"][5]) * math.cos(s["get_tcp"][4]),
                math.sin(s["get_tcp"][5]) * math.sin(s["get_tcp"][4]) * math.sin(s["get_tcp"][3]) + math.cos(s["get_tcp"][5]) * math.cos(s["get_tcp"][3]),
                math.sin(s["get_tcp"][5]) * math.sin(s["get_tcp"][4]) * math.cos(s["get_tcp"][3]) - math.cos(s["get_tcp"][5]) * math.sin(s["get_tcp"][3]),
            ],
            [
                -math.sin(s["get_tcp"][4]),
                math.cos(s["get_tcp"][4]) * math.sin(s["get_tcp"][3]),
                math.cos(s["get_tcp"][4]) * math.cos(s["get_tcp"][3]),
            ],
        ]
        for s in usable
    ]

    # ── 未拟合的基线: 原样对比 ──
    raw = [math.dist(urdf_pos[i], fw_pos[i]) for i in range(len(usable))]
    print("\n--- baseline (no mapping at all) ---")
    print(f"position error:  rms {_mm(math.sqrt(sum(v * v for v in raw) / len(raw)))} mm   max {_mm(max(raw))} mm")

    # ── Test A: 一个固定刚体变换能不能解释全部样本 ──
    q_pos, o_pos = fit_rigid(urdf_pos, fw_pos)
    resid_pos = [math.dist([sum(q_pos[i][j] * urdf_pos[k][j] for j in range(3)) + o_pos[i] for i in range(3)], fw_pos[k]) for k in range(len(usable))]
    q_rot = fit_orientation(urdf_rot, fw_rot)
    resid_rot = []
    for k in range(len(usable)):
        r = _mat_mul(q_rot, urdf_rot[k])
        rpy_a, rpy_b = _mat_to_rpy_deg(r), _mat_to_rpy_deg(fw_rot[k])
        resid_rot.append(
            math.degrees(
                math.acos(max(-1.0, min(1.0, (sum(r[i][j] * fw_rot[k][i][j] for i in range(3) for j in range(3)) - 1.0) / 2.0)))
            )
        )

    print("\n--- Test A: one fixed transform for every sample ---")
    print(f"position error:  rms {_mm(math.sqrt(sum(v * v for v in resid_pos) / len(resid_pos)))} mm   max {_mm(max(resid_pos))} mm")
    print(f"orientation err: rms {sum(resid_rot) / len(resid_rot):7.3f} °    max {max(resid_rot):7.3f} °")
    print(f"det(Q_pos) = {_det(q_pos):+.6f}  (must be +1.000000; −1 means the URDF is mirrored)")
    print(f"det(Q_rot) = {_det(q_rot):+.6f}")
    print("  per sample (mm / deg):")
    for k, s in enumerate(usable):
        print(f"    {str(s.get('index', k + 1)):>4}  {_mm(resid_pos[k])}  {resid_rot[k]:8.3f}")

    # ── Test B: 样本间距离是否守恒 (与拟合参数无关) ──
    dist_resid = []
    for i in range(len(usable)):
        for j in range(i + 1, len(usable)):
            dist_resid.append(abs(math.dist(urdf_pos[i], urdf_pos[j]) - math.dist(fw_pos[i], fw_pos[j])))
    print("\n--- Test B: inter-sample distances (parameter-free) ---")
    print(f"|d_urdf − d_firmware|:  rms {_mm(math.sqrt(sum(v * v for v in dist_resid) / len(dist_resid)))} mm   max {_mm(max(dist_resid))} mm")
    print(f"  (a rigid transform preserves these exactly; different link lengths do not)")

    # ── 判决 ──
    max_pos = max(resid_pos)
    if max_pos * 1000 <= CONGRUENT_MM and max(resid_rot) <= 1.0:
        verdict = "CONGRUENT"
        body = (
            f"One fixed transform explains all {len(usable)} samples "
            f"(max {max_pos * 1000:.2f} mm / {max(resid_rot):.2f}°).\n"
            "The URDF is the same arm as the firmware, mounted or tooled differently.\n"
            "The viewport fix is a constant transform, no firmware source needed."
        )
    elif max_pos * 1000 >= MISMATCH_MM:
        verdict = "NOT CONGRUENT"
        body = (
            f"No fixed transform fits (max {max_pos * 1000:.1f} mm / {max(resid_rot):.1f}°).\n"
            "The two models have different link geometry or joint axes, not just a\n"
            "different mount. A per-joint correction cannot fix this; the preview's\n"
            "joint model has to be replaced with the firmware's, or the preview has\n"
            "to stop being driven by raw joint values."
        )
    else:
        verdict = "INCONCLUSIVE"
        body = (
            f"Residuals are in between ({max_pos * 1000:.1f} mm / {max(resid_rot):.1f}°): too large for\n"
            "a clean constant transform, too small to call the models unrelated.\n"
            "Most likely causes: a sample taken mid-motion, backlash, or a joint\n"
            "whose axis direction differs. Re-record with more samples; if it is\n"
            "stable, treat it as NOT CONGRUENT."
        )
    print(f"\n=== VERDICT: {verdict} ===")
    print(body)

    if args.out:
        args.out.write_text(
            json.dumps(
                {
                    "samples": len(usable),
                    "verdict": verdict,
                    "position": {"Q": q_pos, "o_m": o_pos, "max_residual_mm": max_pos * 1000},
                    "orientation": {"Q": q_rot, "max_residual_deg": max(resid_rot)},
                    "scale_check": {"dist_rms_mm": math.sqrt(sum(v * v for v in dist_resid) / len(dist_resid)) * 1000},
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
