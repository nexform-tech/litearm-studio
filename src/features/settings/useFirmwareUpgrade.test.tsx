import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

const mocks = vi.hoisted(() => ({
  firmwareInspect: vi.fn(),
  firmwareUpgrade: vi.fn(),
  firmwareStatus: vi.fn(),
  firmwareCancel: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  onProgress: null as null | ((p: unknown) => void),
  onResult: null as null | ((r: unknown) => void),
  offProgress: vi.fn(),
  offResult: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}))

vi.mock('@/lib/arm', () => ({
  armClient: {
    firmwareInspect: mocks.firmwareInspect,
    firmwareUpgrade: mocks.firmwareUpgrade,
    firmwareStatus: mocks.firmwareStatus,
    firmwareCancel: mocks.firmwareCancel,
    onFirmwareProgress: (cb: (p: unknown) => void) => {
      mocks.onProgress = cb
      return mocks.offProgress
    },
    onFirmwareResult: (cb: (r: unknown) => void) => {
      mocks.onResult = cb
      return mocks.offResult
    },
  },
  useArmConnection: () => ({
    status: 'connected',
    conn: { status: 'connected', port: '/dev/ttyACM0', firmware: 'Litearm1.8.0-7J', n: 7, cart: true, error: null },
  }),
  useArmState: () => ({ enabled: false }),
  formatArmError: (err: unknown) => String((err as Error)?.message ?? err),
  formatFirmwareReason: (reason: string | null, fallback: string) => reason ?? fallback,
}))

const { useFirmwareUpgrade } = await import('./useFirmwareUpgrade')

const SUMMARY = {
  token: 'tok-1',
  name: 'Litearm1.9.0-7J.hex',
  format: 'hex',
  base: 0x08000000,
  size: 103840,
  holes: 0,
  version: 'Litearm1.9.0-7J',
  versionNote: '',
  sha256: 'a'.repeat(64),
}

const file = () => new File([':00000001FF\n'], 'fw.hex')

describe('useFirmwareUpgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.onProgress = null
    mocks.onResult = null
    mocks.firmwareStatus.mockResolvedValue({
      job: null, engine: 'libusb-package: /x/libusb-1.0.so', engineReady: true,
    })
    mocks.firmwareInspect.mockResolvedValue(SUMMARY)
    mocks.firmwareUpgrade.mockResolvedValue({ job: 'fw-1', phase: 'validate' })
    mocks.firmwareCancel.mockResolvedValue({ cancelled: true })
  })

  it('reports engine readiness before anything is picked', async () => {
    const { result } = renderHook(() => useFirmwareUpgrade())
    await waitFor(() => expect(result.current.engineReady).toBe(true))
    expect(result.current.engine?.label).toContain('libusb')
  })

  it('uploads the file and shows the summary the daemon returns', async () => {
    const { result } = renderHook(() => useFirmwareUpgrade())
    await waitFor(() => expect(result.current.engine).not.toBeNull())

    await act(async () => {
      await result.current.pick(file())
    })

    expect(mocks.firmwareInspect).toHaveBeenCalledTimes(1)
    expect(result.current.summary).toEqual(SUMMARY)
    expect(result.current.error).toBeNull()
  })

  it('clears the previous summary when a new file is rejected', async () => {
    // ⚠ 这里最危险的形状是：用户以为换好了文件，屏幕上却还留着上一份的摘要。
    mocks.firmwareInspect
      .mockResolvedValueOnce(SUMMARY)
      .mockRejectedValueOnce(new Error('镜像覆盖受保护扇区'))
    const { result } = renderHook(() => useFirmwareUpgrade())

    await act(async () => {
      await result.current.pick(file())
    })
    expect(result.current.summary).toEqual(SUMMARY)

    await act(async () => {
      await result.current.pick(file())
    })
    expect(result.current.summary).toBeNull()
    expect(result.current.error).toContain('受保护扇区')
  })

  it('treats a started job as running until the result frame arrives', async () => {
    const { result } = renderHook(() => useFirmwareUpgrade())
    await waitFor(() => expect(mocks.onProgress).not.toBeNull())

    await act(async () => {
      await result.current.pick(file())
    })
    await act(async () => {
      expect(await result.current.start()).toBe(true)
    })
    expect(mocks.firmwareUpgrade).toHaveBeenCalledWith('tok-1')
    // ⚠ `start()` 返回成功只说明"已经开跑"，不是"升级成功" —— 进度与终局只认帧。
    expect(result.current.result).toBeNull()

    act(() => {
      mocks.onProgress?.({ job: 'fw-1', phase: 'flash', done: 512, total: 1024, detail: '写入 512 B' })
    })
    expect(result.current.running).toBe(true)
    expect(result.current.progress?.phase).toBe('flash')

    act(() => {
      mocks.onResult?.({
        job: 'fw-1', ok: true, reason: null, msg: 'done',
        version: 'Litearm1.9.0-7J', port: '/dev/ttyACM0', warning: null,
      })
    })
    expect(result.current.running).toBe(false)
    expect(result.current.result?.ok).toBe(true)
    expect(mocks.success).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed result through the reason short code, not the daemon message', async () => {
    const { result } = renderHook(() => useFirmwareUpgrade())
    await waitFor(() => expect(mocks.onResult).not.toBeNull())
    await act(async () => {
      await result.current.pick(file())
    })
    await act(async () => {
      await result.current.start()
    })

    act(() => {
      mocks.onResult?.({
        job: 'fw-1', ok: false, reason: 'reconnect_failed',
        msg: '固件已写入…', version: null, port: null, warning: null,
      })
    })

    expect(result.current.result?.ok).toBe(false)
    // 文案按短码选 —— `msg` 是守护进程写的中文，英文界面必须换一句。
    expect(mocks.error).toHaveBeenCalledWith('reconnect_failed', expect.anything())
  })

  it('reports a refused start instead of pretending the upgrade began', async () => {
    mocks.firmwareUpgrade.mockRejectedValueOnce(new Error('这台机器上没有可用的 USB 烧录引擎'))
    const { result } = renderHook(() => useFirmwareUpgrade())
    await act(async () => {
      await result.current.pick(file())
    })
    await act(async () => {
      expect(await result.current.start()).toBe(false)
    })
    expect(result.current.error).toContain('烧录引擎')
    expect(result.current.job).toBeNull()
  })

  it('asks the daemon to cancel', async () => {
    const { result } = renderHook(() => useFirmwareUpgrade())
    await act(async () => {
      await result.current.cancel()
    })
    expect(mocks.firmwareCancel).toHaveBeenCalledTimes(1)
  })

  it('picks a running job back up so a reloaded page keeps its progress bar', async () => {
    mocks.firmwareStatus.mockResolvedValue({
      job: 'fw-9', engine: 'e', engineReady: true, phase: 'flash',
      done: 5, total: 10, detail: '写入', result: null,
    })
    const { result } = renderHook(() => useFirmwareUpgrade())
    await waitFor(() => expect(result.current.job).toBe('fw-9'))
    expect(result.current.progress?.phase).toBe('flash')
  })
})
