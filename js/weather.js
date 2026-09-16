// weather.js -- fronts, precipitation and wind.
//
// Weather is the one thing in this world that is NOT a pure function of where
// you are. The landscape, the biomes and the object map all are: fly back and
// you find what you left. Weather is the opposite and has to be, because a
// front that sat still over one stretch of map would not be weather at all --
// it would be terrain you could see through. So this is driven by the clock,
// and the only thing position decides is what falls out of the sky: snow where
// it is cold, rain where it is temperate, and very little anywhere hot.
//
// It writes its results into the sky, which already owns the tint and the haze
// that the hour sets. That keeps the dependency one-way -- the landscape reads
// the sky and never hears of weather -- and means every surface in the game
// darkens under cloud without a single call site knowing why.

import { TILE, rnd, rndSigned } from './maths.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { sky, invalidateLight } from './daylight.js';
import { climateRamp } from './biome.js';
import { project, projScale, SCREEN_W, SCREEN_H } from './renderer.js';
import { litColour } from './daylight.js';

export const CLEAR = 0, RAIN = 1, SNOW = 2;

export const weather = {
  wet: 0,          // how hard it is coming down, 0 to 1
  kind: CLEAR,
  windX: 0,        // push on anything airborne, fixed point per frame
  windZ: 0,
  strength: 0,     // wind as a fraction of a gale, for things that only care how hard
  struck: false,   // true on the single frame a bolt goes, for the thunder
};

// --- how the weather moves -------------------------------------------------

// Two slow waves beating against each other: about eighty seconds and about
// three and a half minutes. Neither period divides the other, so fronts do not
// arrive on a timetable you could learn.
const FRONT_A = 0.0016, FRONT_B = 0.00061;

// Only the top of the range is wet, so most of the time it is merely cloudy.
const WET_AT = 0.28, WET_FULL = 0.86;

// Terminal drift in a full gale works out around a tile a second: enough that
// hovering over one spot needs holding, not enough to take the machine away
// from you.
const WIND_MAX = TILE * 0.00035;

let flash = 0, flashHold = 0;

export function resetWeather() {
  weather.wet = 0;
  weather.kind = CLEAR;
  weather.windX = weather.windZ = weather.strength = 0;
  weather.struck = false;
  sky.murk = 0;
  sky.flash = 0;
  flash = flashHold = 0;
  drops.fill(0);
  seeded = false;
}

let lastSig = -1;

export function updateWeather(px, pz) {
  const t = sky.tick;

  const front = Math.sin(t * FRONT_A) * 0.62 + Math.sin(t * FRONT_B + 1.7) * 0.38;
  let wet = (front - WET_AT) / (WET_FULL - WET_AT);
  wet = wet < 0 ? 0 : wet > 1 ? 1 : wet;

  // What falls depends on where you are. A desert gets the cloud but keeps
  // most of the rain: that is most of why it is a desert.
  const ramp = climateRamp(px, pz);
  if (ramp < 0.62) weather.kind = SNOW;
  else if (ramp > 1.45) { weather.kind = RAIN; wet *= 0.22; }
  else weather.kind = RAIN;
  if (wet < 0.02) weather.kind = CLEAR;
  weather.wet = wet;

  // Wind. There is always a little; a front brings a lot. The bearing turns
  // slowly rather than jumping, so rain never changes direction mid-shower.
  const bearing = t * 0.00042 + Math.sin(t * 0.00017) * 1.4;
  const gust = 0.78 + 0.22 * Math.sin(t * 0.021) * Math.sin(t * 0.0067);
  weather.strength = (0.16 + 0.84 * wet) * gust;
  weather.windX = (Math.sin(bearing) * weather.strength * WIND_MAX) | 0;
  weather.windZ = (Math.cos(bearing) * weather.strength * WIND_MAX) | 0;

  // Cloud closes the world in and takes the colour out of it.
  const murk = wet * 0.72 + Math.max(0, front) * 0.18;
  sky.murk = Math.min(1, murk);

  if (sky.murk > 0.01) {
    const m = sky.murk;
    greyOut(sky.top, m * 0.55);
    greyOut(sky.mid, m * 0.72);
    greyOut(sky.horizon, m * 0.80);
    // The haze is always the sky at the horizon. That invariant is the whole
    // reason distant ground dissolves instead of ending at a line, and it has
    // to survive weather as much as it survives midnight.
    sky.fog[0] = sky.horizon[0];
    sky.fog[1] = sky.horizon[1];
    sky.fog[2] = sky.horizon[2];
    // Under heavy cloud everything loses a little light and a lot of colour.
    const drain = 1 - m * 0.28;
    const mean = (sky.tint[0] + sky.tint[1] + sky.tint[2]) / 3;
    for (let i = 0; i < 3; i++) {
      sky.tint[i] = (sky.tint[i] + (mean - sky.tint[i]) * m * 0.45) * drain;
    }
  }

  // Lightning, only in the heaviest rain.
  weather.struck = false;
  if (flashHold > 0) {
    flashHold--;
    flash *= 0.72;
  } else if (weather.kind === RAIN && wet > 0.72 && rnd() < 0.006) {
    flash = 1;
    flashHold = 7;
    weather.struck = true;
  } else {
    flash = 0;
  }
  sky.flash = flash;
  if (flash > 0.02) {
    for (let i = 0; i < 3; i++) {
      sky.top[i] = Math.min(255, sky.top[i] + 150 * flash);
      sky.mid[i] = Math.min(255, sky.mid[i] + 130 * flash);
      sky.horizon[i] = Math.min(255, sky.horizon[i] + 100 * flash);
      sky.fog[i] = sky.horizon[i];
      sky.tint[i] *= 1 + 0.7 * flash;
    }
  }

  // The colour caches downstream only clear when the hour ticks over, roughly
  // three times a second. A front rolling in is happy with that; a lightning
  // strike is four frames long and is not.
  const sig = (Math.round(sky.murk * 40) << 6) | Math.round(flash * 40);
  if (sig !== lastSig) { lastSig = sig; invalidateLight(); }

  stepDrops(px, pz);
}

