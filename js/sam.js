// sam.js -- radar and missile sites.
//
// Everything else in the game wants you low, because low is where the targets
// are and where the flying is interesting. Nothing punished you for climbing:
// the soft ceiling is a limit rather than a threat, and a tank will not fire
// on a craft that is not on the ground.
//
// A missile site is the other half of that argument. It sees a long way but
// it cannot see down, so it turns altitude from a free choice into a cost.
// Cross its ground at a couple of tiles and it never knows you were there;
// cross it high and it takes its time, tells you it has you, and launches.

import { TILE, matRotY, matApply, rnd, rndSigned, rndInt } from './maths.js';
import { Model, shade, facet, drawModel, drawLamp } from './model.js';
import { sky, beacon } from './daylight.js';
import { landAltitude, SEA_LEVEL, isOnLaunchpad, UNDERCARRIAGE_Y } from './landscape.js';
import { spawnExplosion, spawnSparks, spawnSmoke } from './particles.js';
import { project } from './renderer.js';

// Rare on purpose. A site is a landmark rather than a population: two of them
// within fifty tiles, trickled in slowly, so meeting one is an event you plan
// a route around instead of a tax on flying at all.
export const MAX_SITES = 2;
export const SAM_SCORE = 600;

const SPAWN_MIN = 24 * TILE;
const SPAWN_MAX = 40 * TILE;
const SPAWN_CHANCE = 0.0026;    // per empty slot per frame: about one a minute
const RETIRE = 56 * TILE;
const HIT_RADIUS = 1.70;        // tiles, for a bomb passing through one
const BLAST_RADIUS = 3.00;
const WRECK_LIFE = 900;

// The radar. Range is generous and the floor is the whole point: below it the
// site is blind, and a craft crossing at a tile and a half is simply not
// there. Two and a bit tiles is low enough to be a decision -- it is under the
// height most people fly at without thinking -- and high enough that hugging
// the ground is not the only way through.
const RADAR_RANGE = 13 * TILE;
const RADAR_FLOOR = TILE * 2.2;
const SWEEP_RATE = 0.022;       // radians a frame, idling
const TRACK_RATE = 0.055;       // ... and once it has something to look at

// How long it holds you before it shoots, and how fast that decays once you
// drop back down. Losing the lock is deliberately slower than gaining it: a
// hop over the floor and straight back down should still cost you.
// Four and a half seconds from first contact to launch, not two. The whole
// point of the thing is the decision it puts to you, and a decision needs
// long enough to notice the dish, read the bar and get the nose down.
//
// The decay is the other half of that. It is slower than the gain -- 0.7 of a
// frame's worth per frame -- so dropping under the floor works but has to be
// meant: a hop down and straight back up finds the lock most of the way to
// where it was. That was stated in the first version and was not true of it;
// the decay was 1.6, which cleared a full lock in two thirds of the time it
// took to build.
const LOCK_TIME = 225;
const LOCK_DECAY = 0.7;
const RELOAD = 420;

const MISSILE_SPEED = 0.155;    // tiles per frame
const MISSILE_TURN = 0.052;     // radians a frame of homing
const MISSILE_LIFE = 330;
const MISSILE_HIT = 1.05;       // tiles
const MAX_MISSILES = 6;

// --- palette ---------------------------------------------------------------

const CONCRETE = [104, 108, 104];
const CONCRETE_B = [ 78,  84,  82];
const MAST     = [ 86,  92, 104];
const DISH     = [206, 212, 216];   // the face, which catches the light
const DISH_B   = [ 96, 104, 116];   // and its back
const RAIL     = [ 72,  80,  76];
const TUBE     = [ 62,  66,  74];
const WARHEAD  = [214,  74,  58];
const FIN      = [236, 214,  84];
const MARK     = [255, 150,  40];
const ALERT    = [255,  64,  56];
const CHAR     = [ 46,  42,  40];
const CHAR_B   = [ 68,  62,  58];

const S = 1.30;

// --- models ----------------------------------------------------------------

