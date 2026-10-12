import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { SimModeBanner } from './SoloConsole'

afterEach(cleanup)

// 横幅从前手写了一段中英二选一的三元，英文那句还漏了"切回实机后仿真状态全部丢弃"。
describe('SimModeBanner', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('renders the banner in the interface language', async () => {
    await i18n.changeLanguage('en')

    render(<SimModeBanner />)

    expect(screen.getByText(i18n.t('solo:simBanner'))).toBeTruthy()
    // 英文界面下不该再有一句写死的中文
    expect(screen.queryByText(/仿真模式/)).toBeNull()
  })

  it('keeps the Chinese copy for the Chinese interface', async () => {
    await i18n.changeLanguage('zh')

    render(<SimModeBanner />)

    expect(screen.getByText(i18n.t('solo:simBanner'))).toBeTruthy()
  })
})