function greyOut(col, amount) {
  const STORM = 96;
  col[0] += (STORM - col[0]) * amount;
  col[1] += (STORM + 4 - col[1]) * amount;
  col[2] += (STORM + 12 - col[2]) * amount;
}

// --- precipitation ---------------------------------------------------------
//
// Its own pool, not the game's particle system. That has 484 slots shared
// between explosions, smoke, spray and bullets, and a downpour would take the
// lot -- the first thing you would notice about heavy rain is that nothing
// blew up properly any more.
//
// Drops live in a box that travels with the player and are recycled from the
// bottom back to the top, so the cost is fixed whatever the weather is doing
// and no drop is ever simulated where it cannot be seen.

const MAX_DROPS = 300;
const BOX_X = 15 * TILE;      // half-width of the box, widened with the view
const BOX_Z_BACK = 4 * TILE;
const BOX_Z_FWD = 17 * TILE;
const BOX_TOP = -4.5 * TILE;  // remember +y is down

const drops = new Int32Array(MAX_DROPS * 6);   // x, y, z, vx, vy, vz
let seeded = false;

function reseed(i, px, pz, atTop) {
  const o = i * 6;
  drops[o] = (px + rndSigned() * BOX_X) | 0;
  drops[o + 2] = (pz - BOX_Z_BACK + rnd() * (BOX_Z_FWD + BOX_Z_BACK)) | 0;
  drops[o + 1] = atTop
    ? (BOX_TOP - rnd() * TILE * 2) | 0
    : (BOX_TOP + rnd() * TILE * 9) | 0;
  drops[o + 3] = 0;
  drops[o + 5] = 0;
  drops[o + 4] = 0;
}

// How many of the pool are in play, and how fast they fall.
function activeDrops() {
  if (weather.kind === CLEAR) return 0;
  return Math.round(MAX_DROPS * Math.min(1, weather.wet * 1.15));
}

const RAIN_FALL = TILE * 0.075;
const SNOW_FALL = TILE * 0.011;

function stepDrops(px, pz) {
  const n = activeDrops();
  if (n === 0) { seeded = false; return; }

  if (!seeded) {
    for (let i = 0; i < MAX_DROPS; i++) reseed(i, px, pz, false);
    seeded = true;
  }

  const snow = weather.kind === SNOW;
  const fall = snow ? SNOW_FALL : RAIN_FALL;
  // Snow is light enough for the wind to carry it bodily; rain is not, so it
  // only leans.
  const carry = snow ? 2.6 : 1.0;
  const t = sky.tick;

  for (let i = 0; i < n; i++) {
    const o = i * 6;
    let x = drops[o], y = drops[o + 1], z = drops[o + 2];

    y = (y + fall) | 0;
    x = (x + weather.windX * carry * 30) | 0;
    z = (z + weather.windZ * carry * 30) | 0;
    // A flake wanders; a raindrop does not.
    if (snow) x = (x + Math.sin(t * 0.07 + i) * TILE * 0.004) | 0;

    // Back to the top once it has landed or drifted out of the box.
    const ground = landAltitude(x, z);
    const dx = x - px, dz = z - pz;
    if (y >= ground || y >= SEA_LEVEL
        || dx > BOX_X || dx < -BOX_X || dz > BOX_Z_FWD || dz < -BOX_Z_BACK) {
      reseed(i, px, pz, true);
      continue;
    }

    drops[o] = x; drops[o + 1] = y; drops[o + 2] = z;
  }
}

// --- drawing ---------------------------------------------------------------

const pa = { x: 0, y: 0 }, pb = { x: 0, y: 0 };

const RAIN_COL = [176, 196, 226];
const SNOW_COL = [240, 246, 252];

// Drawn after the landscape and before the HUD, so precipitation falls in
// front of the world rather than through it. There is no depth test, which
// for once is what we want: a drop is nearer than everything behind it and
// there is nothing in the game it should be hidden by.
export function drawWeather(rd, camX, camY, camZ) {
  const n = activeDrops();
  if (n === 0) return;

  const snow = weather.kind === SNOW;
  const col = litColour(snow ? SNOW_COL : RAIN_COL, 0);
  const fall = snow ? SNOW_FALL : RAIN_FALL;
  // A streak is where the drop has been over the last few frames, which is
  // what a shutter would catch and what makes rain read as falling rather
  // than as a field of dots.
  const tail = snow ? 0 : 3.2;

  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const vz = (drops[o + 2] - camZ) | 0;
    if (vz <= 0) continue;
    if (!project((drops[o] - camX) | 0, (drops[o + 1] - camY) | 0, vz, pa)) continue;
    if (pa.x < -8 || pa.x > SCREEN_W + 8 || pa.y < -8 || pa.y > SCREEN_H + 8) continue;

    if (snow) {
      const s = projScale(vz) * TILE > 0.6 ? 2 : 1;
      rd.rect(Math.round(pa.x), Math.round(pa.y), s, s, col);
      continue;
    }

    const bx = (drops[o] - camX - weather.windX * 30 * tail) | 0;
    const by = (drops[o + 1] - camY - fall * tail) | 0;
    if (!project(bx, by, vz, pb)) continue;

    // A streak with a little width, so it survives at this resolution.
    const w = projScale(vz) * TILE > 0.7 ? 1 : 0.6;
    rd.quad(pa.x - w, pa.y, pa.x + w, pa.y, pb.x + w, pb.y, pb.x - w, pb.y, col);
  }
}
