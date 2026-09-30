/**
 * Pins the default preview camera to the orientation the jog pad assumes.
 *
 * The claims that matter are about screen directions, so the assertions project
 * the base frame's axes through a real `THREE.PerspectiveCamera` instead of
 * comparing numbers to the same formula the implementation uses. Three.js puts
 * the screen-right direction in the camera matrix's first column and screen-up
 * in the second.
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  FRAME_DISTANCE_FACTOR,
  MIN_FRAME_DISTANCE,
  defaultPreviewView,
} from './previewCamera'

const distance = Math.max(1.37 * FRAME_DISTANCE_FACTOR, MIN_FRAME_DISTANCE)
const targetY = 0.685

/**
 * `RobotViewport` rotates the Z-up model's root by `-PI/2` about X, which maps a
 * URDF vector `(x, y, z)` to world `(x, z, -y)`. So the base frame's three axes
 * are these world vectors.
 */
const BASE = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 0, -1),
  z: new THREE.Vector3(0, 1, 0),
}

function screenBasis() {
  const view = defaultPreviewView(distance, targetY)
  if (!view) throw new Error('expected a view')
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
  camera.position.set(...view.position)
  camera.up.set(0, 1, 0)
  camera.lookAt(...view.target)
  camera.updateMatrixWorld(true)
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
  const forward = new THREE.Vector3().subVectors(
    new THREE.Vector3(...view.target),
    camera.position,
  ).normalize()
  return { view, right, up, forward }
}

describe('defaultPreviewView', () => {
  it('keeps the URDF-to-world axis mapping the rest of the viewport assumes', () => {
    // Guards the premise of every other test here: the -PI/2 rotation about X
    // that `RobotViewport` applies to the model's root must send the base axes
    // to exactly these world vectors.
    const root = new THREE.Object3D()
    root.rotation.x = -Math.PI / 2
    root.updateMatrixWorld(true)
    const world = (x: number, y: number, z: number) =>
      new THREE.Vector3(x, y, z).applyQuaternion(root.quaternion)
    const close = (v: THREE.Vector3, expected: THREE.Vector3) => {
      expect(v.x).toBeCloseTo(expected.x, 6)
      expect(v.y).toBeCloseTo(expected.y, 6)
      expect(v.z).toBeCloseTo(expected.z, 6)
    }
    close(world(1, 0, 0), BASE.x)
    close(world(0, 1, 0), BASE.y)
    close(world(0, 0, 1), BASE.z)
  })

  it('looks along base +X, so the pad reads 前/后 as forward', () => {
    const { view, forward } = screenBasis()
    // The eye is on the -X side, so base +X points away from the operator...
    expect(view.position[0]).toBeLessThan(0)
    // ...and is the only horizontal direction of travel into the screen. The
    // view is pitched down, so compare the horizontal projection: forward's
    // vertical part is the elevation, not the azimuth.
    const azimuth = new THREE.Vector3(forward.x, 0, forward.z).normalize()
    expect(BASE.x.dot(azimuth)).toBeCloseTo(1, 6)
  })

  it('runs base +Y across the screen, with +Y to the left', () => {
    const { right, up } = screenBasis()
    expect(BASE.y.dot(right)).toBeLessThan(-0.9)
    expect(Math.abs(BASE.y.dot(up))).toBeLessThan(0.1)
  })

  it('keeps the base axes apart on screen, unlike the old 45° azimuth', () => {
    const { right, up } = screenBasis()
    const screenDir = (axis: THREE.Vector3) =>
      new THREE.Vector2(axis.dot(right), axis.dot(up)).normalize()
    // A quarter turn apart, not "nearly the same direction separated by depth".
    expect(Math.abs(screenDir(BASE.x).dot(screenDir(BASE.y)))).toBeLessThan(0.1)
  })

  it('keeps base +Z up', () => {
    const { up } = screenBasis()
    expect(BASE.z.dot(up)).toBeGreaterThan(0.9)
  })

  it('looks slightly down from a fixed distance and elevation', () => {
    const { view } = screenBasis()
    const [cx, cy, cz] = view.position
    expect(cz).toBe(0)
    // The old view sat at (0.69d, ·, 0.69d). Folding that offset onto the axis
    // keeps the horizontal offset and the 0.2d rise, so the elevation angle is
    // the one the diagonal view was tuned for.
    expect(cx).toBeCloseTo(-distance * 0.69, 6)
    expect(cy).toBeCloseTo(targetY + distance * 0.2, 6)
  })

  it('refuses a degenerate distance instead of aiming at its own target', () => {
    expect(defaultPreviewView(0, targetY)).toBeNull()
    expect(defaultPreviewView(-1, targetY)).toBeNull()
  })
})
