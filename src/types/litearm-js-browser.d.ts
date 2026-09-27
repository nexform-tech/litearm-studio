/**
 * litearm-js's package.json currently points the "./browser" export's
 * `types` condition at the Node client's declaration file (different
 * constructor, no `connected` getter — see src/arm.ts vs src/arm-browser.ts
 * upstream). This ambient module shims the actual browser client's shape
 * (mirrored from litearm-js/src/arm-browser.ts) so we don't have to patch
 * the sibling repo just to get correct types.
 *
 * Runtime is unaffected — this only supplies types for the module
 * specifier; the real code still comes from litearm-js's own
 * dist/litearm.mjs bundle.
 */
declare module 'litearm-js/browser' {
  export interface RobotState {
    q: number[]
    dq: number[]
    tau: number[]
    fault: { joint: number; errCode: number }[]
    errs: number[]
    temps: { mosTemp: number; coilTemp: number }[]
    state: string
    robotSerial: string
    configChecksumSha256: string
    feedback: {
      maxAgeS: number
      staleJoints: number[]
      joints: { joint: number; received: number; ageS: number; fresh: boolean }[]
    }
    watchdog: { enabled: boolean; timeoutS: number; mode: string; tripped: boolean; lastKickAgeS: number }
  }

  export type Pose = [number[], number[][]]

  export interface HomeOps {
    speed?: number
    settle_s?: number
    max_cycles?: number
  }

  export interface MoveJOps {
    speed?: number
    settle_s?: number
    max_cycles?: number
    allow_start_collision_recovery?: boolean
  }
  export interface MoveLOps {
    speed?: number
    settle_s?: number
    max_cycles?: number
  }
  export interface MoveCOps {
    speed?: number
    settle_s?: number
    max_cycles?: number
  }
  export interface MovePOps {
    speed?: number
    settle_s?: number
    max_cycles?: number
  }

  /** 内置末端类型(list_device_types 返回项)。 */
  export interface DeviceTypeInfo {
    category: string
    subtype: string
    name: string
    icon: string
    model?: string
    vendor?: string
  }

  /** 当前末端状态(get_active_device 返回)。 */
  export interface ActiveDeviceInfo {
    configured: boolean
    enabled: boolean
    online: boolean
    category: string
    subtype: string
    device_id: string
    can_iface: string
  }

  export class DeviceProxy {
    readonly deviceId: string
    call(method: string, kwargs?: Record<string, unknown>): Promise<unknown>
    connect(kwargs?: Record<string, unknown>): Promise<unknown>
    disconnect(): Promise<unknown>
    open(): Promise<unknown>
    close(): Promise<unknown>
    setGesture(gesture: string): Promise<unknown>
    fingerMove(pose: number[]): Promise<unknown>
    getState(): Promise<unknown>
    clearFaults(): Promise<unknown>
    setWidth(width: number): Promise<unknown>
    getWidth(): Promise<unknown>
    setForce(force: number): Promise<unknown>
  }

  export class Arm {
    /** @param endpoint litearm-server address, e.g. "192.168.31.237:7449" */
    constructor(endpoint: string, token?: string)

    connect(): Promise<void>
    close(): void
    readonly connected: boolean

    getState(): RobotState | null
    getTcpPose(): Promise<Pose>

    fk(q: number[]): Promise<Pose>
    ik(pos: number[], R: number[][], q_seed?: number[]): Promise<[number[], boolean]>
    planMovel(q_start: number[], pose_goal: Pose): Promise<number[][]>
    planMovec(q_start: number[], pose_via: Pose, pose_goal: Pose): Promise<number[][]>
    planMovep(q_start: number[], poses: Pose[]): Promise<number[][]>

