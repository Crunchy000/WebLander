// ridges.js -- the horizon, and the ground too close to be drawn.
//
// The drawn landscape is a band: sixteen rows of tiles running from ten tiles
// in front of the camera out to twenty-six. Everything else is missing, and
// the two missing pieces sit at opposite ends of the picture. Beyond
// twenty-six tiles is the whole rest of the world, which is what a horizon is
// made of. Nearer than ten is the ground going past under you, which is what
// hides it.
//
// Both are cheap here for a reason that is usually a limitation. The camera
// never rotates, so screen x and world x are the same direction -- which
// means neither piece is geometry. Each is a one-dimensional skyline, one row
// per column of the screen, and a column of the screen is a bearing.
//
// It used to be invented: four layers of summed sines at made-up distances,
// pinned to fixed rows, and it looked like what it was -- a painted backdrop
// with nothing to do with the country underneath it, sliding along at nearly
// one rate whatever the craft did. What is drawn now is the actual terrain:
// the same height function the landscape rows are built from, asked the one
// question a horizon answers. Along this bearing, what is the highest thing
// out there?
//
// That is the true horizon rather than an impression of one. Fly towards a
// range and it grows. Fly along it and the peaks slide past each other at
// exactly the rate their distances say. Climb, and it sinks and opens out.
// None of that needed writing: it falls out of asking the real ground.
//
// The cost is a height sample per column per band. Measured: 0.032ms for six
// hundred and forty-four samples, against the 0.027ms the landscape already
// spends on its own five hundred and ten. It is not the expensive part of
// anything.
//
// Colour comes from the sky the band stands against rather than from a
// palette of its own, so the whole stack moves through sunrise, noon, dusk
// and night without anything here knowing what time it is.

import { TILE } from './maths.js';
import { sky, skyColourAt } from './daylight.js';
import {
  landAltitude, tileColour, LAND_MID_HEIGHT, LANDSCAPE_Z, LANDSCAPE_Z_DEPTH, TILES_Z,
  SEA_LEVEL,
} from './landscape.js';
import { SCREEN_W, SCREEN_H, CENTRE_X, CENTRE_Y, FOCAL_X, FOCAL_Y } from './renderer.js';

// The far edge of the drawn landscape, in tiles: where the horizon's job
// starts. Everything nearer than this is already on the screen as tiles.
const DRAWN_TO = LANDSCAPE_Z / TILE;

// The lowest the ground ever gets, in tiles of world y: sea level. This is
// what a band's foot is set from -- the row where the nearer edge of its
// slice would be if the ground there were as low as ground can be.
//
// Mean height is the tempting figure and it is wrong, because a foot is not a
// description, it is a guarantee. A band fills from its skyline down to its
// foot and no further, so if the next band along has nothing in it that
// reaches as high as that foot, the two do not overlap and there is a strip
// of bare plain between them. Which was invisible while the plain was drawn
// in front of the sun, and became a strip of sky with the sun sitting in it
// the moment the sun moved forward: measured, a moon at row 103 with the
// true skyline at 82, showing through a gap two bands wide.
//
// Taken at sea level the guarantee holds by construction: a band's foot is
// at or below every possible ground row at that distance, and the next
// band's skyline includes that distance, so it can never start lower.
const FLOOR = SEA_LEVEL / TILE;

// Mean ground level, in tiles of world y. Used for the rows that stand in for
// ground rather than being sampled from it: where the haze meets the drawn
// landscape.
const PLAIN = LAND_MID_HEIGHT / TILE;

