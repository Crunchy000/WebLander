// daylight.js -- the time of day, and everything that follows from it.
//
// One phase value, 0 to 1, drives the whole look of the game: the sky
// gradient, the haze colour, a per-channel tint applied to every solid thing
// drawn, where the sun and moon sit, how bright the stars are and whether
// vehicles have their lights on.
//
// Nothing here knows about the landscape or the models, so this module sits
// at the bottom of the import graph and everything else can lean on it.

import { SCREEN_W } from './renderer.js';

// A whole day in milliseconds. Three minutes is short enough that you see
// the light change within one life, and long enough that it does not strobe.
export const DAY_LENGTH = 180000;

// Phase 0 is midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset.
//
// Each stop gives the three sky gradient colours and a tint -- a per-channel
// multiplier laid over every solid surface in the game. The tint is what
// actually makes night feel like night: scaling all three channels down
// darkens, and pulling red and green down further than blue shifts the whole
// world towards moonlight without needing a second palette.
const STOPS = [
  { at: 0.00, top: [  2,   4,  12], mid: [  6,   9,  24], hor: [ 16,  20,  44], tint: [0.34, 0.38, 0.56], star: 1.00, lamp: 1.00, sun: 0.22 },
  { at: 0.17, top: [  4,   6,  18], mid: [ 12,  14,  36], hor: [ 34,  32,  62], tint: [0.36, 0.40, 0.57], star: 0.94, lamp: 1.00, sun: 0.24 },
  { at: 0.22, top: [ 14,  16,  46], mid: [ 52,  40,  72], hor: [136,  74,  76], tint: [0.54, 0.49, 0.61], star: 0.34, lamp: 0.80, sun: 0.35 },
  { at: 0.26, top: [ 26,  34,  80], mid: [122,  84,  96], hor: [240, 140,  88], tint: [0.90, 0.80, 0.74], star: 0.00, lamp: 0.34, sun: 0.65 },
  { at: 0.33, top: [ 18,  44, 108], mid: [ 70, 104, 166], hor: [178, 178, 186], tint: [0.98, 0.96, 0.92], star: 0.00, lamp: 0.00, sun: 0.92 },
  { at: 0.50, top: [ 16,  54, 132], mid: [ 62, 116, 192], hor: [168, 186, 204], tint: [1.00, 0.99, 0.95], star: 0.00, lamp: 0.00, sun: 1.00 },
  { at: 0.67, top: [ 20,  46, 110], mid: [ 76, 104, 164], hor: [186, 174, 178], tint: [1.00, 0.95, 0.90], star: 0.00, lamp: 0.00, sun: 0.92 },
  { at: 0.74, top: [ 30,  30,  84], mid: [132,  76,  92], hor: [246, 124,  66], tint: [0.94, 0.75, 0.66], star: 0.00, lamp: 0.34, sun: 0.65 },
  { at: 0.79, top: [ 16,  16,  50], mid: [ 54,  38,  74], hor: [128,  62,  74], tint: [0.56, 0.47, 0.59], star: 0.40, lamp: 0.80, sun: 0.35 },
  { at: 0.86, top: [  4,   6,  18], mid: [ 12,  14,  36], hor: [ 34,  32,  62], tint: [0.36, 0.40, 0.57], star: 0.96, lamp: 1.00, sun: 0.24 },
];

// The live state. Mutated in place once per step, never reallocated, because
// it is read by very nearly every draw call in the game.
export const sky = {
  phase: 0.42,        // start mid-morning: a new player gets daylight first
  top: [0, 0, 0],
  mid: [0, 0, 0],
  horizon: [0, 0, 0],
  fog: [0, 0, 0],     // always the horizon colour -- see landscape.js
  tint: [1, 1, 1],
  star: 0,            // how visible the stars are
  lamp: 0,            // how strongly vehicle lights read
  sunStrength: 1,     // how hard shadows are cast
  sunOffX: 0,         // which way shadows lean, -1 (left) to 1 (right)
  tick: 0,            // frames since the world started, for blinking things
  epoch: -1,          // bumped when the tint changes enough to matter
};

