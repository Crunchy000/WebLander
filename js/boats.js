// boats.js -- vessels patrolling the sea.
//
// The sea covers a good deal of the map and until now did nothing at all, so
// these give it a reason to be flown over. They work like the tanks -- a small
// recycled pool spawned in a ring around the player -- but the water changes
// the character of them: there is no terrain to hide behind, so they are easy
// to spot and easy to line up on, and the interest is in the sinking rather
// than the hunt.

import { TILE, matFromAim, rnd, rndSigned, rndInt } from './maths.js';
import { Model, shade, facet, drawModel } from './model.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { spawnExplosion, spawnSparks, spawnSmoke, spawn, P_GRAVITY, P_FADE } from './particles.js';

export const MAX_BOATS = 6;
export const BOAT_SCORE = 200;

const SPAWN_MIN = 15 * TILE;
const SPAWN_MAX = 30 * TILE;
const RETIRE = 48 * TILE;
const HIT_RADIUS = 1.25;        // a bigger target than a tank
const BLAST_RADIUS = 2.6;
const SINK_TIME = 260;          // frames from hit to gone
const CLEARANCE = 2.2 * TILE;   // open water needed around a spawn

// --- models ----------------------------------------------------------------

const HULL     = [ 38,  52,  86];   // navy
const HULL_B   = [ 26,  36,  62];
const BOOT     = [176,  58,  52];   // boot-topping at the waterline
const DECK     = [162, 142, 104];   // planking
const HOUSE    = [232, 236, 242];   // superstructure
const HOUSE_B  = [196, 202, 212];
const BRIDGE   = [ 96, 214, 236];   // glazing
const FUNNEL   = [216,  78,  54];
const FUNNEL_B = [ 40,  42,  48];
const MAST     = [208, 212, 220];
const TRIM     = [250, 196,  64];
const CHAR     = [ 44,  40,  40];
const CHAR_B   = [ 68,  62,  58];

function box(m, x0, y0, z0, x1, y1, z1, cols) {
  const v = (x, y, z) => m.vert(x, y, z);
  const c = Array.isArray(cols) ? { all: cols } : cols;
  const pick = (k) => c[k] || c.all;
  const q = [
    v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1),
    v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1),
  ];
  facet(m, [q[0], q[1], q[2], q[3]], pick('top'));
  facet(m, [q[4], q[5], q[6], q[7]], pick('bottom'));
  facet(m, [q[0], q[1], q[5], q[4]], pick('back'));
  facet(m, [q[3], q[2], q[6], q[7]], pick('front'));
  facet(m, [q[1], q[2], q[6], q[5]], pick('right'));
  facet(m, [q[0], q[3], q[7], q[4]], pick('left'));
  return q;
}

// Bow towards +z. The origin sits at the waterline, so the hull can simply be
// pushed down as it floods.
function buildBoat(burnt) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x, y, z);
  const hull = burnt ? CHAR : HULL;
  const deck = burnt ? CHAR_B : DECK;

  // Hull: a slab aft narrowing to a stem at the bow.
  const W = 0.34, YT = -0.16, YB = 0.20;
  const sternL = v(-W, YT, -0.92), sternR = v(W, YT, -0.92);
  const waistL = v(-W, YT, 0.30), waistR = v(W, YT, 0.30);
  const stem = v(0, YT, 1.05);
  const kStern = v(0, YB, -0.86), kWaist = v(0, YB, 0.26), kStem = v(0, YB, 0.92);

  facet(m, [sternL, sternR, waistR, waistL], deck);          // deck aft
  facet(m, [waistL, waistR, stem], deck);                    // forecastle
  facet(m, [sternL, waistL, kWaist, kStern], burnt ? CHAR : HULL_B);   // port side
  facet(m, [sternR, waistR, kWaist, kStern], hull);          // starboard side
  facet(m, [waistL, stem, kStem, kWaist], burnt ? CHAR : HULL_B);
  facet(m, [waistR, stem, kStem, kWaist], hull);
  facet(m, [sternL, sternR, kStern], burnt ? CHAR : HULL_B);  // transom

  if (!burnt) {
    // Boot-topping, a bright band right on the waterline.
    for (const sgn of [1, -1]) {
      facet(m, [
        v(sgn * (W + 0.005), -0.02, -0.88), v(sgn * (W + 0.005), -0.02, 0.28),
        v(sgn * (W + 0.005), 0.05, 0.28), v(sgn * (W + 0.005), 0.05, -0.88),
      ], BOOT);
    }
  }

  // Superstructure, aft of amidships.
  box(m, -0.24, -0.46, -0.58, 0.24, -0.16, 0.06, burnt ? [CHAR] : {
    all: HOUSE, top: HOUSE_B, front: HOUSE_B,
  });
  // Bridge, with glazing forward.
  box(m, -0.17, -0.62, -0.44, 0.17, -0.46, -0.10, burnt ? [CHAR] : {
    all: HOUSE_B, top: HOUSE, front: BRIDGE,
  });

  if (!burnt) {
    // Funnel with a black band.
    box(m, -0.10, -0.80, -0.40, 0.10, -0.62, -0.20, { all: FUNNEL, top: FUNNEL_B });
    // Mast.
    box(m, -0.022, -0.96, 0.16, 0.022, -0.44, 0.20, [MAST]);
    // A splash of deck colour so she reads against the water.
    facet(m, [
      v(-0.20, -0.17, 0.10), v(0.20, -0.17, 0.10),
      v(0.20, -0.17, 0.24), v(-0.20, -0.17, 0.24),
    ], TRIM);
  }
  return m;
}

