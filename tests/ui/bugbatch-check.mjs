// Live regression for the 2026-08-20 bug batch — real chat flows in the console.
import { chromium } from 'playwright';
const b = await chromium.launch();
const page = await (await b.newContext()).newPage();
await page.context().addCookies([{ name: 'orb2_session', value: process.env.ORB_SESSION, domain: 'localhost', path: '/' }]);
await page.goto('http://localhost:9080/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const S = process.env.SHOTS_DIR || '.';
const results = [];
const ok = (name, pass, extra='') => { results.push(`${pass?'PASS':'FAIL'}  ${name}${extra?' — '+extra:''}`); };

async function ask(text, waitMs=25000){
  await page.locator('#chatInput, textarea').first().fill(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(waitMs);
}

// 1. Settings-open control event actually opens the panel.
await ask('open the settings panel', 20000);
const panelOpen = await page.locator('#settingsPanel.open').count();
ok('agent opens Settings panel', panelOpen === 1);
await page.screenshot({ path: S + '/bug5-settings-open.png' });
await page.locator('#setClose').click().catch(()=>{});
await page.waitForTimeout(500);

// 2. Media widget targets the asked-for device only.
await ask('show me the sonos media controls', 25000);
const mediaTitles = await page.locator('.wg .wg-title').allTextContents();
const mediaWgs = mediaTitles.filter(t => /sonos|tv|media|living/i.test(t));
const mentionsTv = mediaWgs.some(t => /tv/i.test(t));
ok('media widget is the Sonos, not the TV', mediaWgs.length >= 1 && !mentionsTv, mediaWgs.join(' | '));
await page.screenshot({ path: S + '/bug3-media-sonos.png' });

// 3. Spotify honest failure + no separate "local" bubble.
await ask('search spotify for the beatles', 30000);
const msgs = await page.locator('.msg.assistant, .msg').allTextContents();
const lastMsg = msgs[msgs.length-1] || '';
ok('Spotify unconfigured message names setup path', /developer\.spotify\.com|Settings.*Apps.*Spotify/i.test(msgs.join(' ')));
const soloLocal = msgs.some(t => t.trim() === 'local' || t.trim() === '▪ local');
ok('no standalone "local" bubble', !soloLocal);
const badgeInline = await page.locator('.msg .prov-badge').count();
ok('provenance badge inline in bubbles', badgeInline > 0, String(badgeInline));
await page.screenshot({ path: S + '/bug1-spotify-badge.png' });

// 4. Pin button sits immediately left of close, right edge.
const wg = page.locator('.wg').last();
const pinBox = await wg.locator('.wg-pin').boundingBox().catch(()=>null);
const xBox = await wg.locator('.wg-x').boundingBox().catch(()=>null);
const wgBox = await wg.boundingBox().catch(()=>null);
const pinRight = pinBox && xBox && wgBox && (xBox.x - (pinBox.x + pinBox.width)) < 14 && (wgBox.x + wgBox.width - xBox.x - xBox.width) < 24;
ok('pin adjacent to close at right edge', !!pinRight, pinBox&&xBox?`gap=${Math.round(xBox.x-pinBox.x-pinBox.width)}px`: 'missing');
await wg.screenshot({ path: S + '/bug4-pin.png' }).catch(()=>{});

console.log(results.join('\n'));
await b.close();
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
