import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

const mocks = vi.hoisted(() => {
  const listeners = new Set<(a: unknown) => void>()
  return {
    listeners,
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
  }
})

vi.mock('sonner', () => ({ toast: mocks.toast }))

vi.mock('@/lib/arm/gripperClient', () => ({
  gripperClient: {
    subscribeAlert: (cb: (a: unknown) => void) => {
      mocks.listeners.add(cb)
      return () => mocks.listeners.delete(cb)
    },
  },
}))

const { useGripperAlerts } = await import('./useGripper')

function emit(alert: Record<string, unknown>) {
  for (const cb of [...mocks.listeners]) cb(alert)
}

describe('useGripperAlerts', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    vi.clearAllMocks()
  })

  afterEach(async () => {
    mocks.listeners.clear()
    await i18n.changeLanguage('zh')
  })

  it('translates a refusal that carries a wire kind', () => {
    renderHook(() => useGripperAlerts())
    emit({ level: 'warn', text: '「闭合」被拒绝：标称模板（从未实测）', kind: 'GripperCalibrationError' })

    // 英文界面下必须是英文标签 + daemon 的原文作为详情。
    const [text] = mocks.toast.warning.mock.calls[0]
    expect(text).toMatch(/calibration does not allow/i)
    expect(text).toContain('「闭合」被拒绝')
    expect(text).not.toMatch(/^「/)
  })

  it('translates a drive fault and keeps the code visible', () => {
    renderHook(() => useGripperAlerts())
    emit({ level: 'error', text: '欠压故障 (UV) —— 请检查夹爪 24V 供电', kind: 'GripperFaultActiveError', code: 9 })

    const [text, options] = mocks.toast.error.mock.calls[0]
    expect(text).toMatch(/reports a fault/i)
    expect(text).toContain('欠压故障')
    expect(options).toMatchObject({ id: 'gripper-alert' })
  })

  it('shows the daemon text as-is when there is no kind to translate', () => {
    renderHook(() => useGripperAlerts())
    emit({ level: 'warn', text: '当前没有正在进行的标定' })

    expect(mocks.toast.warning).toHaveBeenCalledWith('当前没有正在进行的标定',
                                                    { id: 'gripper-alert' })
  })

  it('falls back to the text for a kind nobody has a translation for', () => {
    renderHook(() => useGripperAlerts())
    emit({ level: 'error', text: '命令失败「闭合」: boom', kind: 'TypeError' })

    expect(mocks.toast.error).toHaveBeenCalledWith('命令失败「闭合」: boom',
                                                   { id: 'gripper-alert' })
  })

  it('uses one stable toast id so a burst does not stack', () => {
    renderHook(() => useGripperAlerts())
    emit({ level: 'warn', text: 'a' })
    emit({ level: 'warn', text: 'b' })
    for (const call of mocks.toast.warning.mock.calls) {
      expect(call[1]).toMatchObject({ id: 'gripper-alert' })
    }
  })

  it('stops listening when the component unmounts', () => {
    const { unmount } = renderHook(() => useGripperAlerts())
    unmount()
    emit({ level: 'warn', text: 'x' })
    expect(mocks.toast.warning).not.toHaveBeenCalled()
  })
})