function box(m, x0, y0, z0, x1, y1, z1, cols) {
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);
  // A single colour goes in bare -- a colour is already an array, so wrapping
  // it in another list gives NaN when it is shaded.
  const c = Array.isArray(cols) ? { all: cols } : cols;
  const pick = (k) => c[k] || c.all;

  const q = [
    v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1),
    v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1),
  ];
  facet(m, [q[0], q[1], q[2], q[3]], pick('top'));      // y0 is the upper face
  facet(m, [q[4], q[5], q[6], q[7]], pick('bottom'));
  facet(m, [q[0], q[1], q[5], q[4]], pick('back'));
  facet(m, [q[3], q[2], q[6], q[7]], pick('front'));
  facet(m, [q[1], q[2], q[6], q[5]], pick('right'));
  facet(m, [q[0], q[3], q[7], q[4]], pick('left'));
  return q;
}

// The emplacement: a concrete apron, the launch rails with their rounds still
// on them, and the tower the dish turns on. All of it static.
//
// The tower is what sets the scale of the whole thing. Its head comes out at
// about the height of the radar floor, which is not a coincidence: the rule
// for getting past a site is "stay below the dish", and a rule you can see
// from the air is worth more than one you have to be told.
function buildBase(burnt) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);

  // Apron.
  box(m, -0.86, -0.20, -0.86, 0.86, 0.02, 0.86, burnt ? CHAR : {
    all: CONCRETE_B, top: CONCRETE, front: CONCRETE, right: CONCRETE_B,
  });

  if (!burnt) {
    // Hazard banding round the apron, so it reads as a target from the air
    // rather than as a lump of rock.
    for (const sgn of [1, -1]) {
      for (const [z0, z1] of [[-0.66, -0.34], [-0.10, 0.22], [0.46, 0.72]]) {
        facet(m, [
          v(sgn * 0.865, -0.18, z0), v(sgn * 0.865, -0.18, z1),
          v(sgn * 0.865, -0.02, z1), v(sgn * 0.865, -0.02, z0),
        ], MARK);
      }
    }
  }

  // Launch rails, each with a round on it, set out at the corners so the
  // tower has the middle to itself.
  for (const sx of [-0.52, 0.52]) {
    box(m, sx - 0.13, -0.38, -0.44, sx + 0.13, -0.20, 0.34, burnt ? CHAR_B : RAIL);
    box(m, sx - 0.09, -0.56, -0.32, sx + 0.09, -0.38, 0.26, burnt ? CHAR_B : TUBE);
    if (!burnt) {
      // Nose and fins, which is all it takes to read as a missile at this size.
      facet(m, [
        v(sx - 0.09, -0.56, 0.262), v(sx + 0.09, -0.56, 0.262),
        v(sx + 0.09, -0.38, 0.262), v(sx - 0.09, -0.38, 0.262),
      ], WARHEAD);
      facet(m, [
        v(sx - 0.09, -0.565, -0.32), v(sx + 0.09, -0.565, -0.32),
        v(sx + 0.09, -0.565, -0.14), v(sx - 0.09, -0.565, -0.14),
      ], FIN);
    }
  }

  // The tower: a wide plinth, a shaft, and a collar under the bearing. Three
  // boxes rather than one reads as built rather than extruded.
  box(m, -0.26, -0.44, -0.26, 0.26, -0.16, 0.26, burnt ? CHAR : shade(MAST, 0.85));
  box(m, -0.15, -1.66, -0.15, 0.15, -0.42, 0.15, burnt ? CHAR : MAST);
  box(m, -0.22, -1.80, -0.22, 0.22, -1.62, 0.22, burnt ? CHAR : shade(MAST, 1.2));
  return m;
}

// The dish, built about its own bearing so it can turn independently of the
// tower under it. An octagon rather than a rectangle, a real rim, and big
// enough to be the thing you see: the whole warning system is "that dish is
// pointing at me", which only works if you can tell where it points.
const DISH_R = 0.86;
const DISH_RAKE = 0.42;         // radians it leans back, looking up and out
const DISH_FACES = 8;

