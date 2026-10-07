import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import URDFLoader from 'urdf-loader'
import type { URDFRobot } from 'urdf-loader'
import { defaultPreviewView, fitFrameDistance } from './previewCamera'

const URDF_URL = `${import.meta.env.BASE_URL}description/litearm.urdf`
const WORKING_PATH = `${import.meta.env.BASE_URL}description/`

// 关节名顺序，需与 URDF 中的 joint 名称一致（支持 Joint1..Joint7 与 joint1..joint7）
const JOINT_NAMES = ['Joint1', 'Joint2', 'Joint3', 'Joint4', 'Joint5', 'Joint6', 'Joint7']

export interface RobotViewportHandle {
  /** 重置视角到默认朝向 */
  refresh: () => void
  /** 聚焦到机械臂中心，稍低更贴近的观察角度 */
  focus: () => void
  /** 切换到俯视角度 */
  topView: () => void
  /** 设置关节角度（单位：弧度，顺序与 joint1..joint7 一致） */
  setJointPositions: (angles: number[]) => void
}

interface RobotViewportProps {
  /** 是否显示基座与末端坐标轴 */
  showAxes?: boolean
  /** 暂停渲染（例如全屏弹窗打开时隐藏在下层的视口），恢复后自动补一帧 */
  paused?: boolean
  className?: string
}

function isWebGLAvailable() {
  try {
    const canvas = document.createElement('canvas')
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    )
  } catch {
    return false
  }
}

function isDarkTheme() {
  return document.documentElement.classList.contains('dark')
}

const createAxisLabelSprite = (text: string, hexColor: number, pos: THREE.Vector3, spriteScale: number) => {
  const res = 128
  const canvas = document.createElement('canvas')
  canvas.width = res
  canvas.height = res
  const ctx = canvas.getContext('2d')!
  ctx.font = 'bold 80px Arial'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'
  ctx.lineWidth = 6
  ctx.strokeText(text, res / 2, res / 2)
  ctx.fillStyle = '#' + hexColor.toString(16).padStart(6, '0')
  ctx.fillText(text, res / 2, res / 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true }),
  )
  sprite.position.copy(pos)
  sprite.scale.set(spriteScale, spriteScale, 1)
  sprite.renderOrder = 11
  return sprite
}

const createLabeledAxes = (axisLength: number, groupName: string) => {
  const group = new THREE.Group()
  group.name = groupName

  const headLength = axisLength * 0.2
  const headWidth = axisLength * 0.08
  const labelOffset = axisLength * 1.2
  const spriteScale = axisLength * 0.4

  const axes: Array<{ dir: THREE.Vector3; color: number; label: string }> = [
    { dir: new THREE.Vector3(1, 0, 0), color: 0xff3333, label: 'X' },
    { dir: new THREE.Vector3(0, 1, 0), color: 0x33ff33, label: 'Y' },
    { dir: new THREE.Vector3(0, 0, 1), color: 0x3388ff, label: 'Z' },
  ]

  for (const { dir, color, label } of axes) {
    const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), axisLength, color, headLength, headWidth)
    arrow.renderOrder = 10
    ;(arrow.line.material as THREE.LineBasicMaterial).depthTest = false
    ;(arrow.cone.material as THREE.MeshBasicMaterial).depthTest = false
    group.add(arrow)
    group.add(createAxisLabelSprite(label, color, dir.clone().multiplyScalar(labelOffset), spriteScale))
  }

  group.renderOrder = 10
  return group
}

/** 计算物体自身网格的包围盒，排除本组件添加的坐标轴等辅助物体 */
const getModelBox = (object: THREE.Object3D) => {
  const box = new THREE.Box3()
  const walk = (obj: THREE.Object3D) => {
    if (obj.name?.startsWith?.('__')) return
    if (obj instanceof THREE.Mesh) box.expandByObject(obj)
    obj.children.forEach(walk)
  }
  walk(object)
  return box
}

/** 递归释放场景树上的几何体 / 材质 / 纹理，避免组件卸载后 GPU 资源残留。
 *  renderer.dispose() 只释放渲染器自身状态，网格上传到 GPU 的缓冲需要
 *  逐个 geometry/material/texture.dispose() 才会回收。 */
const disposeSceneResources = (root: THREE.Object3D) => {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const mat of mats) {
      const m = mat as THREE.Material & Record<string, unknown>
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap'] as const) {
        const tex = m[key]
        if (tex && typeof tex === 'object' && (tex as THREE.Texture).isTexture) {
          ;(tex as THREE.Texture).dispose()
        }
      }
      mat.dispose()
    }
  })
}

