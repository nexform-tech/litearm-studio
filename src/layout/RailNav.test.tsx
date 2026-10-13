/**
 * 侧栏（RailNav）的可访问名 —— 只管"读屏会念出什么"。
 *
 * 单独一条用例而不是并进 TopBar 的：那里 mock 掉了路由，而侧栏的导航项正是靠
 * `NavLink` 渲染的，覆盖不到。
 */
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { RailNav } from './RailNav'

function renderRail() {
  return render(
    <MemoryRouter>
      <RailNav />
    </MemoryRouter>,
  )
}

describe('RailNav', () => {
  it('keeps the logo out of the accessible name', () => {
    const { container } = renderRail()
    const logo = container.querySelector('img')
    expect(logo).not.toBeNull()
    // 装饰性图标：alt 为空且不进可访问树，读屏不会在中文界面里念出一句英文。
    expect(logo!.getAttribute('alt')).toBe('')
    expect(logo!.getAttribute('aria-hidden')).toBe('true')
  })

  it('still announces the navigation items', () => {
    const { getByRole } = renderRail()
    expect(getByRole('link', { name: 'Control' })).toBeTruthy()
    expect(getByRole('link', { name: 'Logs' })).toBeTruthy()
    expect(getByRole('link', { name: 'Settings' })).toBeTruthy()
  })
})
