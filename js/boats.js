// boats.js -- vessels patrolling the sea.
//
// The sea covers a good deal of the map and until now did nothing at all, so
// these give it a reason to be flown over. They work like the tanks -- a small
// recycled pool spawned in a ring around the player -- but the water changes
// the character of them: there is no terrain to hide behind, so they are easy
// to spot and easy to line up on, and the interest is in the sinking rather
// than the hunt.

import { TILE, matFromAim, matMul, matRotZ, rnd, rndSigned, rndInt } from './maths.js';
import { Model, shade, facet, drawModel } from './model.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { spawnExplosion, spawnSparks, spawnSmoke, spawn, P_GRAVITY, P_FADE } from './particles.js';

export const MAX_BOATS = 6;
export const BOAT_SCORE = 400;

// Hulls take two bombs. One puts her down by the head, smoking and slowed;
// the second finishes her. A ship should cost more than a tank to kill.
export const BOAT_HP = 2;

// Everything scales from here, so the whole vessel grows in one place.
const S = 1.26;

const SPAWN_MIN = 15 * TILE;
const SPAWN_MAX = 30 * TILE;
const RETIRE = 48 * TILE;
const HIT_RADIUS = 1.45;        // a bigger target than a tank
const BLAST_RADIUS = 2.8;
const SINK_TIME = 260;          // frames from hit to gone
const CLEARANCE = 2.2 * TILE;   // open water needed around a spawn

// --- models ----------------------------------------------------------------

// A stubby patchwork tug. Rather than painting each part a sensible colour,
// every facet takes its own from a bright palette, which is what gives the
// patchwork look -- and it happens to suit a flat-shaded renderer perfectly,
// since each panel is already a single flat colour with its own shading.

const PATCH = [
  [246, 124,  36],   // orange
  [132,  86, 200],   // purple
  [ 48, 198, 198],   // teal
  [238,  92, 156],   // pink
  [250, 202,  52],   // yellow
  [ 58, 120, 214],   // blue
  [ 74, 188,  98],   // green
  [242, 242, 246],   // white
  [228,  68,  68],   // red
  [146, 208,  76],   // lime
  [255, 158, 186],   // rose
  [ 32, 158, 148],   // sea green
];

const CHAR   = [ 44,  40,  40];
const CHAR_B = [ 70,  64,  60];
const DOOR   = [ 36,  32,  40];   // the shaded arch of the doorway
const CAP    = [248, 248, 250];   // wheelhouse roof

// Walk the palette with a stride coprime to its length, so neighbouring
// panels never land on the same colour.
let patchN = 0;
const patch = () => PATCH[(patchN++ * 5) % PATCH.length];

// Stations along the hull, bow towards +z: how wide she is at the rail and at
// the keel, and how high the rail sits -- the sheer rising towards the bow.
const STATIONS = [
  { z: -0.80, rail: 0.30, keel: 0.11, ry: -0.30, ky: 0.17 },
  { z: -0.45, rail: 0.41, keel: 0.21, ry: -0.33, ky: 0.23 },
  { z: -0.05, rail: 0.45, keel: 0.23, ry: -0.36, ky: 0.24 },
  { z:  0.35, rail: 0.43, keel: 0.19, ry: -0.42, ky: 0.22 },
  { z:  0.66, rail: 0.33, keel: 0.11, ry: -0.51, ky: 0.16 },
  { z:  0.88, rail: 0.11, keel: 0.04, ry: -0.58, ky: 0.09 },
];

