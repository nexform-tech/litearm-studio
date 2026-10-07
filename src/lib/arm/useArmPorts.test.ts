import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

const mocks = vi.hoisted(() => ({ listPorts: vi.fn() }))

vi.mock('./client', () => ({ armClient: { listPorts: mocks.listPorts } }))

const { useArmPorts } = await import('./useArmPorts')

describe('useArmPorts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exposes the ports the daemon enumerated', async () => {
    mocks.listPorts.mockResolvedValue(['/dev/ttyACM0', '/dev/ttyUSB0'])
    const { result } = renderHook(() => useArmPorts())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.ports).toEqual(['/dev/ttyACM0', '/dev/ttyUSB0'])
    expect(result.current.error).toBeNull()
  })

  it('retries a first failure instead of calling it "no ports on this machine"', async () => {
    // ⚠ 启动这一拍 WebSocket 还在开, `sendCmd` 会当场拒绝。把那次拒绝显示成"列不出串口"
    //   会让操作员以为机器上没有设备 —— 而那个结论是错的。
    mocks.listPorts.mockRejectedValueOnce(new Error('本地程序未连接'))
    mocks.listPorts.mockResolvedValue(['/dev/ttyACM0'])

    const { result } = renderHook(() => useArmPorts())
    await waitFor(() => expect(result.current.ports).toEqual(['/dev/ttyACM0']), { timeout: 4000 })
    expect(result.current.error).toBeNull()
  })

  it('surfaces the reason once retrying stops helping', async () => {
    mocks.listPorts.mockRejectedValue(new Error('未知命令 list_ports'))

    const { result } = renderHook(() => useArmPorts())
    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 5000 })
    expect(result.current.ports).toEqual([])
    expect(result.current.error).toBeTruthy()
  })

  it('re-enumerates when the picker is opened', async () => {
    mocks.listPorts.mockResolvedValueOnce(['/dev/ttyACM0'])
    const { result } = renderHook(() => useArmPorts())
    await waitFor(() => expect(result.current.ports).toEqual(['/dev/ttyACM0']))

    // 插上一台新设备再打开下拉: 列表跟着更新, 不必刷新整页。
    mocks.listPorts.mockResolvedValueOnce(['/dev/ttyACM0', '/dev/ttyUSB1'])
    act(() => result.current.reload())

    await waitFor(() => expect(result.current.ports).toHaveLength(2))
  })
})