    home(ops?: HomeOps): Promise<boolean>
    movej(q_target: number[], ops?: MoveJOps): Promise<boolean>
    recoverJointLimits(ops?: { speed?: number; settle_s?: number; inset_rad?: number; max_cycles?: number }): Promise<boolean>
    movel(pose_goal: Pose, ops?: MoveLOps): Promise<boolean>
    movec(pose_via: Pose, pose_goal: Pose, ops?: MoveCOps): Promise<boolean>
    movep(poses: Pose[], ops?: MovePOps): Promise<boolean>
    /** 常驻持位控制环。litearm-server 的 WS 桥接是 ack 式返回：resolve 只代表
     *  控制环已在服务端启动，不代表它结束（无 max_cycles 时它会一直跑）。
     *  真实模式以状态广播的 `state` 为准。 */
    hold(kp_scale?: number, max_cycles?: number): Promise<boolean>
    /** 常驻零重力（拖动）控制环，ack 式返回，语义同 {@link Arm.hold}。
     *  服务端会先抢占在跑的控制环再启动本条，无需客户端自行 requestStop。 */
    zeroGravity(ops?: { duration_s?: number; max_cycles?: number; measured_overspeed_factor?: number; vel_max?: number[] }): Promise<boolean>

    requestStop(): void
    clearStop(): Promise<void>

    device(deviceId: string): DeviceProxy

    listDeviceTypes(): Promise<DeviceTypeInfo[]>
    connectDevice(
      category: string,
      subtype: string,
      opts?: { deviceId?: string; canIface?: string; config?: Record<string, unknown> },
    ): Promise<{ ok: boolean; device_id?: string; error?: string }>
    disconnectDevice(deviceId?: string): Promise<{ ok: boolean }>
    getActiveDevice(deviceId?: string): Promise<ActiveDeviceInfo>
    getDeviceManifest(deviceId?: string): Promise<any | null>

    setGains(kp?: number[], kd?: number[]): Promise<{ kp: number[]; kd: number[] }>
    getGains(): Promise<{ kp: number[]; kd: number[] }>
    clearFaults(): Promise<[number, number][]>
    /** Enable all motors and hold current pose (re-enable after disable). */
    enable(): Promise<void>
    /** Disable all motors (arm will drop under gravity!). CAN stays connected. */
    disable(): Promise<void>
    setPayload(mass: number, com?: [number, number, number]): Promise<{ mass: number; com: number[] }>
    getPayload(): Promise<{ mass: number; com: number[] }>
    /** Persist current payload (mass + com) to server yaml (effective after restart). */
    savePayload(): Promise<Record<string, unknown>>
    /** Set installation orientation (base_rpy) and/or base-frame gravity vector. */
    setInstallation(base_rpy?: number[], gravity?: number[]): Promise<{ base_rpy: number[]; gravity: number[] }>
    getInstallation(): Promise<{ base_rpy: number[]; gravity: number[] }>
    /** Persist current installation orientation (base_rpy) to server yaml. */
    saveInstallation(): Promise<Record<string, unknown>>
    /** Set per-joint gravity calibration scale[7] (non-negative). Default 2s smooth transition. */
    setGravityScale(scale: number[], transition_s?: number): Promise<{ scale: number[]; target: number[] | null }>
    /** Get current per-joint gravity calibration scale (mid-transition value + target while easing). */
    getGravityScale(): Promise<{ scale: number[]; target: number[] | null }>
    /** Persist current gravity scale to server yaml (effective after restart). */
    saveGravityScale(): Promise<Record<string, unknown>>
    getSystemStats(): Promise<{ cpu_percent: number; mem_percent: number; disk_percent: number; board_temp: number; uptime_seconds: number } & Record<string, unknown>>
    restartService(): Promise<Record<string, unknown>>
    getJointLimits(): Promise<Record<string, unknown>>
    setJointLimits(limits: Record<string, unknown>): Promise<Record<string, unknown>>
    getZeroOffsets(): Promise<Record<string, unknown>>
    setZeroOffsets(offsets: Record<string, unknown>): Promise<Record<string, unknown>>
    getEndEffector(): Promise<Record<string, unknown>>
    setEndEffector(config: Record<string, unknown>): Promise<Record<string, unknown>>
    getCartesianLimits(): Promise<Record<string, unknown>>
    setCartesianLimits(limits: Record<string, unknown>): Promise<Record<string, unknown>>
    getCollisionConfig(): Promise<Record<string, unknown>>
    setCollisionConfig(config: Record<string, unknown>): Promise<Record<string, unknown>>
    getConfigYaml(): Promise<{ yaml_content: string; file_path?: string; parsed?: Record<string, unknown> }>
    setConfigYaml(content: string): Promise<{ ok: boolean; error?: string }>
    jointImpedance(q_des: number[], K: number[], B: number[], ops?: { engage_sec?: number }): Promise<boolean>
    cartesianImpedance(q_des: number[], K_cart: number[], B_cart: number[], ops?: { engage_sec?: number }): Promise<boolean>

