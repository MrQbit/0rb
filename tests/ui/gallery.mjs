// Widget gallery — renders EVERY widget type through the real console
// renderer with fixture data, screenshots each one, and reports anything
// that fails to render. The per-widget PNGs are the audit surface: look
// at every one.
//
// Run: bash tests/ui/run-gallery.sh   (stack on :9080; shots in shots/gallery)
import { chromium } from 'playwright';
import { FIXTURES } from './fixtures.mjs';

const BASE = process.env.ORB_BASE || 'http://localhost:9080';
const TOKEN = process.env.ORB_SESSION;
const SHOTS = process.env.SHOTS_DIR || '/shots';
if (!TOKEN) { console.error('FATAL: set ORB_SESSION'); process.exit(2); }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: 'orb2_session', value: TOKEN, url: BASE }]);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => typeof window.__orbSpawnWidget === 'function', { timeout: 30000 });
await page.waitForTimeout(1500);

let failures = 0;
for (const spec of FIXTURES) {
  const name = spec.type;
  const errBefore = pageErrors.length;
  try {
    await page.evaluate(s => {
      window.scrollTo(0, 0);
      const wg = window.__orbSpawnWidget({ id: `fx-${s.type}`, ...s });
      // pin to a stable spot so the shot is consistent
      if (wg) { wg.style.left = '40px'; wg.style.top = '90px'; }
    }, spec);
    // heavier renderers (map tiles, chart, iframes) need a beat
    await page.waitForTimeout(['map', 'chart', 'model', 'app', 'html', 'embed'].includes(name) ? 2500 : 900);
    const wg = page.locator(`#wg-fx-${name}, .wg`).last();
    const box = await wg.boundingBox();
    const bodyText = await wg.locator('.wg-body').innerText().catch(() => '');
    const childCount = await wg.locator('.wg-body *').count();
    const renderError = /widget render error/i.test(bodyText);
    const empty = childCount === 0 && bodyText.trim() === '';
    const jsErr = pageErrors.length > errBefore ? pageErrors.slice(errBefore).join('; ') : '';
    const ok = !!box && !renderError && !empty && !jsErr;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${renderError ? ' — render error' : ''}${empty ? ' — empty body' : ''}${jsErr ? ` — js: ${jsErr.slice(0, 120)}` : ''}`);
    if (box) await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 6), width: Math.min(box.width + 12, 1200), height: Math.min(box.height + 12, 980) } });
    // close it (also exercises the ✕ path on every widget)
    await wg.locator('.wg-x').click({ timeout: 3000 }).catch(async () => {
      await page.evaluate(() => document.querySelectorAll('.wg').forEach(w => w.remove()));
    });
    await page.waitForTimeout(250);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name} — harness: ${String(e).slice(0, 140)}`);
    await page.evaluate(() => document.querySelectorAll('.wg').forEach(w => w.remove())).catch(() => {});
  }
}

await ctx.close();
await browser.close();
console.log(`\n${FIXTURES.length - failures}/${FIXTURES.length} widgets rendered clean`);
process.exit(failures ? 1 : 0);
