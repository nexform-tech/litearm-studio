import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

async function captureLocale(locale = 'zh') {
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

  console.log(`[${locale.toUpperCase()}] 1. Capturing Solo Console...`);
  await page.goto('http://localhost:5173/control', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // 01: Full Solo Overview
  await page.screenshot({ path: path.join(outDir, '01_solo_overview.png') });

  // 02: Endpoint Modal
  const editBtn = page.locator('#topbar-edit-endpoint-btn').first();
  if (await editBtn.count() > 0) {
    await editBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, '02_header_endpoint_modal.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  const soloContainer = page.locator('#root > div > div.flex.min-w-0 > div.flex.min-h-0 > div');
  const col0 = soloContainer.locator('> div').nth(0);
  const col1 = soloContainer.locator('> div').nth(1);
  const col2 = soloContainer.locator('> div').nth(2);

  // 03: 3D Preview Panel
  const previewPanel = col0.locator('> div').nth(0);
  await previewPanel.screenshot({ path: path.join(outDir, '03_solo_3d_preview.png') });

  // 04: Pose Card - Joint
  const poseCard = col0.locator('> div').nth(1);
  await poseCard.screenshot({ path: path.join(outDir, '04_solo_pose_joint.png') });

  // 05: Pose Card - Cartesian
  const cartToggleBtn = poseCard.locator('button[value="cart"], button:has-text("笛卡尔"), button:has-text("Cartesian")').first();
  if (await cartToggleBtn.count() > 0) {
    await cartToggleBtn.click();
    await page.waitForTimeout(500);
    await poseCard.screenshot({ path: path.join(outDir, '05_solo_pose_cartesian.png') });
    const jointToggleBtn = poseCard.locator('button[value="joint"], button:has-text("关节"), button:has-text("Joint")').first();
    if (await jointToggleBtn.count() > 0) await jointToggleBtn.click();
  }

  // 06: Telemetry Panel
  const metricsPanel = col0.locator('> div').nth(2);
  await metricsPanel.screenshot({ path: path.join(outDir, '06_solo_telemetry.png') });

  // 07: Control Bar + Joint Space Panel
  await col1.screenshot({ path: path.join(outDir, '07_solo_control_and_joints.png') });

  // 08: Cartesian Jog Panel
  const cartesianPanel = col1.locator('> div:nth-child(2) > div').nth(1);
  await cartesianPanel.screenshot({ path: path.join(outDir, '08_solo_cartesian_jog.png') });

  // 09: Cartesian Movel Panel
  const movelSubModeBtn = cartesianPanel.locator('button:has-text("movel"), button:has-text("Target Pose"), button:has-text("目标位姿")').first();
  if (await movelSubModeBtn.count() > 0) {
    await movelSubModeBtn.click();
    await page.waitForTimeout(500);
    await cartesianPanel.screenshot({ path: path.join(outDir, '09_solo_cartesian_movel.png') });
    const jogSubModeBtn = cartesianPanel.locator('button:has-text("方向点动"), button:has-text("Jog")').first();
    if (await jogSubModeBtn.count() > 0) await jogSubModeBtn.click();
  }

  // 10: Trajectory Panel
  const trajPanel = col2.locator('> div').nth(0);
  await trajPanel.screenshot({ path: path.join(outDir, '10_solo_trajectory.png') });

  // 11: Gripper Panel
  const gripperPanel = col2.locator('> div').nth(1);
  await gripperPanel.screenshot({ path: path.join(outDir, '11_solo_gripper.png') });

  console.log(`[${locale.toUpperCase()}] 3. Capturing Telemetry & Logs...`);
  await page.goto('http://localhost:5173/log', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  // 13: Telemetry Samples Tab
  await page.screenshot({ path: path.join(outDir, '13_telemetry_samples.png') });

  // 14: Telemetry Retention Modal
  const editRetentionBtn = page.locator('button:has(svg.lucide-pencil)').first();
  if (await editRetentionBtn.count() > 0) {
    await editRetentionBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, '14_telemetry_retention_modal.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // 15: Controller Logs Tab
  const logsTabTrigger = page.locator('[role="tab"][value="logs"], button[value="logs"], button:has-text("控制器日志"), button:has-text("Controller Logs")').first();
  if (await logsTabTrigger.count() > 0) {
    await logsTabTrigger.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(outDir, '15_controller_logs.png') });
  }

  console.log(`[${locale.toUpperCase()}] 4. Capturing Settings Pages...`);
  const settingsTabs = [
    { tab: 'payload', file: '16_settings_payload.png' },
    { tab: 'safety', file: '17_settings_safety.png' },
    { tab: 'gains', file: '18_settings_gains.png' },
    { tab: 'endEffector', file: '20_settings_end_effector.png' },
    { tab: 'system', file: '19_settings_system.png' },
  ];
  for (const { tab, file } of settingsTabs) {
    await page.goto(`http://localhost:5173/settings?tab=${tab}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(outDir, file) });
  }

  console.log(`[${locale.toUpperCase()}] All screenshots captured successfully!`);
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
