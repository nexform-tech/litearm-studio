/**
 * The 3D preview's default camera placement, as plain numbers.
 *
 * It lives apart from `RobotViewport.tsx` because the part that is easy to get
 * wrong — which way the base frame's X and Y axes read on screen — is decided
 * entirely by this one position, and a three.js scene is awkward to assert on in
 * a unit test. The component keeps the imperative half (framing the bounding box,
 * updating `OrbitControls`); this file decides where the eye sits.
 */

/** How far from the model the eye sits, as a multiple of the model's envelope. */
export const FRAME_DISTANCE_FACTOR = 1.72

/** Floor on that distance, so a tiny or half-loaded model does not fill the screen. */
export const MIN_FRAME_DISTANCE = 1.0

/**
 * The default view, looking **along the base frame's +X axis**.
 *
 * The model is a Z-up URDF, rotated into three.js' Y-up world by a single
 * `rotation.x = -PI / 2` on the root. That rotation maps a URDF vector
 * `(x, y, z)` to world `(x, z, -y)`, so base +X is world +X, base +Y is world
 * -Z, and base +Z is world +Y. The eye therefore sits on world -X — the far
 * side of the base — and looks toward +X. On that view:
 *
 * - base **+X recedes into the screen**, so the pad's 前/后 step away from and
 *   toward the operator, which is the direction the eye reads as "forward";
 * - base **+Y runs across the screen**, with +Y to the left, matching the pad's
 *   左/右;
 * - base +Z is up, as it is on the real arm.
 *
 * The previous placement — `(0.69d, ·, 0.69d)`, a 45° azimuth — split the two
 * horizontal axes into "toward the viewer" and "away from the viewer", which
 * project into nearly the same screen direction and separate only by depth. No
 * axis then reads as forward, so the pad's 前 moved the arm toward the operator
 * (#57).
 *
 * The elevation matches the old diagonal view (a 0.2d rise over a 0.69d
 * horizontal offset), so the vertical framing — looking slightly down on the
 * arm — is unchanged.
 *
 * Returns `null` for a degenerate box, which the caller must not frame.
 */
export function defaultPreviewView(
  distance: number,
  targetY: number,
): { position: [number, number, number]; target: [number, number, number] } | null {
  if (!(distance > 0)) return null
  // 0.69 is the old view's horizontal offset; folded onto the axis it becomes
  // the -X offset, so the eye keeps the elevation the diagonal view was tuned
  // for instead of drifting closer.
  const horizontal = distance * 0.69
  return {
    position: [-horizontal, targetY + distance * 0.2, 0],
    target: [0, targetY, 0],
  }
}
