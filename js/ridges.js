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
// It is decoration, and priced as decoration: the height of each point of
// the far country is worked out once, the first time it comes into view, and
// kept (see heightAt).
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

// The far country, as rows of ground fixed in the world.
//
// It used to be three bands, each the highest ground in a slice of the world
// a set distance in front of the camera, asked along bearings fixed to the
// screen. Both of those move with the camera, and that was the trouble: fly
// towards a range and the slices slid over it, so a hill passed from one band
// to the next -- changing colour and silhouette -- and the bearings slid
// across the ground, so the outline shifted as well as grew. It arrived in
// the right place, but getting there did not look like approaching anything.
//
// Now the far country is rows of points on a grid fixed to the ground. Each
// row is drawn as a curtain from its line of ground down to sea level, far
// rows first, so nearer ones stand in front; the skyline is simply the
// highest of them, as before. Flying towards them changes nothing but the
// perspective. The grid is coarser with distance -- a point every two tiles
// out to sixty, every four to a hundred, every eight beyond -- and nothing
// pops where it changes: a row appearing fades in, and a point added between
// two coarser ones rises from the line joining them to its true height as it
// comes nearer. Colour runs with distance too, from nearly the sky at the
// back to the darkest silhouette at the front.
//
// The rows stop well short of the world's period of two hundred and
// fifty-six tiles, because past half of that you are looking at the ground
// behind you coming round the other way.
const FAR_TO = 170;
const RINGS = [
  // Nearest edge, grid step in tiles. Each ring's rows and points are every
  // other one of the ring in front of it, so a coarse point is always also
  // a fine one.
  { from: 100, step: 8, fade: 8 },
  { from: 60, step: 4, fade: 6 },
  { from: DRAWN_TO, step: 2, fade: 4 },
];
const BACK_FADE = 12;       // tiles over which a row fades in at the back
const FRONT_FADE = 2;       // ... and out again as the drawn tiles reach it

// A row's colour, by distance alone: at the near edge, exactly the colour
// the drawn landscape ends in, so the tiles run on into the far country
// without a seam; at the back, the sky at the horizon. Haze gathers fastest
// close to, as it does.
const HAZE_K = 55;
const HAZE_NORM = 1 - Math.exp(-(FAR_TO - DRAWN_TO) / HAZE_K);
//
// Haze alone leaves the ranges faint, so they are also taken a little towards
// a dusk-coloured dark, the silhouette they always were: none at the seam,
// coming in over the first dozen tiles, and thinning out into the distance.
const SILHOUETTE = 0.24;
function rowColour(d, out) {
  const t = (1 - Math.exp(-Math.max(0, d - DRAWN_TO) / HAZE_K)) / HAZE_NORM;
  let r = hazeFoot[0] + (hazeTop[0] - hazeFoot[0]) * t;
  let g = hazeFoot[1] + (hazeTop[1] - hazeFoot[1]) * t;
  let b = hazeFoot[2] + (hazeTop[2] - hazeFoot[2]) * t;
  const k = SILHOUETTE * Math.min(1, (d - DRAWN_TO) / 12) * (1 - t);
  const warm = sky.sunStrength;
  r += (18 + 30 * warm - r) * k;
  g += (16 + 18 * warm - g) * k;
  b += (34 + 10 * warm - b) * k;
  out[0] = Math.round(r); out[1] = Math.round(g); out[2] = Math.round(b);
  return out;
}

// The height of every even tile corner in the world, worked out the first
// time it is asked for. The world is two hundred and fifty-six tiles each
// way, so at two-tile spacing that is 128 x 128 points and every one has a
// slot of its own: nothing is ever evicted, and a hovering bird or one
// flying back over the same country samples nothing at all.
const UNKNOWN = 0x7fffffff;
const heights = new Int32Array(128 * 128).fill(UNKNOWN);
function heightAt(xt, zt) {
  const i = ((xt >> 1) & 127) | (((zt >> 1) & 127) << 7);
  let h = heights[i];
  if (h === UNKNOWN) h = heights[i] = landAltitude((xt * TILE) | 0, (zt * TILE) | 0);
  return h;
}

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
const hazeTop = [0, 0, 0, 255];
const hazeFoot = [0, 0, 0, 255];
// The near ground's skyline is kept from frame to frame, and worked out
// again only once the camera has moved far enough to shift it by half a
// pixel: it is at least NEAR_FROM tiles away, so it moves on screen by at
// most FOCAL / NEAR_FROM pixels for every tile the camera moves.
const HALF_PIXEL = 0.5;
const nearKept = { rows: [], xs: [], camX: 0, camY: 0, camZ: 0, width: -1 };
function nearStale(k, camX, camY, camZ) {
  if (k.width !== SCREEN_W) return true;
  const moved = (Math.abs((camX - k.camX) | 0) + Math.abs((camY - k.camY) | 0) +
                 Math.abs((camZ - k.camZ) | 0)) / TILE;
  return moved * FOCAL_X / NEAR_FROM > HALF_PIXEL;
}

