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
// What it does have to be is a range at a distance, rather than a picture at a
// screen position. The first version was the latter: every layer was pinned to
// fixed rows whatever the craft was doing, and the skirts ran to the bottom of
// the frame. Down among the trees that passes -- the drawn landscape covers
// the skirts and nothing moves much anyway. Ten tiles up it falls apart. The
// drawn band only reaches twenty-six tiles out, so from up there it is off the
// bottom of the screen entirely, and what was left was a stack of ridges
// nailed to the middle of the frame with a flat wall of haze under it, not
// moving as the craft climbed past them.
//
// So each layer now has a distance in tiles, and everything else falls out of
// it: how fast it slides past (FOCAL/z pixels per tile of travel), how tall it
// stands, and -- the part that was missing -- where its skyline and its foot
// land, which depend on where the eye is. Climb and the ranges sink and open
// out the way real ones do, the near ones faster than the far ones, because
// that is what the same equation says.
//
// Colour comes from the sky the layer is standing against rather than from a
// palette of its own, so the whole stack moves through sunrise, noon, dusk and
// night without anything here knowing what time it is.

import { TILE } from './maths.js';
import { sky, skyColourAt } from './daylight.js';
import { tileColour, LAND_MID_HEIGHT, LANDSCAPE_Z } from './landscape.js';
import { SCREEN_W, SCREEN_H, CENTRE_X, CENTRE_Y, FOCAL_X, FOCAL_Y } from './renderer.js';

// The ground the ranges stand on, in tiles of world y. Mean ground level: the
// ranges are meant to be the same country carrying on past the drawn part of
// it, so they stand on the same floor it does.
const PLAIN = LAND_MID_HEIGHT / TILE;

// Each layer: how far off it is in tiles, how high its peaks stand above the
// plain, how long a mountain is along the range, and how dark it reads.
//
// The distances are what makes the stack a stack. They used to be a parallax
// figure and a span figure that between them cancelled out -- worked through,
// the four layers slid past at 8.2, 10.0, 11.0 and 11.6 pixels per tile
// flown, which is no separation at all: four backdrops moving as one. Set as
// distances they come out at 3.7, 5.4, 7.9 and 11.4, which is the spread the
// eye is actually looking for.
//
// Far ranges are built out of bigger mountains, which is the other half of
// reading as distant: a range seventeen miles off is not a fine-toothed
// version of the one in front of it, it is a larger thing seen smaller.
const LAYERS = [
  { dist: 140, height: 8.2, wave: 46, seed: 1.7, dark: 0.16 },
  { dist:  95, height: 5.6, wave: 30, seed: 4.1, dark: 0.30 },
  { dist:  65, height: 3.8, wave: 18, seed: 8.3, dark: 0.46 },
  { dist:  45, height: 2.6, wave: 11, seed: 2.9, dark: 0.62 },
];

// How wide a step across the screen. Six pixels: coarse enough to be cheap,
// fine enough that a ridge line reads as a ridge and not as a saw. It was
// eight, which was fine for dunes and too coarse for the crags below.
const STEP = 6;

// The profile of a range at a point along it, in units of its own wavelength.
//
// Adding sines and sharpening the result gives dunes, not mountains, and no
// amount of tuning the exponent fixes it: a sum of sines is smooth at its
// peaks by construction, and a smooth peak is a hill.
//
// What a range actually looks like is the opposite -- a sharp top and long
// flanks running down to a col -- so the sum is folded instead. Take the
// absolute value away from one and every zero crossing of the sum becomes a
// summit with a crease in it, and the places the sum runs furthest from zero
// become the valleys between them. The crossings are irregularly spaced
// because the sines are of unrelated period, so the peaks are too.
//
// Folding on its own makes every summit exactly the same height, which is its
// own kind of wrong, so a slow envelope rides over the top of it: some parts
// of the range stand high and some are barely more than foothills. The last
// term is the crag, small and quick, which stops the flanks being straight.
function profile(u, seed) {
  const s = 0.52 * Math.sin(u + seed)
          + 0.30 * Math.sin(u * 2.37 + seed * 1.7)
          + 0.18 * Math.sin(u * 0.41 + seed * 0.6);
  const ridge = 1 - Math.abs(s);
  const env = 0.42 + 0.58 * (0.5 + 0.5 * Math.sin(u * 0.23 + seed * 2.1));
  const crag = 0.06 * Math.sin(u * 5.13 + seed * 2.3);
  const h = env * Math.pow(ridge < 0 ? 0 : ridge, 0.85) + crag;
  return h < 0 ? 0 : h > 1 ? 1 : h;
}

const col = [0, 0, 0, 255];
const colB = [0, 0, 0, 255];
const hazeTop = [0, 0, 0, 255];
const hazeFoot = [0, 0, 0, 255];

