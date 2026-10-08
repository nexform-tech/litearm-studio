import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

// 「复位」与「清除故障」是两条不同的 daemon 命令（`reset` 0x14 / `clear_faults` 0x13），
// 而且只有复位会中止在途轨迹、把参考重新锚到当前位姿。两者只要串线，界面上就会出现
// 一个说法与实际动作不符的按钮 —— 这组用例盯的就是这个：各自只发自己那一条。
const mocks = vi.hoisted(() => ({
  // 挂载时的关节限位读取与 TCP 轮询要走通，否则 effect 里会抛 `not a function`。
  getJointParams: vi.fn(),
  getTcpPose: vi.fn(),
  clearFaults: vi.fn(),
  reset: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    error: mocks.toastError,
    success: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/lib/arm', () => ({
  armClient: {
    getJointParams: mocks.getJointParams,
    getTcpPose: mocks.getTcpPose,
    clearFaults: mocks.clearFaults,
    reset: mocks.reset,
  },
  formatArmError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  useArmConnection: () => ({ status: 'connected' }),
  useArmState: () => null,
  useArmMetrics: () => ({}),
}))

const { useSoloState } = await import('./useSoloState')

describe('useSoloState fault recovery', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    mocks.getJointParams.mockReset().mockResolvedValue(null)
    mocks.getTcpPose.mockReset().mockResolvedValue(null)
    mocks.clearFaults.mockReset().mockResolvedValue(null)
    mocks.reset.mockReset().mockResolvedValue(null)
    mocks.toastError.mockReset()
  })

  it('sends clear_faults for 清除故障 and reset for 复位, never the other way round', async () => {
    const { result } = renderHook(() => useSoloState())
    await act(async () => {})

    await act(async () => {
      result.current.clearFault()
    })
    expect(mocks.clearFaults).toHaveBeenCalledTimes(1)
    expect(mocks.reset).not.toHaveBeenCalled()

    await act(async () => {
      result.current.resetArm()
    })
    expect(mocks.reset).toHaveBeenCalledTimes(1)
    // 复位是更重的一档，不是"清除故障 + 复位"两条一起发。
    expect(mocks.clearFaults).toHaveBeenCalledTimes(1)
  })

  it('keeps both commands local in simulation mode', async () => {
    const { result } = renderHook(() => useSoloState())
    await act(async () => {})

    act(() => result.current.viewTabs.find((tab) => tab.key === 'sim')!.onClick())
    await act(async () => {
      result.current.clearFault()
      result.current.resetArm()
    })

    // 仿真模式是纯前端 dry-run：故障按钮可以点亮故障灯复位，但不能真去动机械臂。
    expect(mocks.clearFaults).not.toHaveBeenCalled()
    expect(mocks.reset).not.toHaveBeenCalled()
  })

  it('surfaces a rejected clear_faults instead of failing silently', async () => {
    // `reportError` 自己会往 console 写一条；这里只关心它有没有走到 toast。
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.clearFaults.mockRejectedValueOnce(new Error('boom'))

    const { result } = renderHook(() => useSoloState())
    await act(async () => {})

    await act(async () => {
      result.current.clearFault()
    })

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastError.mock.calls[0][0]).toContain('boom')
    expect(mocks.toastError.mock.calls[0][1]).toMatchObject({ id: 'solo-error-清除故障' })
    consoleError.mockRestore()
  })
})
