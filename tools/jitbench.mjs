// jitbench.mjs -- the frame's CPU cost with the JavaScript JIT switched off.
//
// Edge on the Xbox runs this game with no JIT -- its sandboxed mode turns the
// optimising compiler off -- and the frame's JavaScript comes out ten to
// twelve times slower than on a desktop. Chromium's --jitless flag gives the
// same shape here: measured against a report from the console, every section
// of the frame came out in the same order and within a third of the same
// size. So this is the stand-in for the Xbox.
//
// Four fixed scenes at the Xbox's window (1280x720), each drawn 60 times with
// the camera held still ("hover") and then moving forward 0.08 tiles a frame
// ("fly"), which is the case the frame-to-frame caches like least. Reports the
// median of the whole draw and of the biggest sections (profile.js).
//
//   node tools/jitbench.mjs            # JIT off
//   JIT=1 node tools/jitbench.mjs      # JIT on, for comparison

import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';
import { base } from './serve.mjs';

const SCENES = [
  { name: 'meadow-noon', x: 0, z: 0, alt: 2, phase: 0.35 },
  { name: 'forest-dusk', x: 12, z: -30, alt: 1.5, phase: 0.78 },
  { name: 'water-night', water: true, alt: 1.4, phase: 0.88 },
  { name: 'high-day', x: 20, z: 40, alt: 8, phase: 0.45 },
];

const jit = process.env.JIT === '1';
const br = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: jit ? [] : ['--js-flags=--jitless'],
});
const pg = await br.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
await pg.addInitScript(() => {
  window.requestAnimationFrame = () => 0;
  let a = 0x9e3779b9, b = 0x243f6a88;
  Math.random = () => {
    a ^= a << 13; a ^= a >>> 17; a ^= a << 5;
    b = (b + 0x6d2b79f5) | 0;
    return ((a + b) >>> 0) / 4294967296;
  };
});
await pg.goto((await base()) + (process.env.QUERY || ''), { waitUntil: 'load' });
await pg.waitForFunction(() => !!window.lander);
await pg.click('#start');

console.log('jitbench  ' + (jit ? 'JIT on' : 'JIT off') + '  1280x720');
for (const sc of SCENES) {
  const res = await pg.evaluate(async (sc) => {
    const D = await import('/js/daylight.js');
    const L = await import('/js/landscape.js');
    const W = await import('/js/weather.js');
    const { prof } = await import('/js/profile.js');
    const TILE = 0x01000000;
    const g = window.lander.game, p = g.player;
    window.lander.renderer.adapt = () => {};
    let x = (sc.x || 0) * TILE, z = (sc.z || 0) * TILE;
    if (sc.water) {
      let best = -1;
      for (let tx = -100; tx < 100 && best <= 0.97; tx += 2) for (let tz = -100; tz < 100; tz += 2) {
        if (L.landAltitude(tx * TILE, tz * TILE) < L.SEA_LEVEL) continue;
        let s = 0, n = 0;
        for (let dx = -10; dx <= 10; dx += 2) for (let dz = -2; dz <= 26; dz += 2) {
          n++; if (L.landAltitude((tx + dx) * TILE, (tz + dz) * TILE) >= L.SEA_LEVEL) s++;
        }
        if (s / n > best) { best = s / n; x = tx * TILE; z = tz * TILE; }
      }
    }
    const place = (dz) => {
      D.setPhase(sc.phase); W.weather.wet = 0; W.weather.strength = 0; g.state = 1;
      p.x = x; p.z = (z + dz) | 0;
      p.y = ((sc.water ? L.SEA_LEVEL : L.landAltitude(p.x, p.z)) - TILE * sc.alt) | 0;
      p.vx = p.vy = p.vz = 0; p.dead = false; p.grace = 900;
    };
    for (let f = 0; f < 60; f++) { place(0); g.step(); }
    const run = (moving) => {
      const times = [];
      for (let f = 0; f < 60; f++) {
        place(moving ? (f * TILE * 0.08) | 0 : 0);
        g.step();
        const t = performance.now();
        g.draw();
        times.push(performance.now() - t);
        prof.endFrame();
      }
      times.sort((a, b) => a - b);
      const top = prof.table('ms')
        .filter((r) => r.name !== 'draw (all)' && r.name !== 'step (simulation)')
        .slice(0, 6).map((r) => r.name + ' ' + r.median.toFixed(1)).join(', ');
      return { draw: times[30].toFixed(1), top };
    };
    const hover = run(false);
    const fly = run(true);
    return { hover, fly };
  }, sc);
  console.log(sc.name.padEnd(12) + ' hover ' + res.hover.draw.padStart(5) + 'ms   fly ' + res.fly.draw.padStart(5) + 'ms');
  console.log('             fly: ' + res.fly.top);
}
if (errs.length) console.log('errors:', errs);
await br.close();
