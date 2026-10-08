import { chromium } from 'playwright'
const browser = await chromium.launch({ timeout: 30000 })
for (const [w, h, name] of [[1600, 900, 'horizontal-1600'], [1440, 900, 'horizontal-1440']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'zh-CN' })
  await ctx.addInitScript(() => localStorage.setItem('i18nextLng', 'zh'))
  const page = await ctx.newPage()
  try {
    await page.goto('http://127.0.0.1:5173/control', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.getByTestId('control-bar-actions').waitFor({ timeout: 30000 })
    await page.waitForTimeout(2500)
    const info = await page.getByTestId('control-bar-actions').evaluate((el) => ({
      cols: getComputedStyle(el).gridTemplateColumns.split(' ').length,
      w: Math.round(el.getBoundingClientRect().width),
    }))
    console.log(name, 'cols =', info.cols, 'row =', info.w, 'px')
    await page.screenshot({ path: `.preview/${name}.png`, timeout: 60000, animations: 'disabled' })
    console.log(name, 'ok')
  } catch (e) {
    console.log(name, 'FAILED', e.message.split('\n')[0])
  }
  await ctx.close()
}
await browser.close()
