// clouds.js -- the weather you can see from underneath.
//
// Clouds sit in the sky layer, between the sun and the landscape, so they
// drift across the sun and are painted over by the horizon. They are drawn as
// vertical strips rather than as outlines: at each column the top edge is the
// highest of whichever lobes cover it, and the strip runs from there down to
// a flat base. That handles a lumpy, concave silhouette without any
// triangulation cleverness, and it puts a vertical gradient in each strip for
// nothing -- lit along the top, shaded underneath, which is the whole reason a
// flat shape reads as something with volume.
//
// Nothing here picks a colour of its own. A cloud is the sky it sits in,
// pushed towards whatever is lighting it, so dawn turns them pink, dusk gold,
// a storm grey and night a dark slate without any of those being written
// down anywhere.

import { sky, sun, skyColourAt, SKY_BAND_2 } from './daylight.js';
import { SCREEN_W } from './renderer.js';

const COUNT = 11;

// The band clouds live in. The top of the screen and the horizon are both
// left clear: one because a cloud jammed into the corner looks like a mistake,
// the other because the landscape is about to be drawn over it anyway.
const TOP = 6, BOTTOM = SKY_BAND_2 - 14;

// Clouds wrap through a span wider than the screen so they have somewhere to
// come from and go to.
const SPAN = SCREEN_W + 180;

function makeClouds() {
  let s = 0x1b9f37;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out = [];
  for (let i = 0; i < COUNT; i++) {
    const lobes = [];
    const n = 3 + Math.floor(rnd() * 3);
    const w = 26 + rnd() * 52;
    for (let k = 0; k < n; k++) {
      // Lobes are spread across the width and sized so the middle ones stand
      // taller than the ends, which is what gives a cloud a shoulder rather
      // than a row of identical bumps.
      const t = n === 1 ? 0.5 : k / (n - 1);
      const hump = 1 - Math.abs(t - 0.5) * 1.35;
      lobes.push({
        dx: (t - 0.5) * w,
        r: (5 + rnd() * 7) * (0.55 + hump),
      });
    }
    out.push({
      x: rnd() * SPAN,
      // Higher clouds are smaller and drift slower: the only depth cue
      // available when everything is painted on the same flat sky.
      depth: 0.35 + rnd() * 0.65,
      y: 0,
      lobes,
      w,
      tone: 0.86 + rnd() * 0.14,
    });
  }
  // Far ones first, so nearer clouds pass in front.
  out.sort((a, b) => a.depth - b.depth);
  return out;
}

const CLOUDS = makeClouds();

const top = [0, 0, 0], bot = [0, 0, 0];
const MOONLIT = [188, 200, 226];
const STORM = [58, 62, 74];

function mix(out, a, b, t) {
  out[0] = Math.round(a[0] + (b[0] - a[0]) * t);
  out[1] = Math.round(a[1] + (b[1] - a[1]) * t);
  out[2] = Math.round(a[2] + (b[2] - a[2]) * t);
  return out;
}

// Step across the cloud in columns this wide. Three pixels is fine on a 320
// wide screen and keeps a sky full of cloud down to a few hundred triangles.
const STEP = 3;

export function drawClouds(rd) {
  const murk = sky.murk;
  const lit = sun.up ? sun.col : MOONLIT;

  for (const c of CLOUDS) {
    // Drift. Wind carries them; without it they still move, because a sky
    // that has stopped looks painted on.
    const speed = (0.055 + murk * 0.10) * c.depth;
    let x = (c.x + sky.tick * speed) % SPAN;
    if (x < 0) x += SPAN;
    x -= 90;

    // Under cloud they hang lower, sit bigger and lose their edges to grey.
    const scale = (0.52 + 0.70 * murk) * (0.55 + c.depth * 0.8);
    const y = TOP + (BOTTOM - TOP) * (1 - c.depth) * 0.9 + murk * 12;
    if (y > BOTTOM) continue;

    // Fair weather pushes a cloud towards whatever is lighting it. Foul
    // weather pushes it towards slate instead, and past the sky behind it:
    // what makes a sky look heavy is cloud DARKER than the gap it sits in,
    // and mixing towards the light under storm murk gave cheerful white
    // puffs on a grey afternoon.
    const back = skyColourAt(y);
    mix(top, back, lit, 0.74 * c.tone);
    mix(bot, back, lit, 0.30 * c.tone);
    if (murk > 0.01) {
      mix(top, top, STORM, murk * 0.80);
      mix(bot, bot, STORM, murk * 0.92);
    }

    const half = (c.w * 0.5 + 12) * scale;
    for (let px = -half; px < half; px += STEP) {
      // The silhouette is the union of the lobes: the highest top wins.
      let hit = false, yTopL = 1e9, yTopR = 1e9;
      for (const lo of c.lobes) {
        const r = lo.r * scale, cx = lo.dx * scale;
        const dL = px - cx, dR = px + STEP - cx;
        if (Math.abs(dL) < r) {
          const h = Math.sqrt(r * r - dL * dL);
          if (y - h < yTopL) yTopL = y - h;
          hit = true;
        }
        if (Math.abs(dR) < r) {
          const h = Math.sqrt(r * r - dR * dR);
          if (y - h < yTopR) yTopR = y - h;
          hit = true;
        }
      }
      if (!hit) continue;
      if (yTopL > 1e8) yTopL = y;
      if (yTopR > 1e8) yTopR = y;
      if (yTopL >= y && yTopR >= y) continue;

      const xL = x + px, xR = x + px + STEP;
      if (xR < -4 || xL > SCREEN_W + 4) continue;

      rd.quadShaded(xL, yTopL, top, xR, yTopR, top, xR, y, bot, xL, y, bot);
    }
  }
}
