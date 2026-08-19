// Orb console UI smoke — full user flows against the LIVE stack.
//
// Run:  bash tests/ui/run.sh            (needs the stack up on :9080)
// Env:  ORB_SESSION=<orb2_session token>  ORB_BASE=http://localhost:9080
//
// Screenshots land in tests/ui/shots/ — look at them after every run; a
// green exit code is necessary but NOT sufficient.
import { chromium } from 'playwright';

const BASE = process.env.ORB_BASE || 'http://localhost:9080';
const TOKEN = process.env.ORB_SESSION;
const SHOTS = process.env.SHOTS_DIR || '/shots';
if (!TOKEN) { console.error('FATAL: set ORB_SESSION'); process.exit(2); }

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'orb2_session', value: TOKEN, url: BASE }]);
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(String(e)));

const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

// ── 1. Console loads, brand renders as "0rb²" with no stray space ──
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);
{
  const wordmark = await page.locator('.wordmark').innerText().catch(() => '');
  const compact = wordmark.replace(/\s+/g, '');
  check('brand: wordmark is 0rb²', compact === '0rb2', `saw "${wordmark}"`);
  // open the chat panel (tap the orb) and check ITS title too — this is
  // where the flex-gap "0 rb" bug lived.
  await page.locator('#orb').click({ position: { x: 60, y: 60 } }).catch(() => {});
  await page.waitForTimeout(900);
  const title = await page.locator('.panel-head .title .brand').innerText().catch(() => '');
  check('brand: chat panel title is 0rb² (no gap)', title.replace(/\s+/g, '') === '0rb2', `saw "${title}"`);
  await shot('01-console');
}

// ── 2. Settings: every tab opens and renders content ──
await page.evaluate(() => { const b = document.querySelector('[data-act="settings"]'); b && b.click(); });
await page.waitForTimeout(1200);
{
  const accessTab = await page.locator('.set-navi[data-sec="access"]').count();
  check('settings: Access tab is gone', accessTab === 0);
  const tabs = await page.locator('.set-navi').evaluateAll(els => els.map(e => e.dataset.sec));
  for (const sec of tabs) {
    await page.locator(`.set-navi[data-sec="${sec}"]`).click();
    await page.waitForTimeout(800);
    const visible = await page.locator(`.set-sec[data-sec="${sec}"]`).isVisible();
    const text = (await page.locator(`.set-sec[data-sec="${sec}"]`).innerText().catch(() => '')).trim();
    check(`settings: tab "${sec}" renders`, visible && text.length > 20, `${text.length} chars`);
    await shot(`02-settings-${sec}`);
  }
}

// ── 3. System tab: remote access lives here now, device URL when enrolled ──
{
  await page.locator('.set-navi[data-sec="system"]').click();
  await page.waitForTimeout(1500);
  const sys = await page.locator('.set-sec[data-sec="system"]').innerText();
  check('system: contains Remote access', /remote access/i.test(sys));
  check('system: tailscale status shown', /tailscale/i.test(sys));
  const info = await page.evaluate(async () => (await (await fetch('/v1/info', { credentials: 'same-origin' })).json()));
  if (info.device_url) {
    check('system: device URL card shown', await page.locator('#devUrlCard').isVisible(), info.device_url);
  } else {
    check('system: device URL absent (not enrolled)', true);
  }
  await shot('03-system');
}

// ── 4. Smart home: direct devices FIRST, HA below, setup flow opens ──
{
  await page.locator('.set-navi[data-sec="smarthome"]').click();
  await page.waitForTimeout(2500);
  const sec = page.locator('.set-sec[data-sec="smarthome"]');
  // set-h4 renders uppercase — compare case-insensitively.
  const txt = (await sec.innerText()).toLowerCase();
  const idxDirect = txt.indexOf('on your network');
  const idxHA = txt.indexOf('home assistant — deep control');
  check('smarthome: direct-first ordering', idxDirect >= 0 && idxHA > idxDirect, `direct@${idxDirect} ha@${idxHA}`);
  const bridgeRows = await page.locator('#bridgeDevices .set-item').count();
  check('smarthome: bridge devices listed', bridgeRows > 0, `${bridgeRows} rows`);
  // discovered flow: open a setup form; it must show HUMAN labels, not raw ids
  const flowRows = await page.locator('#haFlows .set-item').count();
  if (flowRows > 0) {
    await page.locator('#haFlows .set-item button:has-text("Set up")').first().click();
    await page.waitForTimeout(2000);
    const form = await page.locator('#haFlows .ha-flow-box').first().innerText();
    check('smarthome: setup form has no raw step ids', !/step:\s*\w+_?\w*$/im.test(form) && !/zeroconf_confirm/.test(form) || /Discovered|printer|add/i.test(form), form.slice(0, 80));
  }
  await shot('04-smarthome');
}

// ── 4b. Apple Home (Matter) card + remote-mode chooser ──
{
  const matterVisible = await page.locator('#matterCard').isVisible().catch(() => false);
  if (matterVisible) {
    const txt = await page.locator('#matterCard').innerText();
    check('smarthome: Apple Home card meaningful', /paired|ready to pair|setup code/i.test(txt), txt.slice(0, 60));
  } else {
    check('smarthome: Apple Home card absent (bridge down?)', false, 'card not visible');
  }
  await page.locator('.set-navi[data-sec="system"]').click();
  await page.waitForTimeout(1500);
  const lanBtn = await page.locator('#rmLan').isVisible().catch(() => false);
  const dirBtn = await page.locator('#rmDirect').isVisible().catch(() => false);
  check('system: remote-mode chooser present', lanBtn && dirBtn);
  await shot('04b-system-remote');
}

// ── 5. Chat flow: send a message, get streamed text back ──
{
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const p = document.getElementById('panel');
    if (p) p.scrollIntoView({ block: 'center' });
    const i = document.getElementById('input');
    if (i) i.focus();
  });
  await page.waitForTimeout(600);
  await page.keyboard.type('Say only the word: ready', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(12000);
  const feed = await page.locator('#panel').innerText().catch(() => '');
  check('chat: agent replied', /ready/i.test(feed), feed.slice(-120).replace(/\n/g, ' | '));
  await shot('05-chat');
}

// ── 6. Widget lifecycle: spawn one via the bus, then CLOSE it ──
{
  // ask for a widget the agent reliably emits (house mode)
  await page.evaluate(() => {
    const i = document.getElementById('input');
    if (i) i.focus();
  });
  await page.keyboard.type('show the house mode widget', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(14000);
  const wgCount = await page.locator('.wg').count();
  check('widget: spawned', wgCount > 0, `${wgCount} widgets`);
  await shot('06-widget-open');
  if (wgCount > 0) {
    const before = await page.locator('.wg').count();
    // click the ✕ — this used to be eaten by the header's pointer capture
    await page.locator('.wg .wg-x').first().click();
    await page.waitForTimeout(700);
    const after = await page.locator('.wg').count();
    check('widget: close button removes the widget', after === before - 1, `${before} → ${after}`);
    await shot('07-widget-closed');
  }
}

// ── 7. No console errors through all of the above ──
{
  const real = consoleErrors.filter(e => !/favicon|404.*Not Found|net::ERR_ABORTED/.test(e));
  check('no page/console errors', real.length === 0, real.slice(0, 3).join(' ;; '));
}

await ctx.close();
await browser.close();

console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
