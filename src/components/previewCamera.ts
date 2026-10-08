/**
 * The 3D preview's default camera placement, as plain numbers.
 *
 * It lives apart from `RobotViewport.tsx` because the part that is easy to get
 * wrong — which way the base frame's X and Y axes read on screen — is decided
 * entirely by this one position, and a three.js scene is awkward to assert on in
 * a unit test. The component keeps the imperative half (framing the bounding box,
 * updating `OrbitControls`); this file decides where the eye sits.
 */

/** Vertical field of view of the preview camera, in degrees (`RobotViewport`). */
export const PREVIEW_FOV_DEG = 45

/** Floor on the eye distance, so a tiny or half-loaded model does not fill the screen. */
export const MIN_FRAME_DISTANCE = 1.0

/** Air left around the envelope. The fit distance is multiplied by this. */
export const FRAME_MARGIN = 1.25

/**
 * Eye offset as a multiple of the distance. The default view and the fit below
 * both read these two numbers, so the eye can only ever move along the single
 * ray the view direction was tuned for.
 */
const EYE_HORIZONTAL = 0.69
const EYE_RISE = 0.2

/** Length of the eye-to-target ray, and the camera basis it implies. */
const RAY = Math.hypot(EYE_HORIZONTAL, EYE_RISE)
/** Forward (eye → target) unit vector; the eye sits on the +ray side of the target. */
const F = { x: EYE_HORIZONTAL / RAY, y: -EYE_RISE / RAY }
/** Screen-up, `cross(right, forward)` with `right = cross(forward, worldUp) = +Z`. */
const U = { x: -F.y, y: F.x }

/** The model's envelope, after `frameRobot` recentres it (x/z centred, `min.y` at 0). */
export type Envelope = { x: number; y: number; z: number }

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
 * ⚠ `distance` is not the eye-to-target distance: it is the offset scale, so the
 * eye sits `RAY * distance` away. Both this function and `fitFrameDistance`
 * speak that same unit.
 *
 * Returns `null` for a degenerate distance, which the caller must not frame.
 */
export function defaultPreviewView(
  distance: number,
  targetY: number,
): { position: [number, number, number]; target: [number, number, number] } | null {
  if (!(distance > 0)) return null
  // 0.69 is the old view's horizontal offset; folded onto the axis it becomes
  // the -X offset, so the eye keeps the elevation the diagonal view was tuned
  // for instead of drifting closer.
  return {
    position: [-distance * EYE_HORIZONTAL, targetY + distance * EYE_RISE, 0],
    target: [0, targetY, 0],
  }
}

/**
 * Offset scale at which the **whole envelope** fits the current frustum.
 *
 * The old fixed factor (1.72 × the envelope's longest side) framed the diagonal
 * view but cut the arm's top off: the 0.2d rise aims the eye roughly 16° down,
 * so the top of a full-height arm projects past the upper edge of a 45° frame
 * (23.7° against a 22.5° half angle), and a narrow viewport narrows the
 * horizontal frame on top of that. Solving for the offset keeps the documented
 * direction and only moves the eye back along it.
 *
 * Depth and the two perpendicular offsets of a corner are affine in the offset,
 * so each corner's "inside the frustum" requirement solves in closed form; the
 * answer is the strictest corner. `aspect` is the viewport's width/height (a
 * degenerate value falls back to 1 rather than producing Infinity).
 */
export function fitFrameDistance(
  size: Envelope,
  aspect: number,
  fovDeg: number = PREVIEW_FOV_DEG,
  margin: number = FRAME_MARGIN,
): number {
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360)
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const cy = size.y / 2

  let required = MIN_FRAME_DISTANCE
  for (const px of [-size.x / 2, size.x / 2]) {
    for (const py of [0, size.y]) {
      for (const pz of [-size.z / 2, size.z / 2]) {
        const ax = px
        const ay = py - cy
        // Depth along the view ray, and the corner's offsets from it.
        const along = ax * F.x + ay * F.y
        const vertical = Math.abs(ax * U.x + ay * U.y)
        // Screen-right is world +Z, so the horizontal offset is just `pz`.
        const horizontal = Math.abs(pz)
        const forVertical = (vertical * margin) / tanHalf
        const forHorizontal = (horizontal * margin) / (tanHalf * safeAspect)
        required = Math.max(required, (forVertical - along) / RAY, (forHorizontal - along) / RAY)
      }
    }
  }
  return required
}
