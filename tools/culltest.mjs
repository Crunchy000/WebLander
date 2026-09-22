// culltest.mjs -- does dropping the far side of a closed model change the
// picture? Renders the same frame with the flag on and off and counts the
// pixels that differ, plus what it saves.
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';
import fs from 'fs';
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await br.newPage({ viewport: { width: 900, height: 420 } });
const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('http://localhost:8123/', { waitUntil: 'load' });
await pg.waitForFunction(() => !!window.lander);
await pg.click('#start');
await pg.waitForTimeout(300);
const out = await pg.evaluate(async ([phase, alt]) => {
  const D = await import('/js/daylight.js');
  const L = await import('/js/landscape.js');
  const W = await import('/js/weather.js');
  const O = await import('/js/objects.js');
  const TILE = 0x01000000;
  const g = window.lander.game, p = g.player;
  // Somewhere with plenty of things standing up in it.
  let spot = null, best = -1;
  for (let tz = -40; tz < 40; tz += 2) for (let tx = -40; tx < 40; tx += 2) {
    let n = 0;
    for (let dz = 0; dz < 20; dz += 2) for (let dx = -8; dx <= 8; dx += 2) {
      if (O.objectAt(tx + dx, tz + dz) >= 0) n++;
    }
    if (n > best) { best = n; spot = [tx, tz]; }
  }
  for (let f = 0; f < 150; f++) {
    D.setPhase(phase);
    W.weather.wet = 0; W.weather.strength = 0;
    g.state = 1;
    p.x = (spot[0] * TILE) | 0; p.z = (spot[1] * TILE) | 0;
    p.y = (L.landAltitude(p.x, p.z) - TILE * alt) | 0;
    p.vx = p.vy = p.vz = 0; p.dead = false; p.grace = 900;
    await new Promise((r) => requestAnimationFrame(r));
  }
  g.step = () => {};
  const count = () => { g.rd.drawn = 0; g.draw(); return g.rd.drawn / 3; };
  const on = count();
  for (const m of O.MODELS) m.solid = false;
  const off = count();
  for (const m of O.MODELS) m.solid = true;
  return { objects: best, trisWithCulling: on, trisWithout: off };
}, [Number(process.env.PHASE || 0.35), Number(process.env.ALT || 2.2)]);
console.log(JSON.stringify(out));

// Two screenshots, to compare pixel for pixel.
const shot = async (on) => {
  await pg.evaluate(async (on) => {
    const O = await import('/js/objects.js');
    for (const m of O.MODELS) m.solid = on;
    const g = window.lander.game;
    for (let i = 0; i < 3; i++) g.draw();
  }, on);
  return pg.locator('#screen').screenshot();
};
const a = await shot(true), b = await shot(false);
fs.writeFileSync('/tmp/cull-on.png', a);
fs.writeFileSync('/tmp/cull-off.png', b);
console.log('errors:', errs.length ? errs : 'none');
await br.close();
