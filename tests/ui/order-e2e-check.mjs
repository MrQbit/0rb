// Full commerce E2E (SPEC Stage 2): chat order → budget approval card →
// approve → order widget placed → sim courier → delivered.
import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
await page.context().addCookies([{ name: 'orb2_session', value: process.env.ORB_SESSION, domain: 'localhost', path: '/' }]);
await page.goto('http://localhost:9080/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
const S = process.env.SHOTS_DIR || '.';
await page.locator('#chatInput, textarea').first().fill('order the pad see ew and the tom kha from sim eats');
await page.keyboard.press('Enter');
await page.waitForSelector('.wg-approval', { timeout: 60000 });
const sum = await page.locator('.wg-approval .ap-sum').textContent();
console.log('approval:', (sum || '').slice(0, 80));
await page.screenshot({ path: S + '/order-approval.png' });
await page.locator('.wg-approval button:has-text("Approve")').first().click();
await page.waitForSelector('.wg-order', { timeout: 30000 });
let state = await page.locator('.wg-order .wg-ord-step.on').last().textContent();
console.log('order state after approve:', state);
await page.screenshot({ path: S + '/order-placed.png' });
// sim: 25 min ETA × 2000ms = ~50s to delivered; poll the widget via status refresh
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(6000);
  const r = await page.evaluate(async () => (await (await fetch('/v1/orders', { credentials: 'same-origin' })).json()).orders.length);
  if (r === 0) break;
}
const openLeft = await page.evaluate(async () => (await (await fetch('/v1/orders', { credentials: 'same-origin' })).json()).orders.length);
const journal = await page.evaluate(async () => (await (await fetch('/v1/journal?max=10', { credentials: 'same-origin' })).json()).events.map(e => e.kind + ':' + e.summary.slice(0, 40)));
console.log('open orders left:', openLeft);
console.log('journal tail:', JSON.stringify(journal.slice(-3)));
await b.close();
process.exit(openLeft === 0 && journal.some(j => j.startsWith('delivery:')) ? 0 : 1);
