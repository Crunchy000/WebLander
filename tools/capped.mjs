// capped.mjs -- a machine that shows thirty frames a second because that is
// its cadence, not because it is struggling. The adaptor should leave the
// picture alone.
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await br.newPage({ viewport: { width: 640, height: 360 } });
const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
// Hold every frame to a 33.3ms slot, the way a vsync at thirty would.
await pg.addInitScript(() => {
  const period = 1000 / 30;
  let next = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => {
    const now = performance.now();
    if (!next) next = now;
    next = Math.max(next + period, now);
    return window.setTimeout(() => fn(performance.now()), Math.max(0, next - now));
  };
});
await pg.goto('http://localhost:8123/?perf=1', { waitUntil: 'load' });
await pg.waitForFunction(() => !!window.lander);
await pg.click('#start');
const seen = [];
for (let i = 0; i < 8; i++) {
  await pg.waitForTimeout(2500);
  seen.push(await pg.evaluate(() => {
    const cv = document.getElementById('screen');
    return { rows: cv.height, scale: window.lander.renderer.scale };
  }));
}
console.log(JSON.stringify(seen));
console.log(await pg.evaluate(() => document.getElementById('perf').textContent));
console.log('errors:', errs.length ? errs : 'none');
await br.close();
