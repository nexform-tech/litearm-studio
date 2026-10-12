import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { ErrorBoundary } from './ErrorBoundary'

/** 渲染时必抛的子组件 —— 错误边界存在的理由。 */
function Boom(): never {
  throw new Error('boom')
}

// 崩溃页从前写死中文：整个界面切到英文，它仍然是「页面渲染遇到异常」。
describe('ErrorBoundary crash page', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('shows the crash copy in the interface language', async () => {
    await i18n.changeLanguage('en')
    // React 会把被边界接住的异常再打一遍 console.error，这里静音它，别把用例输出搅浑。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByText(i18n.t('common:render.crashTitle'))).toBeTruthy()
    expect(screen.getByText(i18n.t('common:render.crashBody'))).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('common:render.reloadPage') })).toBeTruthy()
    // 没有一句中文漏出来
    expect(screen.queryByText('页面渲染遇到异常')).toBeNull()

    spy.mockRestore()
  })
})
