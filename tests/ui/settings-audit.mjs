// Full settings sweep — one screenshot per section for review.
import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1100, height: 850 } })).newPage();
await page.context().addCookies([{ name: 'orb2_session', value: process.env.ORB_SESSION, domain: 'localhost', path: '/' }]);
await page.goto('http://localhost:9080/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
await page.locator('#gearBtn').click();
await page.locator('.tm-item[data-act="settings"]').click();
await page.waitForTimeout(600);
const S = process.env.SHOTS_DIR || '.';
for (const sec of ['users', 'channels', 'voice', 'smarthome', 'apps', 'system']) {
  await page.locator(`.set-navi[data-sec="${sec}"]`).click();
  await page.waitForTimeout(1800);
  await page.locator('#settingsPanel').screenshot({ path: `${S}/audit-${sec}.png` });
  // bottom half too for long sections
  await page.locator('#settingsPanel .set-content').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(500);
  await page.locator('#settingsPanel').screenshot({ path: `${S}/audit-${sec}-2.png` });
  await page.locator('#settingsPanel .set-content').evaluate(el => { el.scrollTop = 0; });
}
console.log('sections captured');
await b.close();
