// ridges.js -- parallax silhouette ranges along the horizon.
//
// The one thing the reference style has that this engine had nothing of: a
// deep stack of flat, receding profiles that give the horizon somewhere to be
// and make the world feel enormous without drawing any more of it.
//
// It is cheap here for a reason that is usually a limitation. The camera never
// rotates, so screen x and world x are the same direction -- which means a
// distant range is not geometry at all, it is a one-dimensional height
// function of world x, sampled straight across the screen. No projection, no
// clipping, no sorting.
//
// Colour comes from the sky the layer is standing against rather than from a
// palette of its own, so the whole stack moves through sunrise, noon, dusk and
// night without anything here knowing what time it is.

import { TILE } from './maths.js';
import { sky, skyColourAt } from './daylight.js';
import { SCREEN_W, SCREEN_H, CENTRE_X } from './renderer.js';

// Each layer: how far away it reads as, where its skyline sits, how much it
// rises and falls, and how much of the world fits across the screen. Far
// layers move slowly and are pale; near ones move quickly and are dark, which
// is the whole of aerial perspective and all it needs to be.
const LAYERS = [
  { parallax: 0.045, baseY: 104, amp: 30, span: 0.0055, seed: 1.7, dark: 0.16, roll: 0.9 },
  { parallax: 0.090, baseY: 116, amp: 26, span: 0.0090, seed: 4.1, dark: 0.30, roll: 1.4 },
  { parallax: 0.165, baseY: 126, amp: 22, span: 0.0150, seed: 8.3, dark: 0.46, roll: 2.1 },
  { parallax: 0.290, baseY: 134, amp: 17, span: 0.0250, seed: 2.9, dark: 0.62, roll: 3.3 },
];

// How wide a step across the screen. Eight pixels is coarse enough to be
// cheap and fine enough that a ridge line reads as a ridge and not as a saw.
const STEP = 8;

// The profile of a range at a point along it. Three sines of unrelated
// wavelength, one of them squared, which is enough to give peaks that differ
// in height and spacing without any of them repeating visibly.
function profile(u, seed) {
  const a = Math.sin(u * 1.00 + seed);
  const b = Math.sin(u * 2.37 + seed * 1.7);
  const c = Math.sin(u * 0.41 + seed * 0.6);
  const raw = 0.46 * a + 0.28 * b + 0.26 * c;
  // Push it towards peaks rather than dunes: sharper at the top, flatter in
  // the troughs, which is what separates a mountain range from a wave.
  return 0.5 + 0.5 * Math.sign(raw) * Math.pow(Math.abs(raw), 0.72);
}

const col = [0, 0, 0, 255];
const colB = [0, 0, 0, 255];

// A range's colour: the sky behind it, taken towards the dusk-coloured dark
// so it reads as a silhouette rather than as paint. The horizon is left a
// shade lighter than the skyline, which is the haze pooling at the foot of
// the hills and the cheapest depth cue there is.
function tint(layer, y, out, foot) {
  const s = skyColourAt(y);
  const d = layer.dark * (foot ? 0.62 : 1);
  // Silhouettes go towards a cool dark at night and a warm one by day, which
  // is what keeps a dusk frame from turning grey.
  const warm = sky.sunStrength;
  const tr = 18 + 30 * warm, tg = 16 + 18 * warm, tb = 34 + 10 * warm;
  out[0] = Math.round(s[0] + (tr - s[0]) * d);
  out[1] = Math.round(s[1] + (tg - s[1]) * d);
  out[2] = Math.round(s[2] + (tb - s[2]) * d);
  out[3] = 255;
  return out;
}

// Drawn after the sky and before the landscape, which is all the ordering
// they need: there is no depth buffer, so the order things are emitted in is
// the order they stack.
export function drawRidges(rd, camX, camZ) {
  for (const layer of LAYERS) {
    // Flying forward rolls a far range along very slightly as well, which is
    // what stops the horizon feeling nailed to the screen on a long straight.
    const slide = (camX * layer.parallax + camZ * layer.parallax * 0.18) / TILE;
    const foot = tint(layer, layer.baseY + layer.amp * 0.5, colB, true);
    const skylineY = [];

    for (let sx = 0; sx <= SCREEN_W + STEP; sx += STEP) {
      const u = (slide + (sx - CENTRE_X) * layer.span) * layer.roll;
      skylineY.push(layer.baseY - profile(u, layer.seed) * layer.amp);
    }

    for (let i = 0; i + 1 < skylineY.length; i++) {
      const x0 = i * STEP, x1 = (i + 1) * STEP;
      const y0 = skylineY[i], y1 = skylineY[i + 1];
      // Each slice is its own quad, shaded from the skyline down to the haze
      // at its foot. One quad per eight pixels, four ranges: under 240
      // triangles for the entire horizon.
      tint(layer, (y0 + y1) / 2, col, false);
      rd.quadShaded(x0, y0, col, x1, y1, col,
                    x1, SCREEN_H, foot, x0, SCREEN_H, foot);
    }
  }
}