// The horizon in bands, near edge to far edge in tiles.
//
// One band would draw the true skyline and it would be a single line with
// nothing behind it. Real distance reads as ranges standing behind ranges, so
// the same question is asked of three slices of the world at once. Each is
// the highest ground in its own slice, so a nearer band genuinely stands in
// front of a farther one -- the overlap is real, not layered by hand -- and
// each is hazed by how far away it is.
//
// The far band stops well short of the world's period of two hundred and
// fifty-six tiles, because past half of that you are looking at the ground
// behind you coming round the other way.
// The step along each bearing is finer for the near band and coarser for the
// far one, because a step is a chance to walk over the top of a peak and a
// peak missed near to hand costs more rows than one missed far off.
//
// Measured against a quarter-tile reference sweep over forty places and the
// width of the screen, worst case and mean, in rows of error:
//
//   34-60 tiles   step 2.5 -> 4.8 / 1.01      step 1   -> 0.2 / 0.01
//   60-100        step 5   -> 3.2 / 0.24      step 2.5 -> 0.8 / 0.07
//   100-170       step 8   -> 8.0 / 1.05      step 5   -> 1.7 / 0.17
//
// None of that was the sun's problem -- that was the feet, below -- and at a
// row or two of mean error the old steps were not visibly wrong either. They
// are finer because a skyline that is within a fifth of a row of the truth
// costs 0.05ms and removes a whole class of "why does that not line up".
const BANDS = [
  { near: 100, far: 170, step: 5, dark: 0.14 },
  { near: 60, far: 100, step: 2.5, dark: 0.26 },
  { near: DRAWN_TO, far: 60, step: 1, dark: 0.40 },
];

// The ground too close to have been drawn: from just in front of the camera
// out to the near edge of the landscape band.
//
// It is nearly always below the bottom of the frame -- ground five tiles
// under the eye at ten tiles out lands on row 320 of a 256-row screen -- and
// it needs nothing doing then. It is the times it is not that matter: fly low
// over the highest ground and the landscape's near edge climbs into frame,
// and under it there is nothing at all, so you see the far distance through a
// hill that should be filling the windscreen. What goes there is a
// silhouette, which is what ground that close to the eye reads as anyway.
// Ten tiles: the landscape's own near edge, which is its far edge less its
// depth. Running this window out to the far edge instead covers the drawn
// tiles with silhouette, which is not a subtle mistake -- it puts a black
// mass across the bottom half of every frame.
const NEAR_TO = (LANDSCAPE_Z - LANDSCAPE_Z_DEPTH) / TILE;
const NEAR_FROM = 1.5;
const NEAR_STEP = 0.5;
// The row it joins on to: the landscape's nearest, which is the last one.
const NEAR_ROW = TILES_Z - 1;

// How wide a step across the screen. Six pixels: coarse enough to be cheap,
// fine enough that a ridge line reads as a ridge and not as a saw.
const STEP = 6;

const col = [0, 0, 0, 255];
const colB = [0, 0, 0, 255];
const hazeTop = [0, 0, 0, 255];
const hazeFoot = [0, 0, 0, 255];
const skyline = [];

// A band's colour: the sky behind it, taken towards the dusk-coloured dark so
// it reads as a silhouette rather than as paint.
function tint(dark, y, out) {
  const s = skyColourAt(y);
  // Silhouettes go towards a cool dark at night and a warm one by day, which
  // is what keeps a dusk frame from turning grey.
  const warm = sky.sunStrength;
  const tr = 18 + 30 * warm, tg = 16 + 18 * warm, tb = 34 + 10 * warm;
  out[0] = Math.round(s[0] + (tr - s[0]) * dark);
  out[1] = Math.round(s[1] + (tg - s[1]) * dark);
  out[2] = Math.round(s[2] + (tb - s[2]) * dark);
  out[3] = 255;
  return out;
}

// The plain's colour at a given row, which is also what every band's foot is
// painted with. That is why it is a function rather than a constant: a band
// whose bottom edge is a different colour from the ground it stands on has a
// hard line across the picture where its skirt ends, and three of those read
// as stripes rather than as distance. Ending each one in exactly the haze it
// stands in leaves only the skyline, which is all a far range shows.
let hazeY0 = 0, hazeY1 = 1, hazeReady = false;
function hazeAt(y, out) {
  let t = (y - hazeY0) / (hazeY1 - hazeY0);
  if (t < 0) t = 0; else if (t > 1) t = 1;
  out[0] = Math.round(hazeTop[0] + (hazeFoot[0] - hazeTop[0]) * t);
  out[1] = Math.round(hazeTop[1] + (hazeFoot[1] - hazeTop[1]) * t);
  out[2] = Math.round(hazeTop[2] + (hazeFoot[2] - hazeTop[2]) * t);
  out[3] = 255;
  return out;
}

