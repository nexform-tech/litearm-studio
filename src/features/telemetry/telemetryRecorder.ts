/**
 * 前端遥测记录器：跟随机械臂连接自动开/停会话，把 RobotState 采样写入 IndexedDB。
 *
 * - 数据源与图表一致：armClient 的状态订阅（内部已降频到 ~10Hz）；
 * - 会话 = 一次臂连接；断线后 30s 内重连则延续同一会话（真机偶发断流不切碎日志）；
 * - 只在前端运行期间记录（控制台关闭即停止），数据保存在本机。
 */

import { armClient } from '@/lib/arm/client'
import { MAX_SESSIONS, telemetryDb, type NewTelemetrySample } from './telemetryDb'
import { getRetentionMb, retentionMbToBytes, setRetentionMb as saveRetentionMb } from './retentionSettings'

export const SAMPLE_HZ = 10
const SESSION_FINALIZE_DELAY_MS = 30_000
const FLUSH_INTERVAL_MS = 1000
const MAX_PENDING = 500
const PRUNE_MAX_INTERVAL_MS = 30_000

type Listener = () => void

class TelemetryRecorder {
  private sessionId: number | null = null
  private sessionReady: Promise<number | null> | null = null
  private endpoint = ''
  private robotSerial = ''
  private startedAt: number | null = null
  private lastSampleAt: number | null = null
  private samplesRecorded = 0
  private pending: NewTelemetrySample[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null
  private lastPruneAt = 0
  private listeners = new Set<Listener>()
  private stateUnsub: (() => void) | null = null
  private statusUnsub: (() => void) | null = null
  private started = false

  start() {
    if (this.started) return
    this.started = true
    // 保留策略为体积上限（用户可配置），启动时只兜底收尾上次异常退出遗留的会话
    void telemetryDb.finalizeOpenSessions()
    this.lastPruneAt = 0
    this.stateUnsub = armClient.subscribeState(this.onState)
    this.statusUnsub = armClient.subscribeStatus(this.onStatus)
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    this.onStatus() // 若已在连接中，立即补开会话
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.onPageHide)
    }
  }

  stop() {
    if (!this.started) return
    this.started = false
    this.stateUnsub?.()
    this.statusUnsub?.()
    this.stateUnsub = null
    this.statusUnsub = null
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer)
      this.finalizeTimer = null
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.onPageHide)
    }
    void this.endSession()
  }

  subscribe = (cb: Listener) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  getStatus() {
    return {
      recording: this.sessionId !== null && armClient.status === 'connected',
      endpoint: this.endpoint || armClient.endpointValue,
      robotSerial: this.robotSerial,
      startedAt: this.startedAt,
      lastSampleAt: this.lastSampleAt,
      samplesRecorded: this.samplesRecorded,
      sampleHz: SAMPLE_HZ,
      maxBytes: retentionMbToBytes(getRetentionMb()),
    }
  }

  /** 修改保留上限（MB，自动收敛到最小/最大范围），立即按新上限裁剪并通知 UI。 */
  setRetentionMb = (mb: number): number => {
    const clamped = saveRetentionMb(mb)
    this.lastPruneAt = 0
    void this.maybePrune()
    this.notify()
    return clamped
  }

  private onStatus = () => {
    if (armClient.status === 'connected') {
      // 断线后 30s 内重连：取消收尾定时器，继续原会话
      if (this.finalizeTimer) {
        clearTimeout(this.finalizeTimer)
        this.finalizeTimer = null
      }
      if (this.sessionId === null) this.openSession()
    } else if (this.sessionId !== null && !this.finalizeTimer) {
      // 真机偶发断流：30s 内重连成功则继续原会话
      this.finalizeTimer = setTimeout(() => {
        this.finalizeTimer = null
        void this.endSession()
      }, SESSION_FINALIZE_DELAY_MS)
    }
  }

  private openSession() {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer)
      this.finalizeTimer = null
    }
    this.endpoint = armClient.endpointValue
    this.robotSerial = armClient.state?.robotSerial ?? ''
    this.startedAt = Date.now() / 1000
    this.lastSampleAt = null
    this.samplesRecorded = 0
    this.sessionReady = telemetryDb
      .addSession(this.startedAt, this.endpoint, this.robotSerial)
      .then((id) => {
        this.sessionId = id
        this.notify()
        return id
      })
      .catch((err) => {
        console.warn('遥测会话创建失败：', err)
        return null
      })
  }

  private onState = () => {
    const s = armClient.state
    if (!s) return
    if (s.robotSerial && s.robotSerial !== this.robotSerial) {
      this.robotSerial = s.robotSerial
    }
    this.lastSampleAt = Date.now() / 1000
    this.samplesRecorded += 1
    this.pending.push({
      ts: this.lastSampleAt,
      state: s.state,
      q: (s.q ?? []).slice(),
      dq: (s.dq ?? []).slice(),
      tau: (s.tau ?? []).slice(),
      temps: (s.temps ?? []).map((t) => ({
        mosTemp: typeof t?.mosTemp === 'number' && !isNaN(t.mosTemp) ? t.mosTemp : 0,
        coilTemp: typeof t?.coilTemp === 'number' && !isNaN(t.coilTemp) ? t.coilTemp : 0,
      })),
      errs: (s.errs ?? []).slice(),
      faults: (s.fault ?? []).slice(),
    })
    if (this.pending.length >= MAX_PENDING) void this.flush()
  }

  private async flush() {
    if (this.pending.length === 0) return
    const ready = this.sessionReady
    if (ready) await ready
    if (this.sessionId === null) return
    const batch = this.pending.splice(0, this.pending.length)
    try {
      await telemetryDb.addSamples(this.sessionId, batch)
    } catch (err) {
      // 写库失败（如配额不足）时丢弃本批，避免阻塞主流程
      console.warn('遥测采样写入失败：', err)
      return
    }
    this.maybePrune()
  }

  private maybePrune() {
    const now = Date.now()
    if (now - this.lastPruneAt < PRUNE_MAX_INTERVAL_MS) return
    this.lastPruneAt = now
    void telemetryDb.pruneToMaxBytes(retentionMbToBytes(getRetentionMb()), MAX_SESSIONS)
  }

  private async endSession() {
    const ready = this.sessionReady
    if (ready) await ready
    await this.flush()
    const id = this.sessionId
    this.sessionId = null
    this.sessionReady = null
    this.samplesRecorded = 0
    if (id !== null) {
      try {
        await telemetryDb.endSession(id, Date.now() / 1000)
      } catch {
        // 收尾失败不影响下一次记录
      }
    }
    this.notify()
  }

  private onPageHide = () => {
    void this.endSession()
  }

  private notify() {
    for (const cb of this.listeners) cb()
  }
}

export const telemetryRecorder = new TelemetryRecorder()
