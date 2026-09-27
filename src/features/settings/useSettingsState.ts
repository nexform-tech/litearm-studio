import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { armClient, formatArmError, useArmConnection } from '@/lib/arm'
import type { DeviceTypeInfo, ActiveDeviceInfo } from 'litearm-js/browser'

export type PayloadState = {
  mass: number
  comX: number
  comY: number
  comZ: number
}

export type InstallationState = {
  roll: number
  pitch: number
  yaw: number
}

export type GravityScaleState = {
  /** 7 个关节的标定系数（最近一次下发或读取的目标/生效值）。 */
  values: number[]
  /** 服务端是否正处于 2s 平滑渐变中（渐变期间 get 返回 target）。 */
  easing: boolean
}

export type GainsState = {
  kp: number[]
  kd: number[]
}

export type JointLimitsState = {
  limits?: ([number, number] | { min: number; max: number })[]
  [key: string]: unknown
}

export type ZeroOffsetsState = {
  offsets?: number[]
  [key: string]: unknown
}

export type CartesianLimitsState = {
  linear_velocity?: number
  angular_velocity?: number
  linear_acceleration?: number
  angular_acceleration?: number
  [key: string]: unknown
}

export type CollisionConfigState = {
  enabled?: boolean
  sensitivity?: number
  [key: string]: unknown
}

export type SystemStats = {
  cpu_percent: number
  mem_percent: number
  disk_percent: number
  board_temp: number
  uptime_seconds: number
}

const GRAVITY_JOINTS = 7
const DEFAULT_GRAVITY_SCALE = Array.from({ length: GRAVITY_JOINTS }, () => 1)

function normalizeScaleArray(v?: number[] | null): number[] {
  return Array.from({ length: GRAVITY_JOINTS }, (_, i) => {
    const n = Number(v?.[i])
    return Number.isFinite(n) ? n : 1
  })
}