function buildDish(burnt) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);

  // A point on the rim, `depth` forward of the dish plane. Leaning the panel
  // back is done by rolling the up axis into z, so the whole disc stays flat
  // and the rim ring stays a ring.
  const rim = (i, r, depth) => {
    const a = (i / DISH_FACES) * Math.PI * 2 + Math.PI / DISH_FACES;
    const x = Math.cos(a) * r;
    const u = Math.sin(a) * r;                   // up, within the panel
    return v(x, -u * Math.cos(DISH_RAKE), depth - u * Math.sin(DISH_RAKE));
  };

  const front = [], back = [];
  for (let i = 0; i < DISH_FACES; i++) {
    front.push(rim(i, DISH_R, 0.10));
    back.push(rim(i, DISH_R * 0.94, -0.06));
  }

  // The face, as one polygon -- drawModel fans anything above four corners.
  facet(m, front, burnt ? CHAR_B : DISH);
  facet(m, back.slice().reverse(), burnt ? CHAR : DISH_B);
  // The rim, which is what gives it thickness as it turns edge on.
  for (let i = 0; i < DISH_FACES; i++) {
    const j = (i + 1) % DISH_FACES;
    facet(m, [front[i], front[j], back[j], back[i]], burnt ? CHAR : shade(DISH_B, 1.15));
  }

  if (!burnt) {
    // A darker inner disc, so the face is not one flat slab of white and the
    // dish reads as concave at a glance.
    const inner = [];
    for (let i = 0; i < DISH_FACES; i++) inner.push(rim(i, DISH_R * 0.46, 0.115));
    facet(m, inner, shade(DISH, 0.82));
  }

  // The feed, on a boom out in front of the face, with its horn on the end.
  box(m, -0.045, -0.045, 0.10, 0.045, 0.045, 0.52, burnt ? CHAR : MAST);
  box(m, -0.12, -0.12, 0.50, 0.12, 0.12, 0.64, burnt ? CHAR_B : shade(DISH_B, 1.3));

  // And a counterweight behind the bearing, which is what a real one needs
  // and what stops the back of the dish reading as empty.
  box(m, -0.20, -0.13, -0.30, 0.20, 0.13, -0.12, burnt ? CHAR : shade(MAST, 0.75));
  return m;
}

const BASE = buildBase(false);
const BASE_WRECK = buildBase(true);
const DISH_M = buildDish(false);
const DISH_WRECK = buildDish(true);

// --- state -----------------------------------------------------------------

const ALIVE = 0, WRECK = 1;
const sites = [];
for (let i = 0; i < MAX_SITES; i++) sites.push({ live: false, state: ALIVE });

const missiles = [];
let launched = 0;

export function resetSams() {
  for (const s of sites) { s.live = false; s.state = ALIVE; }
  missiles.length = 0;
  launched = 0;
}

export function samCount() {
  return sites.reduce((n, s) => n + (s.live && s.state === ALIVE ? 1 : 0), 0);
}

export function missilesLaunchedTotal() {
  return launched;
}

// The worst lock anywhere, 0 to 1, for the HUD and the warning tone to read.
// One number rather than a list: you do not need to know which site has you,
// you need to know how long you have.
export function samThreat() {
  let worst = 0;
  for (const s of sites) {
    if (s.live && s.state === ALIVE) worst = Math.max(worst, s.lock / LOCK_TIME);
  }
  return Math.min(1, worst);
}

export function missilesInFlight() {
  return missiles.length;
}

function place(s, px, pz) {
  // Somewhere in a ring around the player, on ground flat enough to build on
  // and clear of the pad. A site that spawns on a cliff reads as scenery.
  for (let attempt = 0; attempt < 16; attempt++) {
    const a = rnd() * Math.PI * 2;
    const r = SPAWN_MIN + rnd() * (SPAWN_MAX - SPAWN_MIN);
    const x = (px + Math.cos(a) * r) | 0;
    const z = (pz + Math.sin(a) * r) | 0;
    if (isOnLaunchpad(x, z)) continue;

    const base = landAltitude(x, z);
    if (base >= SEA_LEVEL - TILE * 0.4) continue;

    // Flat: no corner of the apron more than a third of a tile off the middle.
    let flat = true;
    for (let i = 0; i < 4 && flat; i++) {
      const b = (i / 4) * Math.PI * 2;
      const h = landAltitude((x + Math.cos(b) * TILE * 0.8) | 0,
                             (z + Math.sin(b) * TILE * 0.8) | 0);
      if (Math.abs(h - base) > TILE * 0.33) flat = false;
    }
    if (!flat) continue;

    s.live = true;
    s.state = ALIVE;
    s.x = x; s.z = z;
    s.dish = rnd() * Math.PI * 2;
    s.lock = 0;
    s.reload = rndInt(RELOAD);
    s.wreckTimer = 0;
    s.smokeTick = rndInt(20);
    s.blinkAt = rndInt(46);
    return true;
  }
  return false;
}

// --- update ----------------------------------------------------------------

