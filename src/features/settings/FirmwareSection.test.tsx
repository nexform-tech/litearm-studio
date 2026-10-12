import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'

afterEach(cleanup)

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  rePick: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
  vm: {} as Record<string, unknown>,
}))

vi.mock('./useFirmwareUpgrade', () => ({
  useFirmwareUpgrade: () => mocks.vm,
}))

const { FirmwareSection } = await import('./FirmwareSection')

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

function baseVm(over: Record<string, unknown> = {}) {
  return {
    connected: true,
    firmware: 'Litearm1.8.0-7J',
    port: '/dev/ttyACM0',
    armEnabled: false,
    engine: { ready: true, label: 'libusb-package: /x/libusb-1.0.so' },
    engineReady: true,
    summary: null,
    error: null,
    inspecting: false,
    starting: false,
    progress: null,
    result: null,
    job: null,
    running: false,
    pick: mocks.pick,
    rePick: mocks.rePick,
    start: mocks.start,
    cancel: mocks.cancel,
    reset: mocks.reset,
    refreshEngine: vi.fn(),
    ...over,
  }
}

describe('FirmwareSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.start.mockResolvedValue(true)
    mocks.vm = baseVm()
  })

  it('keeps Start disabled until the operator confirms the arm is supported', () => {
    // ⚠ 这是本页唯一一道"界面无法验证"的门禁：升级会先失能，有重力负载的臂会下垂，
    //   而界面证明不了手臂有没有支撑 —— 只能要求操作员明确确认。
    mocks.vm = baseVm({ summary: SUMMARY })
    render(<FirmwareSection />)

    const start = screen.getByTestId('firmware-start') as HTMLButtonElement
    expect(start.disabled).toBe(true)

    // 它是一句"我确认……"的声明，所以形状必须是**复选框**（与激活页的同意书同性质），
    // 不是看起来像"切换某个开关"的 Toggle。
    const box = screen.getByTestId('firmware-safety-arm') as HTMLInputElement
    expect(box.type).toBe('checkbox')
    expect(box.checked).toBe(false)

    fireEvent.click(box)
    expect(box.checked).toBe(true)
    expect((screen.getByTestId('firmware-start') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps Start disabled when the flashing engine is unavailable', () => {
    mocks.vm = baseVm({
      summary: SUMMARY,
      engineReady: false,
      engine: { ready: false, label: '未安装 pyusb (pip install pyusb)' },
    })
    render(<FirmwareSection />)
    fireEvent.click(screen.getByTestId('firmware-safety-arm'))
    expect((screen.getByTestId('firmware-start') as HTMLButtonElement).disabled).toBe(true)
    // 缺什么要说出来，否则操作员只会看到一个点不动的按钮。
    expect(screen.getByText(/pyusb/)).toBeTruthy()
  })

  it('shows the version read out of the image before anything is flashed', () => {
    mocks.vm = baseVm({ summary: SUMMARY })
    render(<FirmwareSection />)
    expect(screen.getByTestId('firmware-version').textContent).toBe('Litearm1.9.0-7J')
    // 地址范围与大小也要在动手之前可见。
    expect(screen.getByText(/0x08000000/)).toBeTruthy()
    expect(screen.getByText(/103840 B/)).toBeTruthy()
  })

  it('shows a rejected image as an error and offers no summary', () => {
    mocks.vm = baseVm({ error: '镜像覆盖受保护扇区', summary: null })
    render(<FirmwareSection />)
    expect(screen.getByTestId('firmware-error').textContent).toContain('受保护扇区')
    expect(screen.queryByTestId('firmware-summary')).toBeNull()
  })

  it('renders the failure result through the reason, not the daemon message', () => {
    mocks.vm = baseVm({
      summary: SUMMARY,
      result: {
        job: 'fw-1', ok: false, reason: 'flash_failed',
        msg: 'MSG-FROM-DAEMON', version: null, port: null, warning: null,
      },
    })
    render(<FirmwareSection />)
    const box = screen.getByTestId('firmware-result')
    expect(box.textContent).toBeTruthy()
    // ⚠ 短码优先：`msg` 是守护进程写的中文，英文界面上必须换一句话 —— 所以它
    //   **不该**原样出现在这里。
    expect(box.textContent).not.toContain('MSG-FROM-DAEMON')
  })

  it('offers Cancel while the update is running', () => {
    mocks.vm = baseVm({
      summary: SUMMARY,
      running: true,
      progress: { job: 'fw-1', phase: 'flash', done: 5, total: 10, detail: '写入 5 B' },
    })
    render(<FirmwareSection />)
    expect(screen.getByTestId('firmware-progress')).toBeTruthy()
    fireEvent.click(screen.getByTestId('firmware-cancel'))
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
  })

  it('shows the safety confirmation even before an image is picked', () => {
    // 三条事实对任何一份镜像都成立，操作员可以先读完再决定选哪份；等选完才冒出来，
    // 反而像"选完就必须点下去"。
    mocks.vm = baseVm({ summary: null })
    const { unmount } = render(<FirmwareSection />)
    expect(screen.getByTestId('firmware-safety')).toBeTruthy()
    // 但"开始升级"仍然不可用 —— 没有镜像可烧。
    expect((screen.getByTestId('firmware-start') as HTMLButtonElement).disabled).toBe(true)
    unmount()

    mocks.vm = baseVm({ summary: SUMMARY })
    render(<FirmwareSection />)
    expect(screen.getByTestId('firmware-safety')).toBeTruthy()
  })

  it('warns that the update itself disarms the arm', () => {
    mocks.vm = baseVm({ summary: SUMMARY })
    render(<FirmwareSection />)
    // 这是这一块里最要紧的一条物理后果：确认框不能只让人确认"手臂放好了"，
    // 还得说清"失能是我们做的"。
    expect(screen.getByTestId('firmware-safety').textContent).toMatch(/失能|disarms/)
  })

  it('says so — and refuses to start — when no controller is connected', () => {
    mocks.vm = baseVm({ connected: false, summary: SUMMARY })
    render(<FirmwareSection />)
    expect(screen.getByTestId('firmware-offline')).toBeTruthy()
    // 离线仍可**校验**镜像（那一步不碰设备），但不许开始。
    fireEvent.click(screen.getByTestId('firmware-safety-arm'))
    expect((screen.getByTestId('firmware-start') as HTMLButtonElement).disabled).toBe(true)
  })

  it('calls out a board sitting in the bootloader instead of "not connected"', () => {
    // ⚠ issue #152：板子停在 ROM bootloader 里时没有串口，以前这里与"没插线"长得
    //   一模一样 —— 而两者该做的事相反。它要能被认出来，并且**要有入口救它**。
    mocks.vm = baseVm({ connected: false, dfuPresent: true, summary: SUMMARY })
    render(<FirmwareSection />)

    expect(screen.queryByTestId('firmware-offline')).toBeNull()
    const notice = screen.getByTestId('firmware-dfu')
    expect(notice.textContent).toMatch(/bootloader/i)
    // 这里说的必须是"它不是没插线"，而不是"去连上再说"。
    expect(notice.textContent).not.toMatch(/连上之后才能升级|connect before updating/i)
  })

  it('says where the board it found is plugged in, so the operator can check it', () => {
    // ⚠ `0483:DF11` 是整个 STM32 系列共用的编号: 这台机器上若有第二块 STM32 也在 DFU 里,
    //   我们可能找到的是它。位置是唯一能让操作员核对"是不是我插的那块"的东西。
    mocks.vm = baseVm({ connected: false, dfuPresent: true, dfuLocation: '1-3.2',
                        summary: SUMMARY })
    render(<FirmwareSection />)
    const line = screen.getByTestId('firmware-dfu-location')
    expect(line.textContent).toContain('1-3.2')
  })

  it('says nothing about a location the daemon could not determine', () => {
    // 编一个位置比不说更糟：操作员会拿着一个假的插口名去核对，然后以为对上了。
    mocks.vm = baseVm({ connected: false, dfuPresent: true, dfuLocation: '',
                        summary: SUMMARY })
    render(<FirmwareSection />)
    expect(screen.getByTestId('firmware-dfu')).toBeTruthy()
    expect(screen.queryByTestId('firmware-dfu-location')).toBeNull()
  })

  it('lets the update start with no session when the board is in the bootloader', () => {
    // ⚠ 这一条就是"死循环"的破法：没有会话（板子没有应用态可连），但烧录仍然可开 ——
    //   因为从 DFU 起跑正是唯一能把板子弄回应用态的事。
    mocks.vm = baseVm({ connected: false, dfuPresent: true, summary: SUMMARY })
    render(<FirmwareSection />)

    const start = screen.getByTestId('firmware-start') as HTMLButtonElement
    expect(start.disabled).toBe(true)          // 安全确认还没勾
    fireEvent.click(screen.getByTestId('firmware-safety-arm'))
    expect(start.disabled).toBe(false)

    // 安全条款也要跟着路径变：这条路不会再去失能一次（应用早就停了）。
    expect(screen.getByTestId('firmware-safety').textContent)
      .toMatch(/早已停下|already stopped/)

    fireEvent.click(start)
    expect(mocks.start).toHaveBeenCalledTimes(1)
  })

  it('still refuses to start when nothing is connected and no board is in DFU', () => {
    mocks.vm = baseVm({ connected: false, dfuPresent: false, summary: SUMMARY })
    render(<FirmwareSection />)
    fireEvent.click(screen.getByTestId('firmware-safety-arm'))
    expect((screen.getByTestId('firmware-start') as HTMLButtonElement).disabled).toBe(true)
  })
})