// The plain's colour at a given row, which is also what every band's foot is
// painted with. That is why it is a function rather than a constant: a band
// whose bottom edge is a different colour from the ground it stands on has a
// hard line across the picture where its skirt ends, and three of those read
// as stripes rather than as distance. Ending each one in exactly the haze it
// stands in leaves only the skyline, which is all a far range shows.
// Everything below the horizon that is not a hill is taken to be ground at
// sea level, and a row of the screen is then a distance: the colour there is
// the colour a row of hills at that distance is drawn in (rowColour). That
// is what lets a row's foot vanish into the plain instead of standing out as
// a step wherever the ground in front of it is low.
let hazeCamY = 0, hazeReady = false;
function distanceAt(y) {
  const drop = (SEA_LEVEL - hazeCamY) / TILE;
  if (y <= CENTRE_Y || drop <= 0) return Infinity;
  return (drop * FOCAL_Y) / (y - CENTRE_Y);
}
function hazeAt(y, out) {
  rowColour(distanceAt(y), out);
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
function skylineBetween(near, far, step, camX, camY, camZ, k) {
  const rows = k.rows, xs = k.xs;
  let n = 0;
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
    rows[n] = best; xs[n] = sx;
    n++;
  }
  rows.length = n; xs.length = n;
}

// Fill from a skyline down to a flat foot, one quad per step.
function fillUnder(rd, xs, rows, footY, top, bottom) {
  const base = Math.min(footY, SCREEN_H);
  for (let i = 0; i + 1 < rows.length; i++) {
    const y0 = rows[i], y1 = rows[i + 1];
    if (y0 >= base && y1 >= base) continue;
    const x0 = xs[i], x1 = xs[i + 1];
    rd.quadShaded(x0, y0, top, x1, y1, top, x1, base, bottom, x0, base, bottom);
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
const footNow = [0, 0, 0];
let footCamX = 0, footCamZ = 0;
const FOOT_EASE = 0.03;         // a share a frame: a second or two to settle
export function drawHorizonHaze(rd, camX, camY, camZ) {
  hazeCamY = camY;
  const s = skyColourAt(CENTRE_Y);
  hazeTop[0] = s[0]; hazeTop[1] = s[1]; hazeTop[2] = s[2];
  // The ground colour under the camera, eased towards rather than taken:
  // it changes at a stroke where one biome meets the next, and taken
  // straight it changed the whole of the far country in one frame. A jump
  // of the camera (a new game, a respawn) takes it at once.
  const g = tileColour(LAND_MID_HEIGHT, LAND_MID_HEIGHT, 1, camX, camZ);
  const jumped = !hazeReady || Math.abs((camX - footCamX) | 0) + Math.abs((camZ - footCamZ) | 0) > 4 * TILE;
  const ease = jumped ? 1 : FOOT_EASE;
  for (let i = 0; i < 3; i++) {
    footNow[i] += (g[i] - footNow[i]) * ease;
    hazeFoot[i] = Math.round(footNow[i]);
  }
  footCamX = camX; footCamZ = camZ;
  hazeReady = true;

  // The plain, in bands evenly spaced in distance's reciprocal -- which is
  // evenly spaced down the screen -- from the horizon to where the drawn
  // tiles begin, then the tiles' own colour to the bottom.
  const meet = Math.min(SCREEN_H, rowAt(DRAWN_TO, camY, FLOOR));
  let y0 = CENTRE_Y;
  hazeAt(y0, bandA);
  for (let i = 1; i <= PLAIN_BANDS && y0 < meet; i++) {
    const y1 = CENTRE_Y + ((meet - CENTRE_Y) * i) / PLAIN_BANDS;
    hazeAt(y1, bandB);
    rd.gradientBand(y0, y1, bandA, bandB);
    bandA[0] = bandB[0]; bandA[1] = bandB[1]; bandA[2] = bandB[2];
    y0 = y1;
  }
  if (meet < SCREEN_H) rd.gradientBand(Math.max(CENTRE_Y, meet), SCREEN_H, hazeFoot, hazeFoot);
}
const PLAIN_BANDS = 12;
const bandA = [0, 0, 0, 255], bandB = [0, 0, 0, 255];

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
const rowX = new Float64Array(160), rowY = new Float64Array(160);
export function drawRidges(rd, camX, camY, camZ) {
  // Where the camera is, in tiles, for choosing which grid points are in
  // view. Signed: the world wraps, and the arithmetic below wraps with it.
  const cx = camX / TILE, cz = camZ / TILE;
  const halfW = (CENTRE_X + 2) / FOCAL_X;          // half the view, per tile out
  // Rows, far to near: every multiple of the step of the ring it is in.
  for (let z = Math.ceil((cz + FAR_TO) / 2) * 2; ; z -= 2) {
    const vz = (z * TILE - camZ) >>> 0;              // unsigned: past half the world
    const d = vz / TILE;
    if (d < DRAWN_TO) break;
    if (d > FAR_TO) continue;
    let ring = 0;
    while (ring < RINGS.length - 1 && d < RINGS[ring].from) ring++;
    const step = RINGS[ring].step;
    if (z % step !== 0) continue;
    // Fading in: at the back of the world, and where a ring starts showing
    // rows the one behind it did not have. Fading out where the drawn tiles
    // take over.
    let alpha = Math.min(1, (FAR_TO - d) / BACK_FADE, (d - DRAWN_TO) / FRONT_FADE);
    if (ring > 0 && (z % RINGS[ring - 1].step) !== 0) {
      alpha = Math.min(alpha, (RINGS[ring - 1].from - d) / RINGS[ring].fade);
    }
    if (alpha <= 0.01) continue;

    const footY = CENTRE_Y + ((SEA_LEVEL - camY) * FOCAL_Y) / vz;
    if (footY <= 0) continue;
    // A point that is not on the coarser grid behind rises from the line
    // between its neighbours to its own height as the row comes in.
    const coarse = ring > 0 ? RINGS[ring - 1].step : 0;
    const morph = ring > 0 ? Math.min(1, (RINGS[ring - 1].from - d) / RINGS[ring].fade) : 1;
    const x0 = Math.floor((cx - halfW * d) / step) * step - step;
    const x1 = Math.ceil((cx + halfW * d) / step) * step + step;
    let n = 0, top = Infinity;
    for (let xt = x0; xt <= x1; xt += step) {
      let h = heightAt(xt, z);
      if (coarse && morph < 1 && (xt % coarse) !== 0) {
        const line = (heightAt(xt - step, z) + heightAt(xt + step, z)) / 2;
        h = line + (h - line) * morph;
      }
      const vx = (xt * TILE - camX) | 0;
      rowX[n] = CENTRE_X + (vx * FOCAL_X) / vz;
      const y = CENTRE_Y + ((h - camY) * FOCAL_Y) / vz;
      rowY[n] = y;
      if (y < top) top = y;
      n++;
    }
    if (top >= SCREEN_H || top >= footY) continue;

    // One colour a row, and it depends on nothing but how far away the row
    // is (rowColour). Rows next to each other come out nearly the same, so
    // open country is a smooth wash, and a ridge stands out by exactly as
    // much as the ground it hides is further away -- which is what distance
    // looks like.
    const base = Math.min(footY, SCREEN_H);
    rowColour(d, col);
    col[3] = Math.round(255 * Math.min(1, alpha));
    for (let i = 0; i + 1 < n; i++) {
      const y0 = rowY[i], y1 = rowY[i + 1];
      if (y0 >= base && y1 >= base) continue;
      const xa = rowX[i], xb = rowX[i + 1];
      rd.quad(xa, y0, xb, y1, xb, base, xa, base, col);
    }
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
  if (nearStale(nearKept, camX, camY, camZ)) {
    skylineBetween(NEAR_FROM, NEAR_TO, NEAR_STEP, camX, camY, camZ, nearKept);
    nearKept.camX = camX; nearKept.camY = camY; nearKept.camZ = camZ;
    nearKept.width = SCREEN_W;
  }
  const rows = nearKept.rows;
  let top = Infinity;
  for (const y of rows) if (y < top) top = y;
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
  fillUnder(rd, nearKept.xs, rows, SCREEN_H, col, col);
}
