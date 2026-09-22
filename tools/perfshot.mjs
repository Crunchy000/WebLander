// perfshot.mjs -- does the readout appear, does it say sensible things, and
// does the console line arrive?
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await br.newPage({ viewport: { width: 900, height: 470 } });
const logs = [], errs = [];
pg.on('console', (m) => { if (m.text().startsWith('weblander:')) logs.push(m.text()); });
pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('http://localhost:8123/?perf=1', { waitUntil: 'load' });
await pg.waitForFunction(() => !!window.lander);
await pg.click('#start');
await pg.waitForTimeout(12000);
const text = await pg.evaluate(() => {
  const b = document.getElementById('perf');
  return b ? b.textContent : null;
});
console.log('overlay:\n' + text);
console.log('console lines:', logs.length);
for (const l of logs) console.log('  ' + l);
console.log('errors:', errs.length ? errs : 'none');
await pg.screenshot({ path: process.env.OUT || '/tmp/perf.png' });
await br.close();
