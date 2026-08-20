import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
await page.context().addCookies([{ name: 'orb2_session', value: process.env.ORB_SESSION, domain: 'localhost', path: '/' }]);
await page.goto('http://localhost:9080/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
const S = process.env.SHOTS_DIR || '.';
await page.locator('#chatInput, textarea').first().fill('unlock the front door');
await page.keyboard.press('Enter');
// approval card should appear while the turn blocks
await page.waitForSelector('.wg-approval', { timeout: 30000 });
await page.screenshot({ path: S + '/lock-approval.png' });
const summary = await page.locator('.wg-approval .ap-sum').textContent().catch(() => '');
console.log('approval raised:', (summary || '').slice(0, 80));
await page.locator('.wg-approval button:has-text("Approve")').first().click();
await page.waitForTimeout(12000);
const msgs = await page.locator('.msg').allTextContents();
console.log('reply:', (msgs[msgs.length - 1] || '').replace(/\s+/g, ' ').slice(0, 100));
await b.close();
