// fill.mjs -- how much of the frame is pixels rather than geometry: the same
// flight, at the resolution the game ships at and at the one it used to be.
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await br.newPage({ viewport: { width: 960, height: 560 } });
const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
await pg.addInitScript(() => {
  window.__pad = { axes: [0, 0, 0, 0], buttons: new Array(17).fill(0).map(() => ({ pressed: false, value: 0 })) };
  const fake = { id: 'F', index: 0, connected: true, mapping: 'standard',
                 get axes() { return window.__pad.axes; }, get buttons() { return window.__pad.buttons; }, timestamp: 0 };
  navigator.getGamepads = () => [fake];
  window.__press = (i, v = 1) => { window.__pad.buttons[i] = { pressed: v > 0, value: v }; };
});
await pg.goto('http://localhost:8123/', { waitUntil: 'load' });
await pg.waitForFunction(() => !!window.lander);
await pg.click('#start');
const out = await pg.evaluate(async ([rows, seconds]) => {
  const R = await import('/js/renderer.js');
  const g = window.lander.game;
  const cv = document.getElementById('screen');
  // Force the backing store to a given height, keeping the design aspect.
  if (rows > 0) {
    cv.width = Math.round(rows * (R.SCREEN_W / R.SCREEN_H));
    cv.height = rows;
    g.rd.gl.viewport(0, 0, cv.width, cv.height);
  }
  window.__press(7, 1);
  let frames = 0, worst = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    const a = performance.now() / 1400;
    window.__pad.axes = [Math.sin(a) * 0.8, Math.cos(a * 0.7) * 0.8, 0, 0];
    const f0 = performance.now();
    await new Promise((r) => requestAnimationFrame(r));
    worst = Math.max(worst, performance.now() - f0);
    frames++;
  }
  return { rows: cv.height, cols: cv.width, pixels: cv.width * cv.height,
           frames, fps: +(frames / seconds).toFixed(1), worstMs: +worst.toFixed(1) };
}, [Number(process.env.ROWS || 0), Number(process.env.SECS || 12)]);
console.log(JSON.stringify(out), 'errors:', errs.length ? errs : 'none');
await br.close();