/**
 * 取景：把机械臂摆到原点（x/z 居中、底座贴地），然后以机械臂真实中心为
 * 观察/旋转中心，从一个固定的近距视角拍摄。初始加载和“聚焦”按钮共用同一
 * 套逻辑，保证进入页面与点击聚焦后的视角完全一致。
 *
 * 具体朝哪儿由 `previewCamera.ts` 决定（基座 +X 轴上，见那里的注释）；这里只
 * 负责量出包络和把结果写进相机与 `OrbitControls`。
 */
const frameRobot = (
  object: THREE.Object3D,
  camera: THREE.PerspectiveCamera | null,
  controls: OrbitControls | null,
) => {
  if (!camera || !controls) return
  // 网格是异步挂进场景的，此时 matrixWorld 可能还是旧值；先强制刷新整条
  // 变换链，保证取景用的包围盒是完整的机械臂姿态。
  object.updateMatrixWorld(true)
  const box = getModelBox(object)
  if (box.isEmpty()) return

  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())

  object.position.x -= center.x
  object.position.z -= center.z
  object.position.y -= box.min.y

  // 取景距离按**视锥**解出来（见 previewCamera 的 fitFrameDistance）：固定的
  // 「包络最大边 × 1.72」在俯视 16° 的机位下会把机械臂顶端切掉，而且窄视口还
  // 会再收窄水平视野。这里量的是当前相机的视锥，窗口形状变化都被算进去。
  const targetY = size.y * 0.5
  const distance = fitFrameDistance(size, camera.aspect)
  const view = defaultPreviewView(distance, targetY)
  // 退化包络（没有网格）：保持当前视角，不要把自己贴到目标点上。
  if (!view) return
  camera.position.set(...view.position)
  controls.target.set(...view.target)
  controls.update()
}

