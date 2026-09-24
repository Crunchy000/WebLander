// pixeldiff.mjs -- render the same frames and write them out, so two builds
// can be compared pixel for pixel. Run it once per build with a different
// OUT, then again with A and B set to compare the two sets.
//
// Scenes are fixed places and times, weather off, the world held still, so
// the only thing that can differ between two runs is the renderer.
import fs from 'fs';
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';

const SCENES = [
  { name: 'meadow-noon', x: 0, z: 0, alt: 2, phase: 0.35 },
  { name: 'forest-dusk', x: 12, z: -30, alt: 1.5, phase: 0.78 },
  { name: 'water-night', water: true, alt: 1.4, phase: 0.88 },
  { name: 'high-day', x: 20, z: 40, alt: 8, phase: 0.45 },
];

async function shoot(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const pg = await br.newPage({ viewport: { width: 900, height: 420 } });
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  // Two runs of the same build have to agree before two builds can be
  // compared, and out of the box they do not: lanterns and clouds come from
  // Math.random, and the real loop steps however many times the wall clock
  // allows. So the randomness is seeded, and once the game is up the loop is
  // stopped and the world is stepped by hand a fixed number of times.
  await pg.addInitScript(() => {
    // No loop at all: the game is stepped and drawn by hand from here, so the
    // wall clock never decides how far the world has got.
    window.requestAnimationFrame = () => 0;
    let a = 0x9e3779b9, b = 0x243f6a88;
    Math.random = () => {
      a ^= a << 13; a ^= a >>> 17; a ^= a << 5;
      b = (b + 0x6d2b79f5) | 0;
      return ((a + b) >>> 0) / 4294967296;
    };
  });
  await pg.goto('http://localhost:8123/' + (process.env.QUERY || ''), { waitUntil: 'load' });
  await pg.waitForFunction(() => !!window.lander);
  await pg.click('#start');
  for (const sc of SCENES) {
    await pg.evaluate(async (sc) => {
      const D = await import('/js/daylight.js');
      const L = await import('/js/landscape.js');
      const W = await import('/js/weather.js');
      const TILE = 0x01000000;
      const g = window.lander.game, p = g.player;
      // Hold the resolution still: the adaptor moving between two runs
      // would be a difference that has nothing to do with the change.
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
      for (let f = 0; f < 90; f++) {
        D.setPhase(sc.phase); W.weather.wet = 0; W.weather.strength = 0; g.state = 1;
        p.x = x; p.z = z;
        p.y = ((sc.water ? L.SEA_LEVEL : L.landAltitude(x, z)) - TILE * sc.alt) | 0;
        p.vx = p.vy = p.vz = 0; p.dead = false; p.grace = 900;
        g.step();
      }
      D.setPhase(sc.phase);
      p.x = x; p.z = z;
      p.y = ((sc.water ? L.SEA_LEVEL : L.landAltitude(x, z)) - TILE * sc.alt) | 0;
      g.draw();
    }, sc);
    fs.writeFileSync(outDir + '/' + sc.name + '.png', await pg.locator('#screen').screenshot());
  }
  await br.close();
  if (errs.length) console.log('errors:', errs);
}

async function compare(a, b) {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const pg = await br.newPage();
  for (const sc of SCENES) {
    const pa = fs.readFileSync(a + '/' + sc.name + '.png').toString('base64');
    const pb = fs.readFileSync(b + '/' + sc.name + '.png').toString('base64');
    const r = await pg.evaluate(async ([pa, pb]) => {
      const load = (d) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = d; });
      const ia = await load('data:image/png;base64,' + pa), ib = await load('data:image/png;base64,' + pb);
      const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(ia, 0, 0); const A = x.getImageData(0, 0, c.width, c.height).data;
      x.clearRect(0, 0, c.width, c.height); x.drawImage(ib, 0, 0);
      const B = x.getImageData(0, 0, c.width, c.height).data;
      let diff = 0, worst = 0;
      for (let i = 0; i < A.length; i += 4) {
        const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
        if (d > 2) { diff++; if (d > worst) worst = d; }
      }
      return { pixels: c.width * c.height, diff, worst };
    }, [pa, pb]);
    console.log(sc.name.padEnd(14) + String(r.diff).padStart(7) + ' of ' + r.pixels + ' differ' +
                (r.diff ? '  (worst channel ' + r.worst + ')' : ''));
  }
  await br.close();
}

if (process.env.A && process.env.B) await compare(process.env.A, process.env.B);
else await shoot(process.env.OUT || '/tmp/frames');
