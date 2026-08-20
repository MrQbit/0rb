// One-off: verify a runtime PLUGIN widget renders inside the sandboxed iframe.
import { chromium } from 'playwright';
const BASE = process.env.ORB_BASE || 'http://localhost:9080';
const b = await chromium.launch();
const page = await (await b.newContext({ ignoreHTTPSErrors: true })).newPage();
await page.context().addCookies([{ name: 'orb2_session', value: process.env.ORB_SESSION, domain: 'localhost', path: '/' }]);
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  window.__orbSpawnWidget({ id: 'fx-plg', type: 'countdown', title: 'Plugin sandbox', target: Date.now() + 3600000, label: 'Sandbox test' });
});
await page.waitForTimeout(2500);
const iframes = await page.locator('.wg iframe[sandbox]').count();
const inner = iframes ? (await page.frameLocator('.wg iframe[sandbox]').last().locator('body').textContent().catch(() => '')) : '';
// prove the CSP: try a network fetch from inside the frame — must throw/block
const blocked = iframes ? await page.frameLocator('.wg iframe[sandbox]').last().locator('body').evaluate(async () => {
  try { await fetch('https://example.com', { mode: 'no-cors' }); return 'NOT-BLOCKED'; } catch { return 'blocked'; }
}) : 'n/a';
await page.screenshot({ path: (process.env.SHOTS_DIR || '.') + '/plugin-sandbox.png' });
console.log(`iframes=${iframes} inner="${(inner || '').trim().slice(0, 60)}" net=${blocked}`);
await b.close();
process.exit(iframes > 0 && (inner || '').trim() && blocked === 'blocked' ? 0 : 1);