    replayJointPath(
      q_path: number[][],
      ops?: { speed?: number; settle_s?: number; goto_start?: boolean; goto_speed?: number; max_cycles?: number },
    ): Promise<boolean>
    /** @param trajectory 轨迹对象，或**相对 litearm-server 进程 cwd 的 JSON 路径**
     *  （pylitearm 的 play_trajectory 接受 `Union[JointTrajectory, str, PathLike]`，
     *  路径形式是它的正规用法，也是浏览器端唯一可行的形式——整条轨迹的采样帧
     *  没必要来回搬运）。 */
    playTrajectory(
      trajectory: Record<string, unknown> | string,
      ops?: { speed?: number; goto_start?: boolean; goto_speed?: number; verify_robot?: boolean; simplify_tolerance_rad?: number; max_cycles?: number },
    ): Promise<boolean>
    /** 拖拽示教录制：内部即 zero_gravity + 逐周期采样，跑完自动存成
     *  `trajectories/trajectory_NNN.json`。无 duration_s 时一直录到 requestStop()。
     *  返回值是 pylitearm 的 JointTrajectory 数据类，经 WS 桥接后会退化成 repr
     *  字符串，不可解析——录制结果请重新拉 listTrajectories() 获取。 */
    recordTrajectory(ops?: { duration_s?: number; sample_rate_hz?: number; filter_alpha?: number; name?: string }): Promise<Record<string, unknown>>

    startRecording(): Promise<Record<string, unknown>>
    stopRecording(): Promise<Record<string, unknown>>
    discardRecording(): Promise<Record<string, unknown>>
    getRecordingState(): Promise<Record<string, unknown>>
    getPlaybackState(): Promise<Record<string, unknown>>
    listTrajectories(): Promise<Record<string, unknown>>
    saveTrajectory(id: string, name: string, points: number[][], duration?: number): Promise<Record<string, unknown>>
    deleteTrajectory(id: string): Promise<Record<string, unknown>>

    // 注意：当前新版 litearm-js/browser 已移除下列插件/扩展 RPC。
    // 这里仅为尚未迁移的扩展中心页面保留类型，运行时这些调用会被
    // ArmClient.withArm 转成 rejected promise，不会直接抛出。
    listAvailablePlugins(deviceIds?: string[]): Promise<any[]>
    listInstalledPlugins(): Promise<any[]>
    installPlugin(pluginId: string): Promise<any>
    uninstallPlugin(pluginId: string): Promise<any>
    getActiveDevices(): Promise<any>
    setActiveDevice(pluginId: string, deviceId: string, canIface: string): Promise<any>
    removeActiveDevice(deviceId: string): Promise<any>

    listInstalledExtensions(): Promise<any[]>
    getExtensionDetail(extensionId: string): Promise<any>
    uninstallExtension(extensionId: string, cascade?: boolean): Promise<any>
    checkExtensionUpdates(): Promise<any[]>
    installExtension(extensionId: string, source?: string): Promise<any>
    installFromGithub(url: string): Promise<any>
    installFromUrl(url: string): Promise<any>
    installKit(extensionId: string, source?: string): Promise<any>
    listAvailableExtensions(category?: string, search?: string): Promise<any[]>
    searchExtensions(query: string): Promise<any[]>

    getLogs(page?: number, size?: number, search?: string): Promise<Record<string, unknown>>

    call<T>(method: string, kwargs?: Record<string, unknown>): Promise<T>
  }
}
