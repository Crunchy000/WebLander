// adapt.mjs -- does the backing store come down when the machine cannot keep
// up, and does it go back up when it can?
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await br.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('http://localhost:8123/?perf=1', { waitUntil: 'load' });
await pg.waitForFunction(() => !!window.lander);
await pg.click('#start');
const seen = [];
for (let i = 0; i < 12; i++) {
  await pg.waitForTimeout(2000);
  seen.push(await pg.evaluate(() => {
    const cv = document.getElementById('screen');
    const r = window.lander.renderer;
    return { rows: cv.height, scale: r.scale };
  }));
}
console.log(JSON.stringify(seen));
console.log('errors:', errs.length ? errs : 'none');
await br.close();