function buildBoat(burnt) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);
  patchN = burnt ? 0 : 3;              // a different shuffle for each build
  const col = () => (burnt ? (patchN++ % 2 ? CHAR : CHAR_B) : patch());

  // Hull: loft the sides and bottom between adjacent stations.
  const rail = [], keel = [];
  for (const st of STATIONS) {
    rail.push([v(-st.rail, st.ry, st.z), v(st.rail, st.ry, st.z)]);
    keel.push([v(-st.keel, st.ky, st.z), v(st.keel, st.ky, st.z)]);
  }

  for (let i = 0; i < STATIONS.length - 1; i++) {
    // Port and starboard topsides.
    facet(m, [rail[i][0], rail[i + 1][0], keel[i + 1][0], keel[i][0]], col());
    facet(m, [rail[i][1], rail[i + 1][1], keel[i + 1][1], keel[i][1]], col());
    // Bottom.
    facet(m, [keel[i][0], keel[i + 1][0], keel[i + 1][1], keel[i][1]], col());
    // Deck, inside the rail.
    facet(m, [rail[i][0], rail[i + 1][0], rail[i + 1][1], rail[i][1]], col());
  }
  // Transom across the stern.
  facet(m, [rail[0][0], rail[0][1], keel[0][1], keel[0][0]], col());

  // Wheelhouse, a tall block forward of amidships with an arched doorway.
  const hx = 0.30, hz0 = -0.28, hz1 = 0.30, hTop = -0.92, hBot = -0.34;
  const wh = [
    v(-hx, hTop, hz0), v(hx, hTop, hz0), v(hx, hTop, hz1), v(-hx, hTop, hz1),
    v(-hx, hBot, hz0), v(hx, hBot, hz0), v(hx, hBot, hz1), v(-hx, hBot, hz1),
  ];
  facet(m, [wh[0], wh[1], wh[2], wh[3]], burnt ? CHAR : CAP);   // roof
  facet(m, [wh[0], wh[1], wh[5], wh[4]], col());                // aft face
  facet(m, [wh[1], wh[2], wh[6], wh[5]], col());                // starboard
  facet(m, [wh[0], wh[3], wh[7], wh[4]], col());                // port
  facet(m, [wh[3], wh[2], wh[6], wh[7]], col());                // forward face

  if (!burnt) {
    // The doorway: a dark opening with a squared arch, set into the front.
    const dz = hz1 + 0.006;
    facet(m, [v(-0.12, -0.44, dz), v(0.12, -0.44, dz),
              v(0.12, -0.34, dz), v(-0.12, -0.34, dz)], DOOR);
    facet(m, [v(-0.12, -0.44, dz), v(0.12, -0.44, dz), v(0.00, -0.60, dz)], DOOR);
    // A band of trim round the base of the wheelhouse.
    for (const sgn of [1, -1]) {
      facet(m, [v(sgn * (hx + 0.006), -0.40, hz0), v(sgn * (hx + 0.006), -0.40, hz1),
                v(sgn * (hx + 0.006), -0.34, hz1), v(sgn * (hx + 0.006), -0.34, hz0)], patch());
    }
  }

  // Funnel, tall and set aft of the wheelhouse.
  const fx = 0.13, fz = -0.46;
  const fn = [
    v(-fx, -1.08, fz - fx), v(fx, -1.08, fz - fx), v(fx, -1.08, fz + fx), v(-fx, -1.08, fz + fx),
    v(-fx, -0.34, fz - fx), v(fx, -0.34, fz - fx), v(fx, -0.34, fz + fx), v(-fx, -0.34, fz + fx),
  ];
  facet(m, [fn[0], fn[1], fn[2], fn[3]], burnt ? CHAR : CAP);
  facet(m, [fn[0], fn[1], fn[5], fn[4]], col());
  facet(m, [fn[1], fn[2], fn[6], fn[5]], col());
  facet(m, [fn[0], fn[3], fn[7], fn[4]], col());
  facet(m, [fn[3], fn[2], fn[6], fn[7]], col());

  if (!burnt) {
    // A band round the funnel, in a different patch again.
    const b = fx + 0.008;
    for (const [a, c] of [[-b, 0], [b, 0]]) {
      facet(m, [v(a, -0.98, fz - fx), v(a, -0.98, fz + fx),
                v(a, -0.86, fz + fx), v(a, -0.86, fz - fx)], patch());
    }
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
    b.damage = 0;
    b.list = 0;
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
      cookOff(b, game);
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

    // A damaged hull smokes, lists further over, and loses way.
    if (b.damage > 0) {
      b.list += (b.listTarget - b.list) * 0.03;
      if ((b.sink = (b.sink | 0) + 1) % 9 === 0) {
        spawnSmoke(b.x, (SEA_LEVEL - TILE * 0.8) | 0, b.z);
      }
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
    damageBoat(b, game);
    hit++;
  }
  return hit;
}

