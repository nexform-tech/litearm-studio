import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { ControlBar } from './ControlBar'

// vitest 未开 globals，RTL 的自动 cleanup 不会注册：不手动挂 afterEach 的话，
// 上一个用例的 DOM 会留在 document 里，按钮计数会叠加。
afterEach(cleanup)

// Radix 的 Slider（速度行）会量自己的宽度（`use-size`），jsdom 没有 ResizeObserver。
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

beforeEach(async () => {
  // 断言里的按钮名一律从 i18n 实例取，不写死中文：默认语言跟运行环境走，
  // 写死会在英文环境（或 CI 的 navigator 语言）下翻车。
  await i18n.changeLanguage('zh')
})

function renderBar(overrides: Partial<Parameters<typeof ControlBar>[0]> = {}) {
  const props: Parameters<typeof ControlBar>[0] = {
    enabled: false,
    enableDot: '#f5a524',
    toggleEnable: vi.fn(),
    speed: 50,
    setSpeed: vi.fn(),
    faultReason: null,
    clearFault: vi.fn(),
    zeroJoints: vi.fn(),
    zeroGravity: false,
    toggleZeroGravity: vi.fn(),
    readyPose: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<ControlBar {...props} />) }
}

describe('ControlBar action row', () => {
  it('carries the five actions in operator order: switches first, then commands', () => {
    renderBar()

    const row = screen.getByTestId('control-bar-actions')

    // 分组只靠顺序：前两颗是改状态的开关（使能 / 零重力），后三颗是一次性动作
    // （复位 / 回零点 / 就绪姿态）。这一行必须是平铺的五颗，中间不夹分隔线之类的元素 ——
    // 分隔线会把每颗按钮挤窄，而「就绪姿态」在中间列最窄时本来就已经贴着边。
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual([
      i18n.t('solo:controlBar.enable'),
      i18n.t('solo:modes.drag'),
      i18n.t('solo:controlBar.reset'),
      i18n.t('solo:controlBar.home'),
      i18n.t('solo:controlBar.readyPose'),
    ])
    expect(row.children).toHaveLength(5)
  })

  it('turns zero gravity on with the first press and off with the second', () => {
    const { props, rerender } = renderBar()
    const button = screen.getByRole('button', { name: i18n.t('solo:modes.drag') })

    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('title')).toBe(i18n.t('solo:controlBar.zeroGravityOffTitle'))

    fireEvent.click(button)
    expect(props.toggleZeroGravity).toHaveBeenCalledTimes(1)

    // 受控开关：按下态由 `zeroGravity` 决定，不由 Toggle 自己记 —— 状态只从 useSoloState
    // 来（实机是广播的真实模式），否则界面会显示成操作员并未真正进入的模式。
    rerender(<ControlBar {...props} zeroGravity />)
    const pressed = screen.getByRole('button', { name: i18n.t('solo:modes.drag') })
    expect(pressed.getAttribute('aria-pressed')).toBe('true')
    expect(pressed.getAttribute('title')).toBe(i18n.t('solo:controlBar.zeroGravityOnTitle'))

    // 第二下就是关闭：同一个回调，目标模式由 hook 按当前模式取反。
    fireEvent.click(pressed)
    expect(props.toggleZeroGravity).toHaveBeenCalledTimes(2)
  })

  it('runs the ready-pose move from the same row', () => {
    const { props } = renderBar()

    fireEvent.click(screen.getByRole('button', { name: i18n.t('solo:controlBar.readyPose') }))

    expect(props.readyPose).toHaveBeenCalledTimes(1)
  })

  it('keeps every one-shot action wired to its own handler', () => {
    const { props } = renderBar()

    fireEvent.click(screen.getByRole('button', { name: i18n.t('solo:controlBar.reset') }))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('solo:controlBar.home') }))

    expect(props.clearFault).toHaveBeenCalledTimes(1)
    expect(props.zeroJoints).toHaveBeenCalledTimes(1)
  })
})
