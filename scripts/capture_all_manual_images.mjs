import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// Panel headings each locale renders. These are the identifiers the script
// matches on, so keep them in sync with src/i18n/locales/<locale>/solo.json
// (solo:preview.title, solo:cartesian.*) and common.json (common:metrics.title).
const LABELS = {
  en: {
    preview: '3D Live Preview',
    metrics: 'Live Curves',
    cartesian: 'Cartesian Space',
    jogSubMode: 'Directional Jog',
    targetSubMode: 'Target Pose movel',
  },
  zh: {
    preview: '3D 实时预览',
    metrics: '实时曲线',
    cartesian: '笛卡尔空间',
    jogSubMode: '方向点动',
    targetSubMode: '目标位姿 movel',
  },
};

async function captureLocale(locale = 'zh') {
  const labels = LABELS[locale] ?? LABELS.en;
  const outDir = path.resolve(process.cwd(), `docs/images/${locale}`);
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: locale === 'zh' ? 'zh-CN' : 'en-US',
  });

  const page = await context.newPage();

  await page.addInitScript((lang) => {
    window.localStorage.setItem('litearm_language', lang);
  }, locale);

  console.log(`[${locale.toUpperCase()}] Capturing the control page...`);
  await page.goto('http://localhost:5173/control', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // Every panel is a shadcn Card carrying data-slot="card", so match on the
  // heading text instead of the column index — the columns get reshuffled and
  // the old positional selectors silently captured the wrong panel.
  const card = (text) => page.locator('[data-slot="card"]', { hasText: text }).first();

  // 03: 3D preview panel
  await card(labels.preview).screenshot({ path: path.join(outDir, '03_solo_3d_preview.png') });

  // 06: live telemetry curves panel
  await card(labels.metrics).screenshot({ path: path.join(outDir, '06_solo_telemetry.png') });

  const cartesianPanel = card(labels.cartesian);

  // 08: cartesian directional jog pad (the default sub-mode)
  await cartesianPanel.getByRole('button', { name: labels.jogSubMode, exact: true }).click();
  await page.waitForTimeout(500);
  await cartesianPanel.screenshot({ path: path.join(outDir, '08_solo_cartesian_jog.png') });

  // 09: cartesian target-pose movel form
  await cartesianPanel.getByRole('button', { name: labels.targetSubMode, exact: true }).click();
  await page.waitForTimeout(500);
  await cartesianPanel.screenshot({ path: path.join(outDir, '09_solo_cartesian_movel.png') });

  console.log(`[${locale.toUpperCase()}] Screenshots captured.`);
  await browser.close();
}

async function main() {
  await captureLocale('zh');
  await captureLocale('en');
  console.log('Dual-language screenshot capture completed!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