export function updateSams(player, game) {
  const px = player.x, pz = player.z;

  for (const s of sites) {
    if (!s.live) {
      if (rnd() < SPAWN_CHANCE) place(s, px, pz);
      continue;
    }

    if (Math.hypot(s.x - px, s.z - pz) > RETIRE) { s.live = false; continue; }

    if (s.state === WRECK) {
      if (--s.wreckTimer <= 0) { s.live = false; continue; }
      if ((s.smokeTick = (s.smokeTick + 1) % 9) === 0) {
        spawnSmoke(s.x, (landAltitude(s.x, s.z) - TILE * 0.6) | 0, s.z);
      }
      continue;
    }

    // Can it see you? Range, and height above the ground under the craft --
    // height above the ground rather than world height, because a craft down
    // in a valley is behind the hills whatever its altitude says.
    const range = Math.hypot(px - s.x, pz - s.z);
    const seen = !player.dead && range < RADAR_RANGE &&
                 player.altitude > RADAR_FLOOR;

    if (seen) {
      // Swing onto the bearing rather than snapping to it: the dish coming
      // round to face you is the first thing you get, before any siren.
      const want = Math.atan2(px - s.x, pz - s.z);
      let d = want - s.dish;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      s.dish += Math.max(-TRACK_RATE, Math.min(TRACK_RATE, d));
      s.lock++;
    } else {
      s.dish += SWEEP_RATE;
      s.lock -= LOCK_DECAY;
      if (s.lock < 0) s.lock = 0;
    }

    if (s.reload > 0) s.reload--;
    if (s.lock >= LOCK_TIME && s.reload === 0 && missiles.length < MAX_MISSILES) {
      launch(s, player, game);
      s.lock = LOCK_TIME * 0.45;      // it still has you; it just has to reload
      s.reload = RELOAD + rndInt(120);
    }
  }

  updateMissiles(player, game);
}

function launch(s, player, game) {
  const base = landAltitude(s.x, s.z);
  const side = rnd() < 0.5 ? -0.30 : 0.30;
  const x = (s.x + side * S * TILE) | 0;
  const y = (base - TILE * 0.5) | 0;
  const z = s.z;

  const dx = player.x - x;
  const dy = (player.y + UNDERCARRIAGE_Y * 0.5) - y;
  const dz = player.z - z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const sp = MISSILE_SPEED * TILE;

  missiles.push({
    x, y, z,
    vx: (dx / len) * sp, vy: (dy / len) * sp, vz: (dz / len) * sp,
    life: MISSILE_LIFE, trail: 0,
  });
  launched++;
  spawnSparks(x, y, z, 8);
  game.onSamLaunch(x, y, z);
}

function updateMissiles(player, game) {
  const sp = MISSILE_SPEED * TILE;

  for (let i = missiles.length - 1; i >= 0; i--) {
    const m = missiles[i];

    // Homing, as a limited turn towards the craft rather than a straight line
    // to it. A missile that simply tracks is unavoidable and therefore not a
    // decision; one that has to turn can be made to overshoot.
    if (!player.dead) {
      const dx = player.x - m.x, dy = player.y - m.y, dz = player.z - m.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const wx = (dx / len) * sp, wy = (dy / len) * sp, wz = (dz / len) * sp;
      m.vx += (wx - m.vx) * MISSILE_TURN;
      m.vy += (wy - m.vy) * MISSILE_TURN;
      m.vz += (wz - m.vz) * MISSILE_TURN;
      // Re-normalise, so turning costs nothing in speed.
      const v = Math.hypot(m.vx, m.vy, m.vz) || 1;
      m.vx = (m.vx / v) * sp; m.vy = (m.vy / v) * sp; m.vz = (m.vz / v) * sp;
    }

    m.x = (m.x + m.vx) | 0;
    m.y = (m.y + m.vy) | 0;
    m.z = (m.z + m.vz) | 0;

    if ((m.trail = (m.trail + 1) % 3) === 0) spawnSmoke(m.x, m.y, m.z);

    let done = --m.life <= 0;

    if (!done && !player.dead) {
      const dx = (m.x - player.x) / TILE;
      const dy = (m.y - player.y) / TILE;
      const dz = (m.z - player.z) / TILE;
      if (dx * dx + dy * dy + dz * dz < MISSILE_HIT * MISSILE_HIT) {
        spawnExplosion(m.x, m.y, m.z, 18, TILE * 0.034, null);
        game.onPlayerHitBySam();
        done = true;
      }
    }

    if (!done && m.y >= landAltitude(m.x, m.z)) {
      const g = landAltitude(m.x, m.z);
      if (g < SEA_LEVEL) spawnExplosion(m.x, g, m.z, 10, TILE * 0.02, null);
      done = true;
    }

    if (done) missiles.splice(i, 1);
  }
}

