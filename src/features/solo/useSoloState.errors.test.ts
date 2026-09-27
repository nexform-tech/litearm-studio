import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

const mocks = vi.hoisted(() => ({
  getJointParams: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    warning: mocks.toastWarning,
    error: mocks.toastError,
    success: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/lib/arm', () => ({
  armClient: { getJointParams: mocks.getJointParams },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useArmConnection: () => ({ status: 'connected' }),
  useArmState: () => null,
  useArmMetrics: () => ({}),
}))

const { useSoloState } = await import('./useSoloState')

const LIMITS = Array.from({ length: 7 }, (_, i) => ({
  idx: i,
  kp: 1,
  kd: 1,
  tau_max: 1,
  q_min: -1,
  q_max: 1,
}))

describe('useSoloState joint-limit readback', () => {
  beforeEach(() => {
    mocks.getJointParams.mockReset()
    mocks.toastWarning.mockReset()
    mocks.toastError.mockReset()
  })

  it('warns when the limits cannot be read instead of silently using built-in ranges', async () => {
    mocks.getJointParams.mockRejectedValueOnce(new Error('boom'))

    renderHook(() => useSoloState())

    await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalledTimes(1))
    expect(mocks.toastWarning.mock.calls[0][1]).toMatchObject({ id: 'joint-limits-fallback' })
  })

  it('stays quiet when the limits are read back', async () => {
    mocks.getJointParams.mockResolvedValueOnce(LIMITS)

    renderHook(() => useSoloState())

    await waitFor(() => expect(mocks.getJointParams).toHaveBeenCalledTimes(1))
    expect(mocks.toastWarning).not.toHaveBeenCalled()
  })
})
