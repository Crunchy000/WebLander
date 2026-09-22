// attrib.mjs -- what each layer costs the CPU side of a frame, at one spot.
// Layers are switched off one at a time through window.__layers, which the
// draw pass consults; the cost of a layer is the time the frame loses
// without it.
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';
const SCENE = process.env.SCENE || 'water';
const PHASE = Number(process.env.PHASE || 0.40);
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await br.newPage({ viewport: { width: 640, height: 300 } });
const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('http://localhost:8123/', { waitUntil: 'load' });
await pg.waitForFunction(() => !!window.lander);
await pg.click('#start');
await pg.waitForTimeout(300);

// Put the craft where the scene is and let the world fill in around it.
await pg.evaluate(async ([scene, phase]) => {
  const D = await import('/js/daylight.js');
  const L = await import('/js/landscape.js');
  const W = await import('/js/weather.js');
  const TILE = 0x01000000;
  const g = window.lander.game, p = g.player;
  let x = 0, z = 0, alt = 2, overSea = false;
  if (scene === 'water') {
    let best = -1;
    for (let tx = -100; tx < 100 && best <= 0.97; tx += 2) for (let tz = -100; tz < 100; tz += 2) {
      if (L.landAltitude(tx * TILE, tz * TILE) < L.SEA_LEVEL) continue;
      let s = 0, n = 0;
      for (let dx = -10; dx <= 10; dx += 2) for (let dz = -2; dz <= 26; dz += 2) {
        n++;
        if (L.landAltitude((tx + dx) * TILE, (tz + dz) * TILE) >= L.SEA_LEVEL) s++;
      }
      if (s / n > best) { best = s / n; x = tx * TILE; z = tz * TILE; }
    }
    overSea = true; alt = 1.4;
  }
  for (let f = 0; f < 200; f++) {
    D.setPhase(phase);
    W.weather.wet = 0; W.weather.strength = 0;
    g.state = 1;
    p.x = x; p.z = z;
    p.y = ((overSea ? L.SEA_LEVEL : L.landAltitude(x, z)) - TILE * alt) | 0;
    p.vx = p.vy = p.vz = 0; p.dead = false; p.grace = 900;
    await new Promise((r) => requestAnimationFrame(r));
  }
  g.step = () => {};
}, [SCENE, PHASE]);

const time = async (off) => pg.evaluate(async (off) => {
  const g = window.lander.game;
  window.__layers = Object.fromEntries(off.map((k) => [k, false]));
  for (let i = 0; i < 12; i++) g.draw();
  const runs = [];
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    for (let i = 0; i < 25; i++) g.draw();
    runs.push((performance.now() - t0) / 25);
  }
  window.__layers = {};
  runs.sort((a, b) => a - b);
  return runs[1];
}, off);

// Triangles are exact and repeatable, which the milliseconds are not: the
// GL queue drains between draws and a timing run picks up whatever the
// queue was already carrying. So the split below is counted, and only the
// whole frame is timed.
const trisWith = async (off) => pg.evaluate((off) => {
  const g = window.lander.game;
  window.__layers = Object.fromEntries(off.map((k) => [k, false]));
  g.draw();                       // let the row buckets fill under the flags
  g.rd.drawn = 0;
  g.draw();
  const n = g.rd.drawn / 3;
  window.__layers = {};
  g.draw();
  return n;
}, off);
const tris = await trisWith([]);

const GROUPS = [
  ['landscape', ['landscape']],
  ['  objects in it', ['objects']],
  ['  flowers in it', ['flowers']],
  ['  lanterns in it', ['lanterns']],
  ['horizon (haze+ridges+near)', ['haze', 'ridges', 'nearGround']],
  ['sky (bands+stars+sun)', ['sky', 'stars', 'celestial']],
  ['clouds', ['clouds']],
  ['far balloons', ['farBalloons']],
  ['craft+ribbon+particles', ['player', 'ribbon', 'particles']],
  ['weather', ['weather']],
  ['hud', ['hud']],
];
const full = await time([]);
console.log(SCENE, 'phase', PHASE, '-- full frame', full.toFixed(3), 'ms,', tris, 'triangles');
for (const [name, keys] of GROUPS) {
  const without = await trisWith(keys);
  const n = tris - without;
  console.log('  ' + name.padEnd(28) + String(n).padStart(6) + ' tris  ' +
              (100 * n / tris).toFixed(1).padStart(5) + '%');
}
const floor = await trisWith(GROUPS.flatMap(([, k]) => k));
console.log('  ' + 'everything off (floor)'.padEnd(28) + String(floor).padStart(6) + ' tris');
console.log('errors:', errs.length ? errs : 'none');
await br.close();