// --- being hit -------------------------------------------------------------

export function samHit(bx, by, bz, game) {
  for (const s of sites) {
    if (!s.live || s.state !== ALIVE) continue;
    const dx = (bx - s.x) / TILE, dz = (bz - s.z) / TILE;
    if (dx * dx + dz * dz > HIT_RADIUS * HIT_RADIUS) continue;
    const base = landAltitude(s.x, s.z);
    if (by < base - TILE * 1.4 || by > base + TILE * 0.3) continue;
    destroy(s, game);
    return true;
  }
  return false;
}

// A bomb that went off nearby rather than through one.
export function samBlast(bx, by, bz, game) {
  for (const s of sites) {
    if (!s.live || s.state !== ALIVE) continue;
    const dx = (bx - s.x) / TILE, dz = (bz - s.z) / TILE;
    if (dx * dx + dz * dz > BLAST_RADIUS * BLAST_RADIUS) continue;
    destroy(s, game);
  }
}

function destroy(s, game) {
  const base = landAltitude(s.x, s.z);
  s.state = WRECK;
  s.wreckTimer = WRECK_LIFE;
  s.lock = 0;
  // The rounds still on the rails go up with it, which is why a site is worth
  // more than anything else in the game.
  spawnExplosion(s.x, (base - TILE * 0.5) | 0, s.z, 52, TILE * 0.05, null);
  spawnSparks(s.x, (base - TILE * 0.3) | 0, s.z, 22);
  game.onSamDestroyed(s.x, base, s.z);
}

// --- drawing ---------------------------------------------------------------

export function samsInRow(zLo, zHi, out) {
  for (const s of sites) {
    if (s.live && s.z >= zLo && s.z < zHi) out.push(s);
  }
  return out;
}

const dishMat = new Float64Array(9);

export function drawSam(rd, s, camX, camY, camZ, fog = 0) {
  const base = landAltitude(s.x, s.z);
  const wrecked = s.state !== ALIVE;

  matRotY(0, dishMat);
  drawModel(rd, wrecked ? BASE_WRECK : BASE, dishMat,
            s.x, base, s.z, camX, camY, camZ, fog);

  matRotY(s.dish, dishMat);
  drawModel(rd, wrecked ? DISH_WRECK : DISH_M, dishMat,
            s.x, (base - TILE * 1.88 * S) | 0, s.z, camX, camY, camZ, fog);

  if (wrecked) return;

  // A red lamp on the mast, blinking faster the closer it is to launching.
  // It is the same information the HUD carries, put where you are looking --
  // at the thing that is about to shoot you.
  const t = Math.min(1, s.lock / LOCK_TIME);
  const period = t > 0 ? Math.max(8, Math.round(46 - 34 * t)) : 46;
  if (beacon(period, Math.max(3, period >> 1), s.blinkAt | 0)) {
    // On the apron corners rather than the tower: the dish swings right round,
    // and a warning light the warning itself can hide is no warning.
    for (const sx of [-0.80, 0.80]) {
      for (const sz of [-0.80, 0.80]) {
        drawLamp(rd, (s.x + sx * S * TILE) | 0, (base - TILE * 0.22 * S) | 0,
                 (s.z + sz * S * TILE) | 0, camX, camY, camZ,
                 0.028 + 0.042 * t, t > 0.02 ? ALERT : MARK, fog);
      }
    }
  }
}

const mp = { x: 0, y: 0 };

// Missiles draw straight rather than bucketed by row: they are brief and in
// the air, and one lost behind a hill is a hit you could not have read.
export function drawMissiles(rd, camX, camY, camZ) {
  for (const m of missiles) {
    if (!project((m.x - camX) | 0, (m.y - camY) | 0, (m.z - camZ) | 0, mp)) continue;
    const x = Math.round(mp.x), y = Math.round(mp.y);
    rd.rect(x - 1, y - 1, 3, 3, WARHEAD);
    rd.rect(x, y, 1, 1, [255, 232, 200]);
  }
}
