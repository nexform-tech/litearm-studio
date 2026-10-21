/**
 * The model the 3D viewport loads — which is not in this repository.
 *
 * `scripts/fetch-description.mjs` pulls it from upstream (`nexform-tech/litearm-description`,
 * the version pinned in `description.lock.json`) into `.cache/description/` before every
 * dev, build and test run; `scripts/build-description.mjs` then decimates the meshes into
 * `public/description/`, which is what the viewport loads. The directory layout and the file
 * names are identical to upstream's package — only the mesh bytes are derived — so what is
 * written here is that package's layout.
 *
 * These live in their own module rather than in `RobotViewport.tsx` for two reasons:
 * a component file should export only components (react-refresh), and
 * `src/description.model.test.ts` checks these names against the model that was actually
 * fetched — without dragging three.js into that test.
 */

/** Where the model sits under `public/` — and where any `package://` name resolves to. */
export const MODEL_DIR = 'description/'
/** The URDF the viewport loads, relative to `public/`. */
export const MODEL_PATH = `${MODEL_DIR}urdf/litearm_description.urdf`
export const MODEL_URL = `${import.meta.env.BASE_URL}${MODEL_PATH}`
export const WORKING_PATH = `${import.meta.env.BASE_URL}${MODEL_DIR}`

/** Joint names, in the order the viewport sets positions. Must match the URDF's joints. */
export const JOINT_NAMES = ['joint1', 'joint2', 'joint3', 'joint4', 'joint5', 'joint6', 'joint7']
/** Which link the end-effector axes hang from. */
export const END_EFFECTOR_LINK = 'ee_link'
