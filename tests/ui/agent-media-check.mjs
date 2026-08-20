import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
await page.context().addCookies([{ name: 'orb2_session', value: process.env.ORB_SESSION, domain: 'localhost', path: '/' }]);
await page.goto('http://localhost:9080/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
const S = process.env.SHOTS_DIR || '.';
const out = [];
async function ask(text, wait=25000){ await page.locator('#chatInput, textarea').first().fill(text); await page.keyboard.press('Enter'); await page.waitForTimeout(wait); }

await ask('show me the tv remote');
const tvW = await page.locator('.wg .wg-tv').count();
const tvSrcs = await page.locator('.wg .wg-tv-src').count();
out.push(`tv widget: ${tvW>0?'PASS':'FAIL'} (inputs: ${tvSrcs})`);
await page.screenshot({ path: S + '/agent-tv.png' });

await ask('open the spotify player');
const spW = await page.locator('.wg .wg-sp').count();
const spTxt = spW ? await page.locator('.wg .wg-sp').first().textContent() : '';
out.push(`spotify widget: ${spW>0?'PASS':'FAIL'} (${(spTxt||'').replace(/\s+/g,' ').slice(0,60)})`);
await page.screenshot({ path: S + '/agent-spotify.png' });

console.log(out.join('\n'));
await b.close();
process.exit(tvW>0 && spW>0 ? 0 : 1);