// The plain's colour at a given row, which is also what every range's foot is
// painted with. That is the whole reason it is a function rather than a
// constant: a range whose bottom edge is a different colour from the ground
// it is standing on has a hard line across the picture where its skirt ends,
// and four of those read as stripes rather than as distance. Ending each one
// in exactly the haze it is standing in makes the skirt disappear and leaves
// only the skyline, which is all a far range actually shows.
let hazeY0 = 0, hazeY1 = 1;
function hazeAt(y, out) {
  let t = (y - hazeY0) / (hazeY1 - hazeY0);
  if (t < 0) t = 0; else if (t > 1) t = 1;
  out[0] = Math.round(hazeTop[0] + (hazeFoot[0] - hazeTop[0]) * t);
  out[1] = Math.round(hazeTop[1] + (hazeFoot[1] - hazeTop[1]) * t);
  out[2] = Math.round(hazeTop[2] + (hazeFoot[2] - hazeTop[2]) * t);
  out[3] = 255;
  return out;
}

// A range's colour: the sky behind it, taken towards the dusk-coloured dark
// so it reads as a silhouette rather than as paint.
function tint(layer, y, out) {
  const s = skyColourAt(y);
  const d = layer.dark;
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

const skylineY = [];

// Drawn after the sky and before the landscape, which is all the ordering
// they need: there is no depth buffer, so the order things are emitted in is
// the order they stack.
export function drawRidges(rd, camX, camY, camZ) {
  const eye = camY / TILE;            // tiles, negative is up
  const ex = camX / TILE, ez = camZ / TILE;

  // Where the plain itself lands on the screen at a given distance. The
  // vanishing point is CENTRE_Y and everything below the eye falls away from
  // it at FOCAL/z per tile -- the same projection the rest of the world uses,
  // written out here because a range has no vertices to put through it.
  const rowAt = (height, z) => CENTRE_Y + ((PLAIN - height - eye) * FOCAL_Y) / z;

  // The country between the drawn landscape and the far ranges.
  //
  // Nothing models it, and from any height at all it is most of the picture:
  // the drawn band stops at twenty-six tiles, so at the ceiling everything
  // below the ranges is ground that does not exist. It used to be covered by
  // running every range's skirt to the bottom of the frame, which is why the
  // lower half of a high frame was a flat wall in the nearest range's colour.
  //
  // Instead it gets what it actually is: a plain going away from you. Sky at
  // the top, because ground far enough off is the colour of the sky it is
  // standing under, and at the bottom the exact colour the drawn landscape
  // uses for its own far edge -- so when the real ground does come up into
  // frame it arrives out of the haze rather than against a seam.
  const far = rowAt(0, LAYERS[0].dist);
  if (far < SCREEN_H) {
    const s = skyColourAt(far);
    hazeTop[0] = s[0]; hazeTop[1] = s[1]; hazeTop[2] = s[2];
    const g = tileColour(LAND_MID_HEIGHT, LAND_MID_HEIGHT, 1, camX, camZ);
    hazeFoot[0] = g[0]; hazeFoot[1] = g[1]; hazeFoot[2] = g[2];
    // The gradient arrives at the ground colour exactly where the drawn
    // landscape's far edge does, rather than at the bottom of the frame: land
    // at mean height, at the distance the scan reaches. Get that wrong and
    // the two meet part way through the fade, which is a line across the
    // picture. Below it the colour simply holds, for the frames where the
    // craft is high enough that no real ground is in shot at all.
    const meet = Math.min(SCREEN_H, rowAt(0, LANDSCAPE_Z / TILE));
    hazeY0 = far; hazeY1 = Math.max(far + 1, meet);
    if (meet > far) rd.gradientBand(far, meet, hazeTop, hazeFoot);
    if (meet < SCREEN_H) rd.gradientBand(Math.max(far, meet), SCREEN_H, hazeFoot, hazeFoot);
  }

  for (const layer of LAYERS) {
    const z = layer.dist;
    const footY = rowAt(0, z);
    const topY = rowAt(layer.height, z);
    // Flown over and out of frame: there is nothing left of it to draw.
    if (topY >= SCREEN_H) continue;

    // How much world one screen pixel covers at this distance, and how far
    // the range has slid. Flying forward rolls a far range along very
    // slightly as well, which is what stops the horizon feeling nailed to the
    // screen on a long straight.
    const perPx = z / FOCAL_X;
    const along = (ex + ez * 0.18) / layer.wave;
    const step = (STEP * perPx) / layer.wave;
    const u0 = (along + ((0 - CENTRE_X) * perPx) / layer.wave) * Math.PI * 2;
    const du = step * Math.PI * 2;

    const foot = hazeAt(footY, colB);
    skylineY.length = 0;
    for (let i = 0, sx = 0; sx <= SCREEN_W + STEP; sx += STEP, i++) {
      skylineY.push(footY - profile(u0 + du * i, layer.seed) * (footY - topY));
    }

    const base = Math.min(footY, SCREEN_H);
    for (let i = 0; i + 1 < skylineY.length; i++) {
      const x0 = i * STEP, x1 = (i + 1) * STEP;
      const y0 = skylineY[i], y1 = skylineY[i + 1];
      if (y0 >= base && y1 >= base) continue;
      // Each slice is its own quad, shaded from the skyline down to the haze
      // at its foot.
      tint(layer, (y0 + y1) / 2, col);
      rd.quadShaded(x0, y0, col, x1, y1, col,
                    x1, base, foot, x0, base, foot);
    }
  }
}