// Where the sun and moon are on screen, or null when below the horizon.
export const sun = { x: 0, y: 0, size: 0, col: [0, 0, 0], up: false };
export const moon = { x: 0, y: 0, size: 0, up: false };

// The arc a celestial body follows across the sky. It starts and ends off
// the edges of the screen so neither body ever pops into existence.
const ARC_Y = 132;      // where the arc meets the horizon
const ARC_PEAK = 116;   // how far above that it climbs at its highest

function lerp(a, b, t) { return a + (b - a) * t; }

function lerp3(out, a, b, t) {
  out[0] = lerp(a[0], b[0], t);
  out[1] = lerp(a[1], b[1], t);
  out[2] = lerp(a[2], b[2], t);
  return out;
}

// Find the pair of stops either side of `phase` and blend between them. The
// table wraps, so the last stop runs round to the first through midnight.
function sample(phase) {
  let i = STOPS.length - 1;
  for (let k = 0; k < STOPS.length; k++) {
    if (STOPS[k].at <= phase) i = k; else break;
  }
  const a = STOPS[i];
  const b = STOPS[(i + 1) % STOPS.length];
  let span = b.at - a.at;
  if (span <= 0) span += 1;              // the wrap through midnight
  const t = (phase - a.at) / span;
  return [a, b, Math.max(0, Math.min(1, t))];
}

export function setPhase(phase) {
  sky.phase = phase - Math.floor(phase);

  const [a, b, t] = sample(sky.phase);
  lerp3(sky.top, a.top, b.top, t);
  lerp3(sky.mid, a.mid, b.mid, t);
  lerp3(sky.horizon, a.hor, b.hor, t);
  // The haze is the horizon colour, which is what makes distant ground
  // dissolve into the sky rather than stopping at a line. That has to hold
  // at every hour, so it is copied rather than tabulated separately.
  sky.fog[0] = sky.horizon[0];
  sky.fog[1] = sky.horizon[1];
  sky.fog[2] = sky.horizon[2];
  lerp3(sky.tint, a.tint, b.tint, t);
  sky.star = lerp(a.star, b.star, t);
  sky.lamp = lerp(a.lamp, b.lamp, t);

  placeBodies(sky.phase);

  // Shadows are cast by whichever body is up, so they soften right down
  // overnight instead of vanishing -- a moonlit blob still tells you where
  // the ground is.
  sky.sunStrength = sun.up ? lerp(a.sun, b.sun, t) : 0.26;
  const lit = sun.up ? sun : moon;
  sky.sunOffX = lit.up ? -(lit.x - SCREEN_W / 2) / (SCREEN_W / 2) : 0;

  // Quantise the tint so the colour caches are not thrown away every frame.
  const e = Math.round(sky.phase * 512);
  if (e !== sky.epoch) {
    sky.epoch = e;
    litCache.clear();
  }
}

// Advance the clock. `ms` is wall-clock milliseconds since the last step.
export function advanceDay(ms) {
  sky.tick++;
  setPhase(sky.phase + ms / DAY_LENGTH);
}

// Is a beacon lit this frame? Everything that blinks shares one clock and
// separates itself with `offset`, so a harbour full of shipping does not
// pulse in unison.
//
// The flash is brief on purpose: a light you can see the whole time reads as
// a lamp bolted to the model, which is exactly what this replaced.
export function beacon(period, flash, offset = 0) {
  return (sky.tick + offset) % period < flash;
}

// --- the sun and the moon --------------------------------------------------

// Both bodies travel the same arc, left to right. The camera never rotates,
// so screen x and world x are the same direction, and the arc can be worked
// out purely in screen space.
function arc(u, body) {
  body.x = -24 + u * (SCREEN_W + 48);
  body.y = ARC_Y - ARC_PEAK * Math.sin(u * Math.PI);
}

const SUN_RISE = 0.215, SUN_SET = 0.785;
const SUN_LOW  = [255, 116,  44];
const SUN_HIGH = [255, 248, 214];

