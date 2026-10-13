import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  armClient,
  formatArmError,
  formatFirmwareReason,
  useArmConnection,
  useArmState,
  type FirmwareImageSummary,
  type FirmwareProgress,
  type FirmwareResult,
} from '@/lib/arm'

/**
 * 固件升级的界面状态机。
 *
 * 与激活（`useActivation`）最大的不同：**升级的结果不来自命令应答**。`firmware_upgrade`
 * 只回一个 job 号就返回 —— 烧录可能几十秒（超过守护进程的命令超时），而且进 bootloader
 * 之后**没有机械臂会话**了，普通命令一律被拒。所以进度与终局都走广播帧（见
 * `client.onFirmwareProgress` / `onFirmwareResult`）。
 *
 * 因此这个 hook 有两件事必须做对：
 *
 * 1. **订阅先于开始**：在 `start()` 之前就把监听挂上，否则第一条进度会丢；
 * 2. **终局只认帧**：`start()` 返回成功只说明"已经开跑"，不是"升级成功"。
 */
export function useFirmwareUpgrade() {
  const { t } = useTranslation(['common', 'settings'])
  const { status, conn } = useArmConnection()
  const armState = useArmState()
  const connected = status === 'connected'
  /**
   * 升级中 —— 设备在 ROM bootloader 里，**是我们自己**把它交出去的。
   *
   * ⚠ 它与"断开"是两回事，界面必须分开说：`connected` 在这里为假（`conn.status` 是
   * `upgrading`），但这句"未连接控制器 —— 连上之后才能升级"恰好说反了 —— 设备不是掉了，
   * 是正在被刷。而且这是全程最需要操作员冷静的时刻，一句假警报会把人推去做多余的操作。
   * 守护进程专门为此设了这个状态（见 `client.ts` 的 `_applyConn`）。
   */
  const upgrading = status === 'upgrading'

  const [summary, setSummary] = useState<FirmwareImageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [starting, setStarting] = useState(false)
  const [progress, setProgress] = useState<FirmwareProgress | null>(null)
  const [result, setResult] = useState<FirmwareResult | null>(null)
  const [job, setJob] = useState<string | null>(null)
  const [engine, setEngine] = useState<{ ready: boolean; label: string } | null>(null)

  // 上一次上传的 `File` —— "重新选择"只在用户换了文件时才动，避免同一份镜像
  // 重复上传（一次几 MB 的 base64 不便宜）。
  const lastFile = useRef<File | null>(null)

  /** 引擎可不可用 —— **开跑之前**就要知道。跳进 bootloader 才发现没引擎最难收场。 */
  const refreshEngine = useCallback(async () => {
    try {
      const st = await armClient.firmwareStatus()
      setEngine({ ready: st.engineReady, label: st.engine })
      // ⚠ **只**恢复"还在跑"的那一次。已经结束的 job 一律不恢复 —— 上一次升级的结果
      //   不该在页面打开时冒出来：它不是这次发生的事，露出来只会让人以为刚跑完。
      //   （守护进程会把上一个 job 连同它的 `done` 相位一直留着，所以这里必须自己筛。）
      if (st.job && st.running) {
        setJob(st.job)
        setProgress({
          job: st.job,
          phase: st.phase ?? '',
          done: st.done ?? 0,
          total: st.total ?? 0,
          detail: st.detail ?? '',
        })
        setResult(null)
      }
    } catch (err) {
      // 守护进程没起来时不弹错：这一段是"顺手问一下"，不是用户动作。
      setEngine(null)
      void err
    }
  }, [])

  useEffect(() => {
    void refreshEngine()
  }, [refreshEngine])

  // 订阅必须**先于** `start()` 建立 —— 见上面的第 1 条。
  useEffect(() => {
    const offProgress = armClient.onFirmwareProgress((p) => {
      setProgress(p)
      if (p.phase === 'done') setStarting(false)
    })
    const offResult = armClient.onFirmwareResult((r) => {
      setResult(r)
      setProgress(null)
      setStarting(false)
      if (r.ok) {
        toast.success(t('settings:firmware.succeeded'), { id: 'firmware-upgrade' })
      } else {
        toast.error(
          formatFirmwareReason(r.reason, r.msg) || t('settings:firmware.failedTitle'),
          { id: 'firmware-upgrade' },
        )
      }
    })
    return () => {
      offProgress()
      offResult()
    }
  }, [t])

  /** 选文件 → 上传 → 离线校验。**失败在任何硬件动作之前**。 */
  const pick = useCallback(async (file: File) => {
    setInspecting(true)
    setError(null)
    try {
      const s = await armClient.firmwareInspect(file)
      lastFile.current = file
      setSummary(s)
    } catch (err) {
      // ⚠ 校验失败要**清掉**旧的摘要：把上一次的镜像留在屏幕上、而用户以为换好了，
      //   是这里最危险的一种状态。
      setSummary(null)
      setError(formatArmError(err) || String(err))
    } finally {
      setInspecting(false)
    }
  }, [])

  /** 重新选择 —— 复用上一次的文件对象，不再重复上传。 */
  const rePick = useCallback(async () => {
    const f = lastFile.current
    if (f) await pick(f)
  }, [pick])

  const start = useCallback(async (): Promise<boolean> => {
    if (!summary) return false
    setStarting(true)
    setError(null)
    setResult(null)
    try {
      const started = await armClient.firmwareUpgrade(summary.token)
      setJob(started.job)
      return true
    } catch (err) {
      setStarting(false)
      setError(formatArmError(err) || String(err))
      return false
    }
  }, [summary])

  const cancel = useCallback(async () => {
    try {
      await armClient.firmwareCancel()
    } catch (err) {
      setError(formatArmError(err) || String(err))
    }
  }, [])

  const reset = useCallback(() => {
    setSummary(null)
    setError(null)
    setResult(null)
    setProgress(null)
    setJob(null)
    lastFile.current = null
  }, [])

  // 连接一断，上一次的升级结果就不该继续挂在那儿（与激活面板同一条纪律）。
  // ⚠ 但 `upgrading` 不算"断了"：那是升级**自己**造成的脱开，进度与终局正是这个相位产生
  //   的 —— 在这里清掉，等于把升级正在用的状态删掉（`job` 没了、进度闪一下、失败时的
  //   终局也一起消失）。只清真正的掉线。
  useEffect(() => {
    if (!connected && !upgrading) {
      setResult(null)
      setProgress(null)
      setJob(null)
    }
  }, [connected, upgrading])

  return {
    connected,
    upgrading,
    firmware: conn?.firmware ?? '',
    port: conn?.port ?? '',
    armEnabled: armState?.enabled ?? null,
    engine,
    engineReady: engine?.ready ?? false,
    summary,
    error,
    inspecting,
    starting,
    progress,
    result,
    job,
    /** 升级进行中 —— 界面据此把所有入口锁死。 */
    running: progress !== null && !result,
    pick,
    rePick,
    start,
    cancel,
    reset,
    refreshEngine,
  }
}

export type FirmwareUpgradeState = ReturnType<typeof useFirmwareUpgrade>
