import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { PadCell } from '@/components/DirectionPad'
import type { SegItem } from '@/components/SegmentedControl'
import { CartesianPanel } from './CartesianPanel'

// vitest 未开 globals，RTL 的自动 cleanup 不会注册：不手动挂 afterEach 的话，
// 上一个用例的 DOM 会留在 document 里，queryByText 会命中别人的节点。
afterEach(cleanup)

// 面板本身没有 i18n 之外的依赖；sonner 只是被 transitively 引到，替掉免得真弹窗。
vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const frames: SegItem[] = [
  { key: 'base', label: '基坐标系', active: true, onClick: vi.fn() },
  { key: 'tool', label: '工具坐标系', active: false, onClick: vi.fn() },
]
// 盘面顺序即位置（十字形）：顶部一对 → 上 → 左/标签/右 → 下。
const transCells: PadCell[] = [
  ['Z+', '上'],
  ['Z−', '下'],
  ['X+', '前'],
  ['Y+', '左'],
  ['平移', '(mm)', true],
  ['Y−', '右'],
  ['X−', '后'],
]
const rotCells: PadCell[] = [
  ['RZ+', '绕基Z'],
  ['RZ−', '绕基Z'],
  ['RY−', '绕基Y'],
  ['RX+', '绕基X'],
  ['旋转', '(deg)', true],
  ['RX−', '绕基X'],
  ['RY+', '绕基Y'],
]

function renderPanel(overrides: Partial<Parameters<typeof CartesianPanel>[0]> = {}) {
  return render(
    <CartesianPanel
      frames={frames}
      transCells={transCells}
      rotCells={rotCells}
      onJogPress={vi.fn()}
      transSteps={['10 mm']}
      rotSteps={['5 °']}
      transStep="10 mm"
      rotStep="5 °"
      setTransStep={vi.fn()}
      setRotStep={vi.fn()}
      {...overrides}
    />,
  )
}

describe('CartesianPanel capability notice', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('explains the missing planner and disables movel when cartUnsupported', () => {
    renderPanel({ cartUnsupported: true })

    expect(screen.getByText(/未编译笛卡尔规划/)).toBeTruthy()

    // 盘面与 movel 表单同屏并存，不需要先切子模式。
    const movel = screen.getByRole('button', { name: /运动到目标位姿/ }) as HTMLButtonElement
    expect(movel.disabled).toBe(true)
    const sync = screen.getByRole('button', { name: /同步当前位姿/ }) as HTMLButtonElement
    expect(sync.disabled).toBe(true)
  })

  it('leaves the panel fully usable when the firmware supports cartesian planning', () => {
    renderPanel()

    expect(screen.queryByText(/未编译笛卡尔规划/)).toBeNull()

    const movel = screen.getByRole('button', { name: /运动到目标位姿/ }) as HTMLButtonElement
    expect(movel.disabled).toBe(false)
    expect(screen.getByRole('button', { name: /同步当前位姿/ })).toBeTruthy()
  })

  it('keeps showing the simulation hint in sim mode', () => {
    renderPanel({ simMode: true })

    expect(screen.getByText('仿真模式仅支持关节空间操作')).toBeTruthy()
    expect(screen.queryByText(/未编译笛卡尔规划/)).toBeNull()
  })
})
