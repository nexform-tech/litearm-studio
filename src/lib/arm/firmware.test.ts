import { describe, expect, it } from 'vitest'
import {
  fileToBase64,
  normalizeFirmwareProgress,
  normalizeFirmwareResult,
  normalizeFirmwareStatus,
} from './firmware'

/**
 * 归一化必须**防守式**：守护进程可能比界面旧或新，少一个字段不该让整页打不开
 * （与 `normalizeLicense` 同一条纪律）。
 */
describe('firmware normalize', () => {
  it('fills in defaults for a progress frame with missing fields', () => {
    expect(normalizeFirmwareProgress({ job: 'fw-1', phase: 'flash' })).toEqual({
      job: 'fw-1', phase: 'flash', done: 0, total: 0, detail: '',
    })
    expect(normalizeFirmwareProgress(null)).toEqual({
      job: '', phase: '', done: 0, total: 0, detail: '',
    })
  })

  it('treats a missing ok as failure, never as success', () => {
    // ⚠ 方向不能反：把"没读到 ok"读成成功，会在烧录其实失败时说"升级完成"。
    const r = normalizeFirmwareResult({ job: 'fw-1', reason: 'flash_failed' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('flash_failed')
    expect(r.version).toBeNull()
  })

  it('keeps a result frame intact', () => {
    const r = normalizeFirmwareResult({
      job: 'fw-1', ok: true, reason: null, msg: 'done',
      version: 'Litearm1.9.0-7J', port: '/dev/ttyACM0', warning: 'check this',
    })
    expect(r.ok).toBe(true)
    expect(r.version).toBe('Litearm1.9.0-7J')
    expect(r.port).toBe('/dev/ttyACM0')
    expect(r.warning).toBe('check this')
  })

  it('reports a null job when nothing is running, and keeps engine readiness', () => {
    expect(normalizeFirmwareStatus({ engine: 'pyusb', engineReady: false }))
      .toEqual({ job: null, engine: 'pyusb', engineReady: false, running: false })
  })

  it('nests the result inside a status snapshot', () => {
    const s = normalizeFirmwareStatus({
      job: 'fw-1', engine: 'e', engineReady: true, phase: 'flash',
      done: 10, total: 100, detail: 'x',
      result: { job: 'fw-1', ok: true },
    })
    expect(s.phase).toBe('flash')
    expect(s.done).toBe(10)
    expect(s.result?.ok).toBe(true)
  })
})

describe('fileToBase64', () => {
  it('encodes the bytes the daemon will parse', async () => {
    const text = ':020000040800F2\n:00000001FF\n'
    const file = new File([text], 'fw.hex', { type: 'text/plain' })
    const b64 = await fileToBase64(file)
    expect(atob(b64)).toBe(text)
  })

  it('survives a payload larger than the argument-spread limit', async () => {
    // ⚠ `String.fromCharCode(...bytes)` 在几十万字节上会撑爆调用栈 —— 固件镜像
    //   正是这个量级，所以编码必须分块。
    const bytes = new Uint8Array(200_000).fill(0x41)
    const file = new File([bytes], 'fw.bin')
    const b64 = await fileToBase64(file)
    expect(b64.length).toBeGreaterThan(200_000)
    expect(atob(b64).length).toBe(200_000)
  })
})