const BOAT = buildBoat(false);
const BOAT_WRECK = buildBoat(true);

// --- state -----------------------------------------------------------------

const AFLOAT = 0, SINKING = 1;
const boats = [];
for (let i = 0; i < MAX_BOATS; i++) boats.push({ live: false, state: AFLOAT });

export function resetBoats() {
  for (const b of boats) { b.live = false; b.state = AFLOAT; }
}

export function boatCount() {
  return boats.reduce((n, b) => n + (b.live ? 1 : 0), 0);
}

// Open water, with room to move.
function afloat(x, z) {
  if (landAltitude(x, z) < SEA_LEVEL) return false;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    if (landAltitude((x + Math.cos(a) * CLEARANCE) | 0,
                     (z + Math.sin(a) * CLEARANCE) | 0) < SEA_LEVEL) return false;
  }
  return true;
}

function placeBoat(b, px, pz) {
  for (let attempt = 0; attempt < 14; attempt++) {
    const a = rnd() * Math.PI * 2;
    const r = SPAWN_MIN + rnd() * (SPAWN_MAX - SPAWN_MIN);
    const x = (px + Math.cos(a) * r) | 0;
    const z = (pz + Math.sin(a) * r) | 0;
    if (!afloat(x, z)) continue;

    b.live = true;
    b.state = AFLOAT;
    b.x = x; b.z = z;
    b.heading = rnd() * Math.PI * 2;
    b.speed = (0.006 + rnd() * 0.006) * TILE;
    b.turnTimer = 120 + rndInt(240);
    b.phase = rnd() * Math.PI * 2;      // where she is in her roll
    b.sink = 0;
    b.wakeTick = rndInt(8);
    return true;
  }
  return false;
}

// --- update ----------------------------------------------------------------

