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
    enableColor: '#f5a524',
    toggleEnable: vi.fn(),
    speed: 50,
    setSpeed: vi.fn(),
    faultReason: null,
    showDisableHint: false,
    reset: vi.fn(),
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
  it('carries the six actions in operator order: switches, then fault recovery, then commands', () => {
    renderBar()

    const row = screen.getByTestId('control-bar-actions')

    // 分组只靠顺序：前两颗是改状态的开关（使能 / 零重力），中间两颗是故障恢复
    // （复位 / 清除故障），后两颗是运动指令（回零点 / 就绪姿态）。这一行必须是平铺的
    // 六颗，中间不夹分隔线之类的元素 —— 分隔线会把每颗按钮挤得更窄，而这一行在窄窗里
    // 已经要折成两行才盛得下（见 ControlBar 里 BIG_BUTTON 的宽度账）。
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual([
      i18n.t('solo:controlBar.enable'),
      i18n.t('solo:modes.drag'),
      i18n.t('solo:controlBar.reset'),
      i18n.t('solo:controlBar.clearFault'),
      i18n.t('solo:controlBar.home'),
      i18n.t('solo:controlBar.readyPose'),
    ])
    expect(row.children).toHaveLength(6)
  })

  it('keeps the disable-drop warning visible while the arm is energised', () => {
    const { rerender, props } = renderBar()
    // 未使能时不该出现：那时下一按是"锁住姿态"，这句话只会占地方。
    expect(screen.queryByText(i18n.t('solo:controlBar.disableWarning'))).toBeNull()

    rerender(<ControlBar {...props} showDisableHint />)
    expect(screen.getByText(i18n.t('solo:controlBar.disableWarning'))).toBeTruthy()
  })

  it('gives every button exactly one icon', () => {
    const { props, rerender } = renderBar()
    const row = screen.getByTestId('control-bar-actions')

    for (const button of within(row).getAllByRole('button')) {
      expect(button.querySelectorAll('svg')).toHaveLength(1)
    }

    // 使能那颗的图标颜色就是「现在带电」这个状态（圆点换成电源图标后，颜色仍是状态灯）：
    // 两态必须给出不同的颜色，否则这颗一点就失力下坠的按钮又只剩文字可看了。
    const iconColor = (name: string) =>
      (screen.getByRole('button', { name }).querySelector('svg') as SVGElement).style.color
    const off = iconColor(i18n.t('solo:controlBar.enable'))
    rerender(<ControlBar {...props} enabled enableColor="#4ade80" />)
    const on = iconColor(i18n.t('solo:controlBar.disable'))
    expect(off).toBeTruthy()
    expect(on).toBeTruthy()
    expect(on).not.toBe(off)
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
    fireEvent.click(screen.getByRole('button', { name: i18n.t('solo:controlBar.clearFault') }))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('solo:controlBar.home') }))

    // 复位与清除故障是两条不同的命令，各自那颗按钮必须打到各自的回调上。
    expect(props.reset).toHaveBeenCalledTimes(1)
    expect(props.clearFault).toHaveBeenCalledTimes(1)
    expect(props.zeroJoints).toHaveBeenCalledTimes(1)
  })
})