function placeBodies(phase) {
  // The sun is up between sunrise and sunset.
  const su = (phase - SUN_RISE) / (SUN_SET - SUN_RISE);
  sun.up = su >= 0 && su <= 1;
  if (sun.up) {
    arc(su, sun);
    const high = Math.sin(su * Math.PI);          // 0 at the horizon, 1 at noon
    // Low sun is big and orange, high sun small and white -- the same
    // illusion the real one plays.
    sun.size = Math.round(lerp(30, 20, high));
    lerp3(sun.col, SUN_LOW, SUN_HIGH, Math.min(1, high * 1.9));
  }

  // The moon takes the other half of the cycle, running from sunset round
  // through midnight to sunrise.
  let mu = (phase - SUN_SET) / (1 - SUN_SET + SUN_RISE);
  if (mu < 0) mu = (phase + 1 - SUN_SET) / (1 - SUN_SET + SUN_RISE);
  moon.up = mu >= 0 && mu <= 1;
  if (moon.up) {
    arc(mu, moon);
    moon.size = 16;
  }
}

// --- the sky gradient ------------------------------------------------------

// The three bands the sky is drawn in. Anything that needs to know what
// colour the sky is behind it -- a star, the halo round the sun -- asks here
// rather than guessing, so the two can never drift apart.
export const SKY_BAND_1 = 58;
export const SKY_BAND_2 = 120;

const skyAt = [0, 0, 0];

export function skyColourAt(y) {
  if (y <= 0) return lerp3(skyAt, sky.top, sky.top, 0);
  if (y < SKY_BAND_1) return lerp3(skyAt, sky.top, sky.mid, y / SKY_BAND_1);
  if (y < SKY_BAND_2) {
    return lerp3(skyAt, sky.mid, sky.horizon, (y - SKY_BAND_1) / (SKY_BAND_2 - SKY_BAND_1));
  }
  return lerp3(skyAt, sky.horizon, sky.horizon, 0);
}

// --- stars -----------------------------------------------------------------

// A fixed field, generated once. They do not move: the camera never rotates
// and never rolls, so a star painted at a screen position stays put, which is
// exactly what a star at infinity would do anyway.
const STAR_COUNT = 120;

function makeStars() {
  let s = 0x2f6e2b1;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    // Squaring the vertical spread crowds them towards the top of the sky,
    // which leaves the horizon band clear for the sun and the landscape.
    const v = rnd();
    out.push({
      x: Math.round(rnd() * SCREEN_W),
      y: Math.round(v * v * (SKY_BAND_2 - 6)),
      mag: 0.3 + rnd() * 0.7,
      big: rnd() > 0.93,
      twinkle: rnd() * Math.PI * 2,
    });
  }
  return out;
}

export const STARS = makeStars();

// --- the light applied to everything solid ---------------------------------

const litCache = new Map();
const FOG_STEPS = 24;

// Tint a colour for the time of day and then fade it into the haze.
//
// Both happen here rather than at the call sites because they have to happen
// in that order -- tint first, haze second -- or distant land at night comes
// out darker than the sky it is supposed to be dissolving into.
export function litColour(col, fog) {
  const q = fog > 0.01 ? Math.round(fog * FOG_STEPS) : 0;
  const key = (col[0] << 18) | (col[1] << 10) | (col[2] << 2) | 0;
  const k = key * 32 + q;
  let out = litCache.get(k);
  if (out !== undefined) return out;

  const t = sky.tint;
  let r = col[0] * t[0], g = col[1] * t[1], b = col[2] * t[2];
  if (q > 0) {
    const f = q / FOG_STEPS;
    r += (sky.fog[0] - r) * f;
    g += (sky.fog[1] - g) * f;
    b += (sky.fog[2] - b) * f;
  }
  out = [
    Math.max(0, Math.min(255, Math.round(r))),
    Math.max(0, Math.min(255, Math.round(g))),
    Math.max(0, Math.min(255, Math.round(b))),
  ];
  litCache.set(k, out);
  return out;
}

// Lamps, flames and explosions make their own light, so they must not be
// tinted down at night -- but they should still fade into the haze with
// distance like everything else.
export function emissive(col, fog) {
  if (fog <= 0.01) return col;
  return [
    Math.round(col[0] + (sky.fog[0] - col[0]) * fog),
    Math.round(col[1] + (sky.fog[1] - col[1]) * fog),
    Math.round(col[2] + (sky.fog[2] - col[2]) * fog),
  ];
}

setPhase(sky.phase);
