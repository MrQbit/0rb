// Claim ceremony UI: mock an unclaimed orb and shoot the login page.
import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await (await b.newContext()).newPage();
await page.route('**/v1/claim', r => r.request().method() === 'GET'
  ? r.fulfill({ json: { available: true, code: 'KXWM2N7P', expires_at: Date.now() + 600000, uri: 'orb2-claim://orb.local/KXWM2N7P' } })
  : r.continue());
await page.route('**/v1/claim/qr.svg*', async r => {
  // real QR from the live API is 404 (owned) — draw a stand-in so layout is honest
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><rect width="29" height="29" fill="none"/><path fill="#e9f1e2" d="M0 0h7v7H0zM22 0h7v7h-7zM0 22h7v7H0zM10 2h2v2h-2zM14 4h2v2h-2zM9 9h11v11H9z"/></svg>';
  await r.fulfill({ contentType: 'image/svg+xml', body: svg });
});
await page.route('**/v1/auth/me', r => r.fulfill({ json: { authenticated: false } }));
await page.goto('http://localhost:9080/login.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const claimShown = await page.locator('#step-claim:not(.hide)').count();
const emailHidden = await page.locator('#step-email.hide').count();
const code = await page.locator('#claimCode').textContent();
console.log(`claim step: ${claimShown ? 'shown' : 'MISSING'} | email step hidden: ${!!emailHidden} | code: ${code}`);
await page.screenshot({ path: (process.env.SHOTS_DIR || '.') + '/claim-login.png' });
await b.close();
process.exit(claimShown && emailHidden ? 0 : 1);
