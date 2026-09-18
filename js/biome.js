// biome.js -- where in the world you are, climatically.
//
// Like the landscape and the object map, the biome at a point is a pure
// function of world coordinates: nothing is stored, the map is endless, and
// flying back to a desert you crossed ten minutes ago finds the same desert.
//
// Everything reduces to one number. `climate` runs from -1 (frozen) through
// 0 (temperate) to +1 (baking), and the ground palette, what grows, and how
// much of it grows are all read off that. Keeping it to a single axis means
// the transitions can only ever be tundra-temperate or temperate-desert, so
// ice never abuts sand -- which is both what the world does and one less
// border to make look right.

import { TILE } from './maths.js';

export const TUNDRA = 0, TEMPERATE = 1, DESERT = 2;

// Two sine fields, each warped by a slower one at right angles to it. The
// warp is what stops the regions coming out as an obvious checkerboard: it
// bends the bands into lobes and inlets without costing anything beyond two
// more sines.
//
// The frequencies put a region at roughly sixty to a hundred tiles across --
// a minute or so of flying, so a biome is somewhere you arrive in rather
// than something that flickers past.
export function climate(wx, wz) {
  const x = wx / TILE, z = wz / TILE;
  const a = Math.sin(x * 0.0271 + Math.sin(z * 0.0102) * 2.1);
  const b = Math.sin(z * 0.0207 + Math.sin(x * 0.0079) * 1.7);
  return (a + b) * 0.5;
}

// Each biome wants a broad plateau, the temperate middle included, or the
// world is nothing but gradient. Scaling and clipping gives plateaus at the
// two ends only, and squeezed the home biome down to a sixth of the map; a
// terrace with a flat step in the middle as well as at the ends keeps all
// three. Inside FLAT the climate reads as pure temperate, beyond EDGE as
// pure tundra or desert, and the band between is the transition.
const FLAT = 0.30;
const EDGE = 0.55;

// The climate as a position along the palette ramp: 0 is pure tundra, 1 pure
// temperate, 2 pure desert, and anything between is a blend of its two
// neighbours.
export function climateRamp(wx, wz) {
  const t = climate(wx, wz);
  const a = t < 0 ? -t : t;
  const s = a <= FLAT ? 0 : a >= EDGE ? 1 : (a - FLAT) / (EDGE - FLAT);
  return 1 + (t < 0 ? -s : s);
}

// --- ground palettes -------------------------------------------------------
//
// These are 4-bit values fed to the VIDC packing, before the row brightness
// is added -- the same pipeline the temperate ground always used, so the
// quantisation still does its dithering on real colours.
//
// Each biome varies two of its channels with bits 2 and 3 of the altitude.
// Those bits tumble almost at random from one corner to the next, which is
// what mottles the ground; the biome decides what it is mottled with.

// All three share one shape, and it is temperate's: two channels held low,
// one leading, each varying by four so the swing lands on bits the VIDC
// packing actually reads. Bases have to stay low or the row brightness clips
// them to white before they reach the camera -- that is what killed the first
// two attempts, which were written at the value the biome wanted to look and
// went flat in the near field. The value comes from the brightness, the hue
// from which channel leads, and the rest from the tint below.

function temperate(alt, out) {
  out[0] = alt & 4;                      // patches of red-brown dirt
  out[1] = ((alt & 8) >> 1) + 4;         // green leads
  out[2] = 0;
}

function desert(alt, out) {
  out[0] = ((alt & 8) >> 1) + 4;         // red leads: sand and rust
  out[1] = alt & 4;
  out[2] = 0;
}

function tundra(alt, out) {
  // Red and green move together here, unlike the other two. Letting green run
  // ahead of red -- which is what an early attempt did -- turns lit snow cyan
  // rather than white.
  const v = alt & 4;
  out[0] = v;
  out[1] = v;
  out[2] = ((alt & 8) >> 1) + 4;         // blue leads
}

const GROUND = [tundra, temperate, desert];

// Open water. Temperate and desert seas are the deep blue the original had;
// a tundra sea is pack ice, pale and barely darker than the land it meets.
const WATER = [
  [3, 6, 8],
  [0, 0, 4],
  [0, 1, 5],
];

const lo = [0, 0, 0], hi = [0, 0, 0];

// The ground colour here, as 4-bit r/g/b, blended between whichever two
// biomes this point falls between.
export function groundBase(wx, wz, alt, isWater, out) {
  const p = climateRamp(wx, wz);
  const i = p < 1 ? 0 : 1;
  const t = p - i;

  if (isWater) {
    const a = WATER[i], b = WATER[i + 1];
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  }

  GROUND[i](alt, lo);
  GROUND[i + 1](alt, hi);
  out[0] = lo[0] + (hi[0] - lo[0]) * t;
  out[1] = lo[1] + (hi[1] - lo[1]) * t;
  out[2] = lo[2] + (hi[2] - lo[2]) * t;
  return out;
}

// --- ground tint -----------------------------------------------------------
//
// The base palette above is not enough on its own. The row brightness is
// added to all three channels and clips at 15, so by the time the ground is
// near the camera every biome has converged on the same white -- the hue dies
// exactly where you spend most of your time looking.
//
// So the biome also tints the ground after the palette, the way the time of
// day does. That survives the clipping: a saturated white tile still comes
// out as sand or as snow, and temperate stays untinted so the original look
// is untouched.
const TINT = [
  [0.90, 0.95, 1.12],   // tundra: cold, and no darker -- snow is bright
  [1.00, 1.00, 1.00],   // temperate: exactly as it was
  [1.06, 0.95, 0.74],   // desert: warmer, and the blue pulled out of it
];

// Quantised so the colour caches downstream stay small: the tint only ever
// takes one of seventeen values, whatever the climate does.
export const TINT_STEPS = 8;

export function tintFor(level, out) {
  const p = level / TINT_STEPS;
  const i = p < 1 ? 0 : 1;
  const t = p - i;
  const a = TINT[i], b = TINT[i + 1];
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export function tintLevel(wx, wz) {
  return Math.round(climateRamp(wx, wz) * TINT_STEPS);
}

// --- what grows here -------------------------------------------------------

// Which biome's flora a tile gets. On a border the choice is stippled by the
// tile's own hash against the blend, so cacti thin out into scrub over
// several tiles instead of stopping dead along a line -- the same trick the
// palette quantisation plays, applied to vegetation.
export function floraBiome(wx, wz, h) {
  const p = climateRamp(wx, wz);
  const f = ((h >>> 13) & 0xffff) / 65536;
  if (p < 1) return f < 1 - p ? TUNDRA : TEMPERATE;
  return f < p - 1 ? DESERT : TEMPERATE;
}

// How crowded each biome is, as a percentage of tiles carrying something.
// Desert is the emptiest; that emptiness is most of what makes it read as
// desert rather than as temperate ground that happens to be beige.
//
// These were set when the world was a shooting gallery and every tree was a
// target: more of them was more to do. Nothing is a target now and the ground
// has gone quiet, so the crowd reads as clutter rather than as scenery -- and
// with the foreground going to silhouette, a crowd of it fills the bottom of
// the frame with black.
//
// Eased back rather than cut, though, because what was too thick was the
// rock and the toy blocks rather than the trees: a stand of firs is a wood,
// and a wood is worth flying over. The mix is weighted separately in
// objects.js, and that is what does most of the thinning.
export const DENSITY = [12, 17, 7];