export function useSettingsState() {
  const { status, endpoint } = useArmConnection()
  const connected = status === 'connected'
  const canEdit = connected

  // 反馈提示统一走 toast
  const showAlert = useCallback((type: 'success' | 'error' | 'info', text: string) => {
    if (type === 'success') toast.success(text)
    else if (type === 'error') toast.error(text)
    else toast.info(text)
  }, [])

  // 1. 负载 (Payload)
  const [payload, setPayload] = useState<PayloadState>({ mass: 0, comX: 0, comY: 0, comZ: 0 })
  const [loadingPayload, setLoadingPayload] = useState(false)
  const [savingPayload, setSavingPayload] = useState(false)

  const fetchPayload = useCallback(async () => {
    if (!connected) return
    setLoadingPayload(true)
    try {
      const p = await armClient.withArm((a) => a.getPayload())
      setPayload({
        mass: Number(p.mass) || 0,
        comX: Number(p.com?.[0]) || 0,
        comY: Number(p.com?.[1]) || 0,
        comZ: Number(p.com?.[2]) || 0,
      })
    } catch (e: any) {
      showAlert('error', `获取末端负载失败: ${formatArmError(e)}`)
    } finally {
      setLoadingPayload(false)
    }
  }, [connected, showAlert])

  const savePayload = useCallback(
    async (p: PayloadState): Promise<boolean> => {
      if (!connected) return false
      setSavingPayload(true)
      try {
        const res = await armClient.withArm((a) => a.setPayload(p.mass, [p.comX, p.comY, p.comZ]))
        await armClient.withArm((a) => a.savePayload())
        setPayload({
          mass: Number(res.mass) || 0,
          comX: Number(res.com?.[0]) || 0,
          comY: Number(res.com?.[1]) || 0,
          comZ: Number(res.com?.[2]) || 0,
        })
        showAlert('success', `末端负载已应用并写盘保存 (质量: ${p.mass} kg, COM: [${p.comX}, ${p.comY}, ${p.comZ}])`)
        return true
      } catch (e: any) {
        showAlert('error', `保存末端负载失败: ${formatArmError(e)}`)
        return false
      } finally {
        setSavingPayload(false)
      }
    },
    [connected, showAlert],
  )

  // 2. 安装与重力补偿 (Installation)
  const [installation, setInstallation] = useState<InstallationState>({
    roll: 0,
    pitch: 0,
    yaw: 0,
  })
  const [loadingInstallation, setLoadingInstallation] = useState(false)
  const [savingInstallation, setSavingInstallation] = useState(false)

  const fetchInstallation = useCallback(async () => {
    if (!connected) return
    setLoadingInstallation(true)
    try {
      const inst = await armClient.withArm((a) => a.getInstallation())
      const rpy = inst.base_rpy || [0, 0, 0]
      setInstallation({
        roll: Number(rpy[0]) || 0,
        pitch: Number(rpy[1]) || 0,
        yaw: Number(rpy[2]) || 0,
      })
    } catch (e: any) {
      showAlert('error', `获取安装方位失败: ${formatArmError(e)}`)
    } finally {
      setLoadingInstallation(false)
    }
  }, [connected, showAlert])

  const saveInstallationRpy = useCallback(
    async (roll: number, pitch: number, yaw: number): Promise<boolean> => {
      if (!connected) return false
      setSavingInstallation(true)
      try {
        await armClient.withArm((a) => a.setInstallation([roll, pitch, yaw]))
        await armClient.withArm((a) => a.saveInstallation())
        setInstallation({ roll, pitch, yaw })
        showAlert('success', `基座安装位姿已应用并写盘保存 (RPY: [${roll}, ${pitch}, ${yaw}])`)
        return true
      } catch (e: any) {
        showAlert('error', `更新安装位姿失败: ${formatArmError(e)}`)
        return false
      } finally {
        setSavingInstallation(false)
      }
    },
    [connected, showAlert],
  )

  // 2b. 逐关节重力标定系数 (Gravity Scale)
  const [gravityScale, setGravityScaleState] = useState<GravityScaleState>({
    values: [...DEFAULT_GRAVITY_SCALE],
    easing: false,
  })
  const [loadingGravityScale, setLoadingGravityScale] = useState(false)
  const [savingGravityScale, setSavingGravityScale] = useState(false)
  // 保存后 ~2.5s 自动收起“平滑渐变中”徽标（与上游默认 transition_s=2 对齐）
  const easingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (easingTimer.current) clearTimeout(easingTimer.current)
    }
  }, [])

  const fetchGravityScale = useCallback(async () => {
    if (!connected) return
    setLoadingGravityScale(true)
    try {
      const g = await armClient.withArm((a) => a.getGravityScale())
      setGravityScaleState({
        values: normalizeScaleArray(g.scale),
        easing: Array.isArray(g.target) && g.target.length > 0,
      })
    } catch (e: any) {
      showAlert('error', `获取重力标定系数失败: ${formatArmError(e)}`)
    } finally {
      setLoadingGravityScale(false)
    }
  }, [connected, showAlert])

  const saveGravityScale = useCallback(
    async (scale: number[], transitionS = 2): Promise<boolean> => {
      if (!connected) return false
      setSavingGravityScale(true)
      try {
        const target = normalizeScaleArray(scale)
        const res = await armClient.withArm((a) => a.setGravityScale(target, transitionS))
        await armClient.withArm((a) => a.saveGravityScale())
        const isEasing = Array.isArray(res.target) && res.target.length > 0
        if (easingTimer.current) {
          clearTimeout(easingTimer.current)
          easingTimer.current = null
        }
        if (isEasing) {
          easingTimer.current = setTimeout(() => {
            setGravityScaleState((prev) => ({ ...prev, easing: false }))
            easingTimer.current = null
          }, 2600)
        }
        setGravityScaleState({
          values: normalizeScaleArray(res.target ?? target),
          easing: isEasing,
        })
        showAlert('success', `逐关节重力标定系数已应用并写盘保存: [${target.join(', ')}]`)
        return true
      } catch (e: any) {
        showAlert('error', `保存重力标定系数失败: ${formatArmError(e)}`)
        return false
      } finally {
        setSavingGravityScale(false)
      }
    },
    [connected, showAlert],
  )

  // 3. 安全限幅与配置 (Safety & Limits)
  const [jointLimits, setJointLimits] = useState<JointLimitsState | null>(null)
  const [zeroOffsets, setZeroOffsets] = useState<ZeroOffsetsState | null>(null)
  const [cartesianLimits, setCartesianLimits] = useState<CartesianLimitsState | null>(null)
  const [collisionConfig, setCollisionConfig] = useState<CollisionConfigState | null>(null)
  const [loadingLimits, setLoadingLimits] = useState(false)
  const [savingLimits, setSavingLimits] = useState(false)

  const fetchLimits = useCallback(async () => {
    if (!connected) return
    setLoadingLimits(true)
    try {
      const [jl, zo, cl, cc] = await Promise.all([
        armClient.withArm((a) => a.getJointLimits()).catch(() => null),
        armClient.withArm((a) => a.getZeroOffsets()).catch(() => null),
        armClient.withArm((a) => a.getCartesianLimits()).catch(() => null),
        armClient.withArm((a) => a.getCollisionConfig()).catch(() => null),
      ])
      setJointLimits(jl)
      setZeroOffsets(zo)
      setCartesianLimits(cl)
      setCollisionConfig(cc)
    } catch (e: any) {
      showAlert('error', `拉取限幅配置失败: ${formatArmError(e)}`)
    } finally {
      setLoadingLimits(false)
    }
  }, [connected, showAlert])

  const saveJointLimits = useCallback(
    async (limits: Record<string, unknown>): Promise<boolean> => {
      if (!connected) return false
      setSavingLimits(true)
      try {
        const res = await armClient.withArm((a) => a.setJointLimits(limits))
        setJointLimits(res)
        showAlert('success', '关节软限位已成功下发并生效')
        return true
      } catch (e: any) {
        showAlert('error', `保存关节限位失败: ${formatArmError(e)}`)
        return false
      } finally {
        setSavingLimits(false)
      }
    },
    [connected, showAlert],
  )

  const saveZeroOffsets = useCallback(
    async (offsets: Record<string, unknown>): Promise<boolean> => {
      if (!connected) return false
      setSavingLimits(true)
      try {
        const res = await armClient.withArm((a) => a.setZeroOffsets(offsets))
        setZeroOffsets(res)
        showAlert('success', '关节零点偏置已保存写盘')
        return true
      } catch (e: any) {
        showAlert('error', `保存零点偏置失败: ${formatArmError(e)}`)
        return false
      } finally {
        setSavingLimits(false)
      }
    },
    [connected, showAlert],
  )

  const saveCartesianLimits = useCallback(
    async (limits: Record<string, unknown>): Promise<boolean> => {
      if (!connected) return false
      setSavingLimits(true)
      try {
        const res = await armClient.withArm((a) => a.setCartesianLimits(limits))
        setCartesianLimits(res)
        showAlert('success', '笛卡尔空间限幅参数已更新')
        return true
      } catch (e: any) {
        showAlert('error', `保存笛卡尔限幅失败: ${formatArmError(e)}`)
        return false
      } finally {
        setSavingLimits(false)
      }
    },
    [connected, showAlert],
  )

  const saveCollisionConfig = useCallback(
    async (config: Record<string, unknown>): Promise<boolean> => {
      if (!connected) return false
      setSavingLimits(true)
      try {
        const res = await armClient.withArm((a) => a.setCollisionConfig(config))
        setCollisionConfig(res)
        showAlert('success', '碰撞检测安全配置已写盘更新')
        return true
      } catch (e: any) {
        showAlert('error', `保存碰撞配置失败: ${formatArmError(e)}`)
        return false
      } finally {
        setSavingLimits(false)
      }
    },
    [connected, showAlert],
  )

  // 4. PD 增益与控制 (Gains & Control)
  const [gains, setGains] = useState<GainsState | null>(null)
  const [loadingGains, setLoadingGains] = useState(false)
  const [savingGains, setSavingGains] = useState(false)

  const fetchGains = useCallback(async () => {
    if (!connected) return
    setLoadingGains(true)
    try {
      const g = await armClient.withArm((a) => a.getGains())
      setGains({
        kp: g.kp.map(Number),
        kd: g.kd.map(Number),
      })
    } catch (e: any) {
      showAlert('error', `获取 PD 增益失败: ${formatArmError(e)}`)
    } finally {
      setLoadingGains(false)
    }
  }, [connected, showAlert])

  const saveGains = useCallback(
    async (kp: number[], kd: number[]): Promise<boolean> => {
      if (!connected) return false
      setSavingGains(true)
      try {
        const res = await armClient.withArm((a) => a.setGains(kp, kd))
        setGains({
          kp: res.kp.map(Number),
          kd: res.kd.map(Number),
        })
        showAlert('success', '关节 PD 控制增益已成功下发至伺服驱动器')
        return true
      } catch (e: any) {
        showAlert('error', `设置 PD 增益失败: ${formatArmError(e)}`)
        return false
      } finally {
        setSavingGains(false)
      }
    },
    [connected, showAlert],
  )

  const restoreDefaultGains = useCallback(async () => {
    if (!connected) return
    setSavingGains(true)
    try {
      const g = await armClient.withArm((a) => a.setGains())
      setGains({
        kp: g.kp.map(Number),
        kd: g.kd.map(Number),
      })
      showAlert('success', '已恢复控制器默认出厂 PD 增益')
    } catch (e: any) {
      showAlert('error', `恢复默认增益失败: ${formatArmError(e)}`)
    } finally {
      setSavingGains(false)
    }
  }, [connected, showAlert])

  const clearFaults = useCallback(async () => {
    if (!connected) return
    try {
      const res = await armClient.withArm((a) => a.clearFaults())
      showAlert('success', `驱动故障已清除: ${JSON.stringify(res)}`)
    } catch (e: any) {
      showAlert('error', `清除故障失败: ${formatArmError(e)}`)
    }
  }, [connected, showAlert])

  const clearStop = useCallback(async () => {
    if (!connected) return
    try {
      await armClient.withArm((a) => a.clearStop())
      showAlert('success', '急停锁存状态已解除')
    } catch (e: any) {
      showAlert('error', `解除急停失败: ${formatArmError(e)}`)
    }
  }, [connected, showAlert])

  // 5. 系统监控与运维 (System Diagnostics & Service)
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null)
  const [loadingStats, setLoadingStats] = useState(false)
  const [restartingService, setRestartingService] = useState(false)

  const fetchSystemStats = useCallback(async () => {
    if (!connected) return
    setLoadingStats(true)
    try {
      const s = await armClient.withArm((a) => a.getSystemStats())
      setSystemStats({
        cpu_percent: Number(s.cpu_percent) || 0,
        mem_percent: Number(s.mem_percent) || 0,
        disk_percent: Number(s.disk_percent) || 0,
        board_temp: Number(s.board_temp) || 0,
        uptime_seconds: Number(s.uptime_seconds) || 0,
      })
    } catch {
      // 轮询时不频繁弹 toast
    } finally {
      setLoadingStats(false)
    }
  }, [connected])

  const restartService = useCallback(async () => {
    if (!connected) return
    setRestartingService(true)
    try {
      await armClient.withArm((a) => a.restartService())
      showAlert('info', '重启指令已发送至控制器，服务正在重启并重连...')
    } catch (e: any) {
      showAlert('error', `发送重启指令失败: ${formatArmError(e)}`)
    } finally {
      setRestartingService(false)
    }
  }, [connected, showAlert])

  // 6. 运动学与动力学配置 (Kinematics & Dynamics YAML Config)
  const [yamlContent, setYamlContent] = useState<string>('')
  const [loadingKinematics, setLoadingKinematics] = useState(false)
  const [savingKinematics, setSavingKinematics] = useState(false)
  const [editorMode, setEditorMode] = useState<'visual' | 'code'>('visual')

  const fetchConfigYaml = useCallback(async () => {
    if (!connected) return
    setLoadingKinematics(true)
    try {
      const res = await armClient.getConfigYaml()
      if (res && res.yaml_content) {
        setYamlContent(res.yaml_content)
      }
    } catch {
      // 若后端尚未就绪 getConfigYaml，降级提取本地合并的配置
    } finally {
      setLoadingKinematics(false)
    }
  }, [connected])

  const saveConfigYaml = useCallback(
    async (content: string): Promise<boolean> => {
      if (!connected) return false
      setSavingKinematics(true)
      try {
        const res = await armClient.setConfigYaml(content)
        if (res && res.ok === false && res.error) {
          showAlert('error', `保存 YAML 配置失败: ${res.error}`)
          return false
        }
        setYamlContent(content)
        showAlert('success', 'YAML 运动学/动力学配置已写盘写盘保存！建议重启服务以生效新模型。')
        return true
      } catch (e: any) {
        showAlert('error', `保存 YAML 配置失败: ${formatArmError(e)}`)
        return false
      } finally {
        setSavingKinematics(false)
      }
    },
    [connected, showAlert],
  )

  // 6. 末端设备与执行器 (End-Effector & Hand)
  // 型号列表只以服务端 list_device_types 为准，不再内置写死的占位型号。
  const [deviceTypes, setDeviceTypes] = useState<DeviceTypeInfo[]>([])
  const [activeDevice, setActiveDevice] = useState<ActiveDeviceInfo | null>(null)
  const [loadingDevice, setLoadingDevice] = useState(false)
  const [connectingDevice, setConnectingDevice] = useState(false)

  const fetchDeviceStatus = useCallback(async () => {
    if (!connected) return
    setLoadingDevice(true)
    try {
      const [types, active] = await Promise.all([
        armClient.listDeviceTypes().catch(() => []),
        armClient.getActiveDevice().catch(() => null),
      ])
      // 服务端为准：即使返回空列表也覆盖本地状态，避免残留上次连接的型号。
      setDeviceTypes(types)
      if (active) setActiveDevice(active)
    } catch {
      // 忽略
    } finally {
      setLoadingDevice(false)
    }
  }, [connected])

  const connectDevice = useCallback(
    async (category: string, subtype: string, canIface: string = 'can0', config?: Record<string, unknown>) => {
      if (!connected) {
        showAlert('error', '未连接控制器，无法挂载设备')
        return false
      }
      setConnectingDevice(true)
      try {
        const res = await armClient.connectDevice(category, subtype, { canIface, config })
        if (res && res.ok === false) {
          showAlert('error', `挂载末端设备失败: ${res.error || '未知错误'}`)
          return false
        }
        await fetchDeviceStatus()
        showAlert('success', `末端设备 ${subtype} 已成功挂载并在线！`)
        return true
      } catch (e: any) {
        showAlert('error', `挂载设备异常: ${formatArmError(e)}`)
        return false
      } finally {
        setConnectingDevice(false)
      }
    },
    [connected, showAlert, fetchDeviceStatus],
  )

  const disconnectDevice = useCallback(
    async (deviceId: string = 'end_0') => {
      if (!connected) {
        showAlert('error', '未连接控制器')
        return false
      }
      setConnectingDevice(true)
      try {
        const res = await armClient.disconnectDevice(deviceId)
        if (res && res.ok === false) {
          showAlert('error', '卸载末端设备失败')
          return false
        }
        await fetchDeviceStatus()
        showAlert('info', '末端设备已安全卸载')
        return true
      } catch (e: any) {
        showAlert('error', `卸载设备异常: ${formatArmError(e)}`)
        return false
      } finally {
        setConnectingDevice(false)
      }
    },
    [connected, showAlert, fetchDeviceStatus],
  )

  // 初始化加载与定时刷新系统状态
  useEffect(() => {
    if (connected) {
      fetchPayload()
      fetchInstallation()
      fetchGravityScale()
      fetchLimits()
      fetchGains()
      fetchSystemStats()
      fetchDeviceStatus()

      const timer = setInterval(() => {
        fetchSystemStats()
      }, 3000)
      return () => clearInterval(timer)
    } else {
      setSystemStats(null)
    }
  }, [connected, fetchPayload, fetchInstallation, fetchGravityScale, fetchLimits, fetchGains, fetchSystemStats, fetchDeviceStatus])

  return {
    connected,
    canEdit,
    endpoint,
    showAlert,
    // 负载
    payload,
    setPayload,
    loadingPayload,
    savingPayload,
    fetchPayload,
    savePayload,
    // 安装位姿
    installation,
    setInstallation,
    loadingInstallation,
    savingInstallation,
    fetchInstallation,
    saveInstallationRpy,
    // 逐关节重力标定
    gravityScale,
    loadingGravityScale,
    savingGravityScale,
    fetchGravityScale,
    saveGravityScale,
    // 安全与限幅
    jointLimits,
    zeroOffsets,
    cartesianLimits,
    collisionConfig,
    loadingLimits,
    savingLimits,
    fetchLimits,
    saveJointLimits,
    saveZeroOffsets,
    saveCartesianLimits,
    saveCollisionConfig,
    // 控制增益
    gains,
    loadingGains,
    savingGains,
    fetchGains,
    saveGains,
    restoreDefaultGains,
    clearFaults,
    clearStop,
    // 运动学与动力学 (YAML Config)
    yamlContent,
    setYamlContent,
    loadingKinematics,
    savingKinematics,
    editorMode,
    setEditorMode,
    fetchConfigYaml,
    saveConfigYaml,
    // 末端设备与灵巧手
    deviceTypes,
    activeDevice,
    loadingDevice,
    connectingDevice,
    fetchDeviceStatus,
    connectDevice,
    disconnectDevice,
    // 系统监控与服务
    systemStats,
    loadingStats,
    restartingService,
    fetchSystemStats,
    restartService,
  }
}

export type SettingsState = ReturnType<typeof useSettingsState>