// Along every bearing across the screen, the highest thing between two
// distances -- as a screen row, because that is the same comparison.
//
// "Highest" has to be an angle rather than a height: a hill of two tiles at
// thirty tiles out stands higher in the frame than one of three at a hundred,
// and what stands higher in the frame is what you see. A screen row is that
// angle with the work already done, so the smallest row wins.
//
// The lateral offset per column goes through `| 0` on the way into the world,
// which is not a truncation but the wrap: the world is a torus whose period
// is exactly the range of a signed 32-bit integer, so arithmetic that
// overflows has already gone round it.
function skylineBetween(near, far, step, camX, camY, camZ, out) {
  out.length = 0;
  for (let sx = 0; sx <= SCREEN_W + STEP; sx += STEP) {
    const bearing = (sx - CENTRE_X) / FOCAL_X;
    let best = Infinity;
    for (let z = near; z <= far; z += step) {
      const zFix = z * TILE;
      const wx = (camX + bearing * zFix) | 0;
      const wz = (camZ + zFix) | 0;
      const row = CENTRE_Y + ((landAltitude(wx, wz) - camY) * FOCAL_Y) / zFix;
      if (row < best) best = row;
    }
    out.push(best);
  }
  return out;
}

// Fill from a skyline down to a flat foot, one quad per step.
function fillUnder(rd, rows, footY, top, bottom) {
  const base = Math.min(footY, SCREEN_H);
  for (let i = 0; i + 1 < rows.length; i++) {
    const y0 = rows[i], y1 = rows[i + 1];
    if (y0 >= base && y1 >= base) continue;
    rd.quadShaded(i * STEP, y0, top, (i + 1) * STEP, y1, top,
                  (i + 1) * STEP, base, bottom, i * STEP, base, bottom);
  }
}

// Drawn after the sky and before the landscape, which is all the ordering
// they need: there is no depth buffer, so the order things are emitted in is
// the order they stack.
// Where flat ground at mean height lands, at a given distance. The vanishing
// point is CENTRE_Y and everything below the eye falls away from it at
// FOCAL/z per tile -- the same projection the tiles go through.
function rowAt(z, camY, height = PLAIN) {
  return CENTRE_Y + ((height - camY / TILE) * FOCAL_Y) / z;
}

// The far country, in two passes with the sky's own furniture between them.
//
// The plain goes down first, then the sun and the moon are drawn onto it,
// then the terrain bands go over the top. That order is the whole of it: a
// body is hidden by hills, which are things, and not by haze, which is only
// the colour of distance. Drawn in one pass, with the plain in front of the
// sun, a setting sun vanished at the vanishing point -- forty rows above the
// skyline, in the middle of an apparently empty sky, with nothing there to
// explain it.
//
// This pass is the country between the drawn landscape and the horizon. From
// any height at all it is most of the picture: the tiles stop at thirty-four
// tiles out, so from the ceiling everything below the skyline is ground that
// is not there. Filling it with the bands' own skirts is what once made the
// lower half of a high frame a flat wall.
//
// What it is, is a plain going away from you. Sky at the top, because ground
// far enough off is the colour of the sky it stands under, and at the bottom
// the exact colour the landscape uses for its own far edge -- arrived at on
// the row where that edge lands, so the real ground comes up out of the haze
// rather than against a seam.
//
// It starts at the vanishing point, because that is where the ground's own
// horizon is: the camera looks level, so CENTRE_Y is eye level, and every
// scrap of ground in this world is below the eye and therefore below that
// line. The bands cannot reach it -- the furthest stops at a hundred and
// seventy tiles, whose flat ground lands sixteen rows lower -- so without the
// plain there is a strip of bare sky under the true horizon.
export function drawHorizonHaze(rd, camX, camY, camZ) {
  const meet = Math.min(SCREEN_H, rowAt(DRAWN_TO, camY));
  hazeY0 = CENTRE_Y; hazeY1 = Math.max(CENTRE_Y + 1, meet);
  {
    const s = skyColourAt(CENTRE_Y);
    hazeTop[0] = s[0]; hazeTop[1] = s[1]; hazeTop[2] = s[2];
    const g = tileColour(LAND_MID_HEIGHT, LAND_MID_HEIGHT, 1, camX, camZ);
    hazeFoot[0] = g[0]; hazeFoot[1] = g[1]; hazeFoot[2] = g[2];
    if (meet > CENTRE_Y) rd.gradientBand(CENTRE_Y, meet, hazeTop, hazeFoot);
    if (meet < SCREEN_H) rd.gradientBand(Math.max(CENTRE_Y, meet), SCREEN_H, hazeFoot, hazeFoot);
  }
  hazeReady = true;
}

