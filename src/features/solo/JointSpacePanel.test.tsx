import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { JointSpacePanel } from './JointSpacePanel'
// 取 i18n 实例而不是写死标题：jsdom 的 navigator 语言决定了这里的默认语言，
// 写死中文会在英文环境下翻车。这个 import 同时把实例注册给 react-i18next。
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

function renderPanel(count: number, releaseOnly = true) {
  return render(
    <JointSpacePanel
      joints={joints(count)}
      releaseOnly={releaseOnly}
      toggleReleaseOnly={vi.fn()}
      disabled={false}
      onDispatch={vi.fn()}
      onDispatchAll={vi.fn()}
      radOfPct={() => '0.000'}
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

    expect(screen.getByText(i18n.t('solo:jointSpace.title'))).toBeDefined()
    expect(screen.getAllByRole('slider')).toHaveLength(7)
    expect(screen.getByText('J1–J7')).toBeDefined()
  })
})

describe('JointSpacePanel send button', () => {
  // 勾选“松手即下发”时按钮只是置灰，不能消失：隐藏会让标题行抖动，
  // 操作员也会以为功能被移走了。
  it('keeps the send button in the DOM but disabled while send-on-release is on', () => {
    renderPanel(7, true)

    const send = screen.getByRole<HTMLButtonElement>('button', { name: i18n.t('solo:jointSpace.send') })
    expect(send.disabled).toBe(true)
  })

  it('enables the send button once send-on-release is off', () => {
    renderPanel(7, false)

    const send = screen.getByRole<HTMLButtonElement>('button', { name: i18n.t('solo:jointSpace.send') })
    expect(send.disabled).toBe(false)
  })
})