export const RobotViewport = forwardRef<RobotViewportHandle, RobotViewportProps>(function RobotViewport(
  { showAxes = true, paused = false, className },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [webglError, setWebglError] = useState('')
  const [contextLost, setContextLost] = useState(false)
  const scheduleRenderRef = useRef<() => void>(() => {})

  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const robotRef = useRef<URDFRobot | null>(null)
  const baseAxesRef = useRef<THREE.Group | null>(null)
  const endEffectorAxesRef = useRef<THREE.Group | null>(null)
  const groundPlaneRef = useRef<THREE.Mesh | null>(null)
  const gridHelperRef = useRef<THREE.GridHelper | null>(null)
  const lightsRef = useRef<{
    ambient: THREE.AmbientLight | null
    dir: THREE.DirectionalLight | null
    rim: THREE.DirectionalLight | null
    hemi: THREE.HemisphereLight | null
  }>({ ambient: null, dir: null, rim: null, hemi: null })

  const showAxesRef = useRef(showAxes)
  showAxesRef.current = showAxes
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  // 由挂载 effect 内部赋值：paused 变化时取消/恢复渲染帧
  const setPausedRef = useRef<(p: boolean) => void>(() => {})

  useEffect(() => {
    setPausedRef.current(paused)
  }, [paused])

  useEffect(() => {
    if (baseAxesRef.current) baseAxesRef.current.visible = showAxes
    if (endEffectorAxesRef.current) endEffectorAxesRef.current.visible = showAxes
    scheduleRenderRef.current()
  }, [showAxes])

  useImperativeHandle(ref, () => ({
    refresh: () => {
      const robot = robotRef.current
      if (!robot) return
      frameRobot(robot, cameraRef.current, controlsRef.current)
    },
    focus: () => {
      const robot = robotRef.current
      if (!robot) return
      frameRobot(robot, cameraRef.current, controlsRef.current)
    },
    topView: () => {
      const camera = cameraRef.current
      const controls = controlsRef.current
      if (!camera || !controls) return
      camera.up.set(0, 1, 0)
      camera.position.set(0, 2.5, 0.01)
      controls.target.set(0, 0, 0)
      controls.update()
    },
    setJointPositions: (angles: number[]) => {
      const robot = robotRef.current
      if (!robot) return
      JOINT_NAMES.forEach((name, i) => {
        const joint = robot.joints?.[name] ?? robot.joints?.[`joint${i + 1}`] ?? robot.joints?.[`Joint${i + 1}`]
        if (joint && typeof angles[i] === 'number') {
          joint.setJointValue(angles[i])
        }
      })
      scheduleRenderRef.current()
    },
  }))

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (!isWebGLAvailable()) {
      setWebglError('当前环境不支持 WebGL，无法显示机械臂模型。请检查显卡驱动或使用支持 WebGL 的浏览器。')
      return
    }

    let disposed = false
    const width = container.clientWidth || 300
    const height = container.clientHeight || 300

    const scene = new THREE.Scene()
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
    camera.position.set(0.9, 0.6, 1.1)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(width, height, false)
    // 全屏展开时画布很大，像素比封顶 2，避免 Retina 3x 全尺寸渲染拖慢帧率。
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    // Force the canvas CSS box to always match its container exactly (not the
    // renderer's own inline px width/height), so resizes can never leave it
    // overflowing or under-filling the parent.
    Object.assign(renderer.domElement.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '1',
    })
    container.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const ambient = new THREE.AmbientLight(0xf4f7ff, 0.72)
    scene.add(ambient)
    const dir = new THREE.DirectionalLight(0xffffff, 0.6)
    dir.position.set(3, 5, 2)
    scene.add(dir)
    const rim = new THREE.DirectionalLight(0x9fb9ff, 0.45)
    rim.position.set(-3, 2, -2)
    scene.add(rim)
    const hemi = new THREE.HemisphereLight(0xe7f0ff, 0x131a26, 0.45)
    scene.add(hemi)
    lightsRef.current = { ambient, dir, rim, hemi }

    const gridHelper = new THREE.GridHelper(30, 60, 0xffffff, 0xffffff)
    const gridMaterial = gridHelper.material as THREE.Material
    gridMaterial.transparent = true
    gridMaterial.depthWrite = false
    gridHelper.position.y = 0
    gridHelper.renderOrder = 2
    gridHelperRef.current = gridHelper

    const groundPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshPhongMaterial({ color: 0xdce0e0, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
    )
    groundPlane.rotation.x = -Math.PI / 2
    groundPlane.position.y = -0.0001
    groundPlane.renderOrder = 1
    groundPlaneRef.current = groundPlane
    scene.add(groundPlane)
    scene.add(gridHelper)

    const applyTheme = (dark: boolean) => {
      scene.background = new THREE.Color(dark ? 0x041622 : 0x9cd8f0)
      ambient.color.setHex(dark ? 0xdfeeff : 0xf4f7ff)
      ambient.intensity = dark ? 1.2 : 0.72
      dir.color.setHex(dark ? 0xf0f8ff : 0xffffff)
      dir.intensity = dark ? 1.0 : 0.6
      rim.color.setHex(dark ? 0x7fbaff : 0x9fb9ff)
      rim.intensity = dark ? 0.9 : 0.45
      hemi.color.setHex(dark ? 0xdfeeff : 0xe7f0ff)
      hemi.groundColor = new THREE.Color(0x131a26)
      hemi.intensity = dark ? 0.6 : 0.45

      if (groundPlane.material instanceof THREE.MeshPhongMaterial) {
        groundPlane.material.color.setHex(dark ? 0x0b2733 : 0xdce0e0)
        groundPlane.material.opacity = dark ? 0.88 : 0.8
        groundPlane.material.emissive = new THREE.Color(dark ? 0x031016 : 0x000000)
        groundPlane.material.emissiveIntensity = dark ? 0.12 : 0
        groundPlane.receiveShadow = true
      }

      const gridMat = gridHelper.material as THREE.LineBasicMaterial
      gridMat.color.setHex(dark ? 0x0fb7a4 : 0xffffff)
      gridMat.transparent = true
      gridMat.opacity = dark ? 0.28 : 0.8
      gridMat.depthWrite = false

    }
    applyTheme(isDarkTheme())

    const controls = new OrbitControls(camera, renderer.domElement)
    // 关闭阻尼：阻尼会让相机滞后指针约 250~300ms（dampingFactor=0.05 时），
    // 拖动起来像“很卡”。关闭后相机 1:1 跟随指针；且 change 只在相机真正
    // 移动时派发，按需渲染的帧循环依然能在空闲时自动停下来。
    controls.enableDamping = false
    controls.target.set(0, 0.35, 0)
    controlsRef.current = controls

    // 按需渲染：有状态更新/交互/尺寸变化时才排一帧，避免页面待机时也持续
    // 60fps 软件光栅化（软渲染环境下长时间满载容易拖垮渲染进程）。
    let hidden = document.hidden
    let renderPending = false
    let contextLostFlag = false
    let contextLostTimer: ReturnType<typeof setTimeout> | null = null
    let frameId = 0

    const markTexturesDirty = (root: THREE.Object3D) => {
      root.traverse((child) => {
        const mesh = child as THREE.Mesh
        if (!mesh.material) return
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const mat of mats) {
          const m = mat as THREE.Material & Record<string, unknown>
          for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap'] as const) {
            const tex = m[key]
            if (tex && typeof tex === 'object' && (tex as { isTexture?: boolean }).isTexture) {
              ;(tex as THREE.Texture).needsUpdate = true
            }
          }
        }
      })
    }

    const renderFrame = () => {
      frameId = 0
      renderPending = false
      if (disposed || hidden || contextLostFlag) return
      controls.update()
      renderer.render(scene, camera)
    }

    const scheduleRender = () => {
      if (renderPending || hidden || disposed || contextLostFlag || pausedRef.current) return
      renderPending = true
      frameId = requestAnimationFrame(renderFrame)
    }
    scheduleRenderRef.current = scheduleRender
    setPausedRef.current = (p: boolean) => {
      pausedRef.current = p
      if (p) {
        // 暂停：取消未执行的渲染帧，避免被遮住的下层视口继续消耗渲染资源。
        if (frameId) cancelAnimationFrame(frameId)
        frameId = 0
        renderPending = false
      } else {
        scheduleRender()
      }
    }

    // OrbitControls 只在相机实际移动超过 EPS 时派发 change（无阻尼时拖动
    // 结束后不再有惯性帧）——帧循环因此能自动在交互结束时停下来。
    const onControlsChange = () => scheduleRender()
    controls.addEventListener('change', onControlsChange)

    const onVisibilityChange = () => {
      hidden = document.hidden
      if (hidden) {
        if (frameId) cancelAnimationFrame(frameId)
        frameId = 0
        renderPending = false
      } else {
        scheduleRender()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    const onContextLost = (event: Event) => {
      event.preventDefault()
      contextLostFlag = true
      if (frameId) cancelAnimationFrame(frameId)
      frameId = 0
      renderPending = false
      setContextLost(true)
      // GPU 进程重启通常秒级恢复；超过 15s 还没恢复就直接刷新自愈。
      contextLostTimer = setTimeout(() => {
        if (!disposed) window.location.reload()
      }, 15000)
    }
    const onContextRestored = () => {
      contextLostFlag = false
      if (contextLostTimer) {
        clearTimeout(contextLostTimer)
        contextLostTimer = null
      }
      // three.js 内部已重建 GL 状态，但纹理/精灵画布需要标记重新上传。
      markTexturesDirty(scene)
      setContextLost(false)
      scheduleRender()
    }
    renderer.domElement.addEventListener('webglcontextlost', onContextLost, false)
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored, false)

    const addBaseAxes = (root: THREE.Object3D) => {
      const target = (root as URDFRobot).links?.['base_link'] ?? root.getObjectByName('base_link') ?? root
      if (!target || target.getObjectByName('__base_axes')) return
      const group = createLabeledAxes(0.12, '__base_axes')
      group.visible = showAxesRef.current
      baseAxesRef.current = group
      target.add(group)
    }

    const addEndEffectorAxes = (root: URDFRobot) => {
      const target = root.links?.['ee_frame_link'] ?? root.getObjectByName('ee_frame_link')
      if (!target || target.getObjectByName('__end_effector_axes')) return
      const group = createLabeledAxes(0.08, '__end_effector_axes')
      group.visible = showAxesRef.current
      endEffectorAxesRef.current = group
      target.add(group)
    }

    const onModelLoad = (robot: URDFRobot) => {
      if (disposed) return
      robot.rotation.x = -Math.PI / 2
      addEndEffectorAxes(robot)
      addBaseAxes(robot)
      scene.add(robot)
      robotRef.current = robot

      // URDFLoader 的 onComplete 在 XML 解析完就触发，此时 STL 网格仍在
      // 异步加载。每个 visual 节点对应一个网格，且网格只有解析完整后才会
      // 挂进场景，所以“已加载网格数 >= 期望数”即代表模型完整，可以立刻
      // 取景，无需等待网格数量额外稳定。
      let expectedMeshCount = 0
      robot.traverse((child) => {
        if ((child as { isURDFVisual?: boolean }).isURDFVisual) expectedMeshCount++
      })
      let lastMeshCount = 0
      let stallTicks = 0
      const finalize = () => {
        if (disposed) return
        frameRobot(robot, camera, controls)
        scheduleRender()
      }
      const poll = () => {
        if (disposed) return
        let meshCount = 0
        const countMeshes = (obj: THREE.Object3D) => {
          if (obj.name?.startsWith?.('__')) return
          if (obj instanceof THREE.Mesh) meshCount++
          obj.children.forEach(countMeshes)
        }
        countMeshes(robot)
        if (meshCount !== lastMeshCount) {
          // 有新网格挂进场景：先排一帧，让模型随加载进度逐步出现，
          // 而不是一直停在空白/网格底座的画面。
          lastMeshCount = meshCount
          stallTicks = 0
          scheduleRender()
        } else {
          stallTicks++
        }
        if (meshCount >= expectedMeshCount) {
          finalize()
          return
        }
        if (stallTicks >= 50) {
          // 兜底：2s 内网格数没有增加（可能有个别文件加载失败），
          // 至少把已加载的部分取景渲染出来。
          if (meshCount > 0) finalize()
          return
        }
        setTimeout(poll, 40)
      }
      poll()
    }

    const onModelError = (err: unknown) => {
      console.error('RobotViewport: failed to load URDF model', err)
      const material = new THREE.MeshStandardMaterial({ color: 0x4c8bf5 })
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 32), material)
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.5), material)
      arm.position.z = 0.25
      const group = new THREE.Group()
      group.add(base)
      group.add(arm)
      group.rotation.x = -Math.PI / 2
      frameRobot(group, camera, controls)
      addBaseAxes(group)
      scene.add(group)
      scheduleRender()
    }

    const loader = new URDFLoader()
    loader.packages = { litearm_urdf: WORKING_PATH.replace(/\/$/, '') }
    loader.workingPath = WORKING_PATH
    loader.load(URDF_URL, onModelLoad, undefined, onModelError)

    scheduleRender()

    let lastWidth = width
    let lastHeight = height
    let resizeRafId = 0
    const handleResize = () => {
      const { clientWidth, clientHeight } = container
      if (clientWidth <= 0 || clientHeight <= 0) return
      if (clientWidth === lastWidth && clientHeight === lastHeight) return
      lastWidth = clientWidth
      lastHeight = clientHeight
      if (resizeRafId) cancelAnimationFrame(resizeRafId)
      resizeRafId = requestAnimationFrame(() => {
        renderer.setSize(clientWidth, clientHeight, false)
        camera.aspect = clientWidth / clientHeight
        camera.updateProjectionMatrix()
        scheduleRender()
      })
    }
    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)

    const themeObserver = new MutationObserver(() => {
      applyTheme(isDarkTheme())
      scheduleRender()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    return () => {
      disposed = true
      scheduleRenderRef.current = () => {}
      setPausedRef.current = () => {}
      if (frameId) cancelAnimationFrame(frameId)
      if (resizeRafId) cancelAnimationFrame(resizeRafId)
      if (contextLostTimer) clearTimeout(contextLostTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      controls.removeEventListener('change', onControlsChange)
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost, false)
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored, false)
      resizeObserver.disconnect()
      themeObserver.disconnect()
      controls.dispose()
      disposeSceneResources(scene)
      renderer.dispose()
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement)
      }
      sceneRef.current = null
      cameraRef.current = null
      rendererRef.current = null
      controlsRef.current = null
      robotRef.current = null
      baseAxesRef.current = null
      endEffectorAxesRef.current = null
    }
  }, [])

  if (webglError) {
    return (
      <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: '2rem',
            fontSize: '0.875rem',
            color: 'var(--color-destructive, #dc2626)',
          }}
        >
          {webglError}
        </div>
      </div>
    )
  }

  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {contextLost ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.75rem',
            padding: '2rem',
            textAlign: 'center',
            fontSize: '0.875rem',
            color: 'var(--color-destructive, #dc2626)',
            background: 'var(--background)',
          }}
        >
          <div>3D 渲染上下文丢失，正在等待浏览器恢复…（15 秒后自动刷新页面）</div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '0.375rem 0.875rem',
              borderRadius: '0.5rem',
              border: '1px solid var(--border)',
              background: 'var(--secondary)',
              color: 'var(--foreground)',
              cursor: 'pointer',
            }}
          >
            立即刷新
          </button>
        </div>
      ) : null}
    </div>
  )
})