function damageBoat(b, game) {
  b.damage++;

  if (b.damage >= BOAT_HP) {
    sinkBoat(b, game);
    return;
  }

  // Hurt, not finished. She lists, slows, and starts to burn.
  const mid = (SEA_LEVEL - TILE * 0.5) | 0;
  spawnExplosion(b.x, mid, b.z, 18, TILE * 0.032, null);
  spawnSparks(b.x, mid, b.z, 10);
  for (let i = 0; i < 12; i++) {
    const a = rnd() * Math.PI * 2, sp = TILE * (0.006 + rnd() * 0.012);
    spawn(b.x, SEA_LEVEL, b.z,
          Math.cos(a) * sp, -(TILE * 0.014 + rnd() * TILE * 0.02), Math.sin(a) * sp,
          [222, 238, 250], 28 + rndInt(20), P_GRAVITY | P_FADE, 2);
  }

  b.listTarget = (rndSigned() > 0 ? 1 : -1) * (0.16 + rnd() * 0.10);
  b.speed *= 0.45;
  b.sink = 0;
  game.onBoatHit(b.x, mid, b.z);
}

// Secondaries as she burns and settles -- fuel and stores letting go, each
// with its own fireball so the bangs have something to belong to.
function cookOff(b, game) {
  if (!b.secondaries || b.secondaries <= 0) return;
  if (--b.nextSec > 0) return;

  const jx = (b.x + rndSigned() * TILE * 0.55) | 0;
  const jz = (b.z + rndSigned() * TILE * 0.7) | 0;
  const jy = (SEA_LEVEL - TILE * (0.4 + rnd() * 0.7)) | 0;

  spawnExplosion(jx, jy, jz, 16 + rndInt(12), TILE * (0.03 + rnd() * 0.026), null);
  spawnSparks(jx, jy, jz, 10 + rndInt(8));
  // Steam where the fire meets the water.
  for (let i = 0; i < 6; i++) {
    const a = rnd() * Math.PI * 2, sp = TILE * (0.004 + rnd() * 0.01);
    spawn(jx, SEA_LEVEL, jz, Math.cos(a) * sp, -(TILE * 0.012 + rnd() * TILE * 0.014),
          Math.sin(a) * sp, [226, 238, 248], 26 + rndInt(20), P_GRAVITY | P_FADE, 2);
  }

  b.secondaries--;
  b.nextSec = 30 + rndInt(52);
  game.onSecondaryBlast();
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
  b.secondaries = 3 + rndInt(3);
  b.nextSec = 26 + rndInt(34);
  if (!b.listTarget) b.listTarget = rndSigned() > 0 ? 0.3 : -0.3;
  game.addScore(BOAT_SCORE);
  game.onBoatSunk(b.x, mid, b.z);
}

// --- drawing ---------------------------------------------------------------

const boatMat = new Float64Array(9);
const aimMat = new Float64Array(9);
const listMat = new Float64Array(9);

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

  let list = b.list || 0;
  if (b.state === SINKING) {
    const t = b.sink / SINK_TIME;
    list = (b.list || 0) + (b.listTarget || 0.3) * t * 1.6;
  }

  matFromAim(b.heading, pitch, aimMat);
  matRotZ(list, listMat);
  matMul(aimMat, listMat, boatMat);

  drawModel(rd, b.state === SINKING ? BOAT_WRECK : BOAT, boatMat,
            b.x, y, b.z, camX, camY, camZ);
}
