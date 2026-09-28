// Rasterises assets/icon-source.svg into the PNG sizes the .ico is built from.
//
// Run this only when the brand mark changes; the rendered PNGs and the resulting
// assets/litearm.ico are committed, so ordinary builds (and the release
// workflow) never need a browser.
//
//   mkdir -p /tmp/icon && node scripts/render-icon-png.mjs
//   node scripts/make-icon.mjs
//
// Needs a Chromium from Playwright: npx playwright install chromium
import pw from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SVG = resolve(ROOT, 'assets', 'icon-source.svg')
const OUT = process.env.ICON_PNG_DIR || resolve(ROOT, 'assets', 'icon-png')

/** Must match `SIZES` in make-icon.mjs. */
const SIZES = [16, 24, 32, 48, 64, 128, 256]

mkdirSync(OUT, { recursive: true })
const svg = readFileSync(SVG, 'utf8')
if (!/width="512"\s+height="512"/.test(svg)) {
  throw new Error('icon-source.svg is no longer 512x512; update this script to match')
}

const { chromium } = pw
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 300, height: 300 }, deviceScaleFactor: 1 })

for (const size of SIZES) {
  // Keep `omitBackground` on: the icon's rounded corners must stay transparent,
  // otherwise Windows draws a dark square behind the round mark.
  const html = `<!doctype html><html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px">${svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`)}</div>
  </body></html>`
  await page.setContent(html)
  const el = await page.$('div')
  const buf = await el.screenshot({ omitBackground: true })
  writeFileSync(resolve(OUT, `icon-${size}.png`), buf)
  console.log(`rendered ${size}px -> ${OUT}/icon-${size}.png`)
}

await browser.close()