// What is behind a given row, for anything drawn onto it: sky above the
// horizon, and the haze of the plain below it.
//
// The sun and the moon need this. Their coronas are opaque squares stepped
// towards the colour behind them, so "the colour behind them" has to be the
// truth or the corona reads as a pale box rather than as glow -- and below
// the horizon the truth is ground, not sky.
export function backdropAt(y, out) {
  if (y <= CENTRE_Y || !hazeReady) {
    const s = skyColourAt(y);
    out[0] = s[0]; out[1] = s[1]; out[2] = s[2];
    return out;
  }
  return hazeAt(y, out);
}

// ... and then the hills, which are what actually hides anything.
export function drawRidges(rd, camX, camY, camZ) {
  for (const band of BANDS) {
    const footY = rowAt(band.near, camY, FLOOR);
    if (footY <= 0) continue;
    skylineBetween(band.near, band.far, band.step, camX, camY, camZ, skyline);
    let top = Infinity;
    for (const y of skyline) if (y < top) top = y;
    if (top >= SCREEN_H) continue;
    fillUnder(rd, skyline, footY,
              tint(band.dark, (top + Math.min(footY, SCREEN_H)) / 2, col),
              hazeAt(footY, colB));
  }
}

// The other end: drawn after the landscape, because it is in front of it.
//
// One flat tone, and the tone is the landscape's own. It is the same ground
// as the tiles it joins -- the row that would have been drawn next if the
// band went any nearer -- so it takes that row's colour and stands a little
// darker, the way ground closer to the eye does anyway. A silhouette in the
// sense of having no detail in it, rather than in the sense of being black:
// a black bar across the bottom of the frame is not what a hill in front of
// you looks like, it is what a bug looks like.
const DARKEN = 0.88;
export function drawNearGround(rd, camX, camY, camZ) {
  skylineBetween(NEAR_FROM, NEAR_TO, NEAR_STEP, camX, camY, camZ, skyline);
  let top = Infinity;
  for (const y of skyline) if (y < top) top = y;
  if (top >= SCREEN_H) return;          // all of it below the frame: nothing to do

  // Sampled where the two meet -- at the landscape's own near edge, not under
  // the camera -- so the tone is the tone of the surface it continues.
  const zJoin = (camZ + (LANDSCAPE_Z - LANDSCAPE_Z_DEPTH)) | 0;
  const here = landAltitude(camX, zJoin);
  const g = tileColour(here, here, NEAR_ROW, camX, zJoin);
  col[0] = Math.round(g[0] * DARKEN);
  col[1] = Math.round(g[1] * DARKEN);
  col[2] = Math.round(g[2] * DARKEN);
  col[3] = 255;
  fillUnder(rd, skyline, SCREEN_H, col, col);
}