export function updateBoats(player, game) {
  const px = player.x, pz = player.z;

  for (const b of boats) {
    if (!b.live) {
      if (rnd() < 0.015) placeBoat(b, px, pz);
      continue;
    }

    if (Math.hypot(b.x - px, b.z - pz) > RETIRE) { b.live = false; continue; }

    b.phase += 0.045;

    if (b.state === SINKING) {
      b.sink++;
      // Settles by the stern, going down by the head at the last.
      if (b.sink % 7 === 0) spawnSmoke(b.x, (SEA_LEVEL - TILE * 0.7) | 0, b.z);
      if (b.sink % 11 === 0) spawnSparks(b.x, (SEA_LEVEL - TILE * 0.3) | 0, b.z, 3);
      if (b.sink >= SINK_TIME) {
        // Gone. Leave a patch of foam where she was.
        for (let i = 0; i < 16; i++) {
          const a = rnd() * Math.PI * 2, r = rnd() * TILE * 0.9;
          spawn((b.x + Math.cos(a) * r) | 0, SEA_LEVEL, (b.z + Math.sin(a) * r) | 0,
                Math.cos(a) * TILE * 0.004, -rnd() * TILE * 0.006, Math.sin(a) * TILE * 0.004,
                [226, 240, 250], 30 + rndInt(24), P_GRAVITY | P_FADE, 2);
        }
        b.live = false;
      }
      continue;
    }

    // Steaming. Alter course now and then.
    if (--b.turnTimer <= 0) {
      b.heading += rndSigned() * 0.9;
      b.turnTimer = 140 + rndInt(260);
    }

    const nx = (b.x + Math.sin(b.heading) * b.speed) | 0;
    const nz = (b.z + Math.cos(b.heading) * b.speed) | 0;

    // Put the helm over rather than running aground.
    if (!afloat(nx, nz)) {
      b.heading += 1.4 + rnd() * 0.8;
      b.turnTimer = 60 + rndInt(90);
    } else {
      b.x = nx; b.z = nz;
    }

    // A wake, which is mostly what makes her visible on open water.
    if ((b.wakeTick = (b.wakeTick + 1) % 7) === 0) {
      const sx = Math.sin(b.heading), sz = Math.cos(b.heading);
      for (const side of [-1, 1]) {
        spawn((b.x - sx * TILE * 0.85 - sz * side * TILE * 0.22) | 0,
              SEA_LEVEL,
              (b.z - sz * TILE * 0.85 + sx * side * TILE * 0.22) | 0,
              -sx * TILE * 0.002 - sz * side * TILE * 0.003,
              0,
              -sz * TILE * 0.002 + sx * side * TILE * 0.003,
              [214, 232, 246], 34 + rndInt(20), P_FADE, 2);
      }
    }
  }
}

// --- being hit -------------------------------------------------------------

export function boatHit(bx, by, bz) {
  for (const b of boats) {
    if (!b.live || b.state !== AFLOAT) continue;
    const dx = (bx - b.x) / TILE, dz = (bz - b.z) / TILE;
    if (dx * dx + dz * dz > HIT_RADIUS * HIT_RADIUS) continue;
    if (by < SEA_LEVEL - TILE * 1.6 || by > SEA_LEVEL + TILE * 0.4) continue;
    return b;
  }
  return null;
}

export function boatBlast(bx, by, bz, game) {
  let hit = 0;
  for (const b of boats) {
    if (!b.live || b.state !== AFLOAT) continue;
    const dx = (bx - b.x) / TILE, dz = (bz - b.z) / TILE;
    if (dx * dx + dz * dz > BLAST_RADIUS * BLAST_RADIUS) continue;
    sinkBoat(b, game);
    hit++;
  }
  return hit;
}

function sinkBoat(b, game) {
  const mid = (SEA_LEVEL - TILE * 0.5) | 0;
  spawnExplosion(b.x, mid, b.z, 30, TILE * 0.05, null);
  spawnExplosion(b.x, mid, b.z, 22, TILE * 0.02,
    [[120, 116, 108], [90, 88, 84], [160, 70, 40]]);
  spawnSparks(b.x, mid, b.z, 18);
  // A wall of spray.
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, sp = TILE * (0.008 + rnd() * 0.02);
    spawn(b.x, SEA_LEVEL, b.z,
          Math.cos(a) * sp, -(TILE * 0.02 + rnd() * TILE * 0.03), Math.sin(a) * sp,
          [222, 238, 250], 34 + rndInt(28), P_GRAVITY | P_FADE, 2);
  }

  b.state = SINKING;
  b.sink = 0;
  b.listDir = rndSigned() > 0 ? 1 : -1;
  game.addScore(BOAT_SCORE);
  game.onBoatSunk(b.x, mid, b.z);
}

// --- drawing ---------------------------------------------------------------

const boatMat = new Float64Array(9);

export function boatsInRow(zLo, zHi, out) {
  for (const b of boats) {
    if (!b.live) continue;
    if (b.z >= zLo && b.z < zHi) out.push(b);
  }
  return out;
}

export function drawBoat(rd, b, camX, camY, camZ) {
  let y = SEA_LEVEL;
  let pitch = Math.sin(b.phase) * 0.035;          // gentle scend

  if (b.state === SINKING) {
    const t = b.sink / SINK_TIME;
    // Down by the stern, steepening, and under she goes.
    pitch = -0.05 - t * 0.85;
    y = (SEA_LEVEL + t * t * TILE * 1.9) | 0;
  }

  matFromAim(b.heading, pitch, boatMat);
  drawModel(rd, b.state === SINKING ? BOAT_WRECK : BOAT, boatMat,
            b.x, y, b.z, camX, camY, camZ);
}
