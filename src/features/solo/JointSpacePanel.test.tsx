import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { JointSpacePanel } from './JointSpacePanel'
// 用 i18n 实例取标签，而不是写死中文：jsdom 的 navigator 语言决定了这里的默认语言，
// 写死 '就绪姿态' 的话用例会随着运行环境在中文/英文之间翻车。
import i18n from '@/i18n'

// vitest 未开 globals，RTL 的自动 cleanup 不会注册：不手动挂 afterEach 的话，
// 上一个用例的 DOM 会留在 document 里，slider 数量会叠加。
afterEach(cleanup)

// Radix 的 Slider 会量自己的宽度（`use-size`），jsdom 没有 ResizeObserver。
// 这里只补这一个测试需要的接口，不去改全局的 vitest setup。
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

// 副标题以前是词条里写死的 "J1–J7"，`{1J}` 台架上仍然这么写（issue #37）。
function joints(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    key: i,
    name: `关节 ${i + 1}`,
    val: '0.000',
    pct: 50,
    dot: 'var(--ok)',
    dotRing: 'none',
    dotTitle: `关节 ${i + 1} · 正常`,
  }))
}

function renderPanel(count: number, onHomePose: () => void = vi.fn()) {
  return render(
    <JointSpacePanel
      joints={joints(count)}
      releaseOnly
      toggleReleaseOnly={vi.fn()}
      disabled={false}
      onDispatch={vi.fn()}
      onDispatchAll={vi.fn()}
      radOfPct={() => '0.000'}
      onHomePose={onHomePose}
    />,
  )
}

describe('JointSpacePanel axis range', () => {
  it('shows one slider and a single-axis label on a one-axis arm', () => {
    renderPanel(1)

    expect(screen.getAllByRole('slider')).toHaveLength(1)
    expect(screen.getByText('J1')).toBeDefined()
    expect(screen.queryByText('J1–J1')).toBeNull()
  })

  it('shows the full range and every slider on a seven-axis arm', () => {
    renderPanel(7)

    expect(screen.getAllByRole('slider')).toHaveLength(7)
    expect(screen.getByText('J1–J7')).toBeDefined()
  })
})

describe('JointSpacePanel ready pose', () => {
  // 就绪姿态从控制栏搬进这张卡的标题栏（速度滑条上方那一行改成三个大按钮）。
  // 搬完必须还点得到，否则"使能后回就绪位"这条常用路径就断了。
  it('offers the ready pose action from the card header', () => {
    const onHomePose = vi.fn()
    renderPanel(7, onHomePose)

    fireEvent.click(screen.getByRole('button', { name: i18n.t('solo:controlBar.readyPose') }))

    expect(onHomePose).toHaveBeenCalledTimes(1)
  })
})
