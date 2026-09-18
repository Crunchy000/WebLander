// boats.js -- vessels patrolling the sea.
//
// Unarmed now, and staying. They are the one moving thing left in the world:
// something to fly out to, circle, and leave alone.
//
// The sea covers a good deal of the map and until now did nothing at all, so
// these give it a reason to be flown over. They work like the tanks -- a small
// recycled pool spawned in a ring around the player -- but the water changes
// the character of them: there is no terrain to hide behind, so they are easy
// to spot and easy to line up on, and the interest is in the sinking rather
// than the hunt.

import { TILE, matFromAim, matMul, matRotZ, rnd, rndSigned, rndInt } from './maths.js';
import { Model, facet, drawModel, recolour, silhouetteAmount } from './model.js';
import { sky, beacon } from './daylight.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { depthAt, waveLift } from './sea.js';
import { spawnExplosion, spawnSparks, spawnSmoke, spawn, P_GRAVITY, P_FADE } from './particles.js';
import { project } from './renderer.js';

export const MAX_BOATS = 6;
export const BOAT_SCORE = 400;

// Hulls take two bombs. One puts her down by the head, smoking and slowed;
// the second finishes her. A ship should cost more than a tank to kill.
export const BOAT_HP = 2;

// Everything scales from here, so the whole vessel grows in one place. A
// canoe is a smaller thing than a tug, and longer for her beam.
const S = 1.05;

const SPAWN_MIN = 15 * TILE;
const SPAWN_MAX = 30 * TILE;
const RETIRE = 48 * TILE;
const HIT_RADIUS = 1.45;        // a bigger target than a tank
const BLAST_RADIUS = 2.8;
const SINK_TIME = 260;          // frames from hit to gone
const CLEARANCE = 2.2 * TILE;   // open water needed around a spawn

// --- models ----------------------------------------------------------------

// A wooden canoe.
//
// What was here was a patchwork tug: a stubby hull, a wheelhouse, a funnel,
// and every facet taking its own colour from a twelve-colour palette so that
// no two panels matched. It was the best thing in the game to look at when
// the game was about knocking things over, and it is the wrong boat entirely
// for a sea you now fly across and leave alone. Twelve saturated colours on
// the only moving object in the world is not a quiet sea.
//
// A canoe instead: long, narrow, open, double-ended, and made of one material
// in three tones. It is also a better shape for this renderer -- a hull with
// no deckhouse on it is read entirely by its sheer line, which is exactly
// what a flat-shaded lofted surface is good at.
const WOOD_UP  = [172, 134,  96];   // cedar, the strake above the wale
const WOOD_LO  = [142, 106,  74];   // and the one below it
const WOOD_BOT = [ 98,  74,  56];   // the wetted bottom, darker for being wet
const INSIDE   = [ 92,  70,  52];   // you look down into an open boat, and it
                                    // is in shadow: the face is almost sky-facing,
                                    // so it takes the brightest facet multiplier
                                    // going and has to start dark to end up dark
const THWART   = [196, 170, 132];   // pale ash, across the beam
const PACK     = [168, 158, 138];   // a canvas bundle amidships
const LANTERN  = [ 78,  70,  62];
const CAP      = [246, 236, 208];   // the lantern glass, unlit

const CHAR   = [ 44,  40,  40];
const CHAR_B = [ 70,  64,  60];

// Where the lantern glass is, worked out while the hull is being built --
// facet() shades a colour before it stores it, so these faces cannot be found
// afterwards by looking for CAP.
const capFaces = [];

// Stations along the hull, bow towards +z. Three widths at each: the rail,
// the wale a third of the way down, and the keel. Two strakes a side rather
// than one, because planking is what says "wooden" before any colour does --
// and a single face from rail to keel reads as a moulded shell.
//
// Double-ended, and both ends lift well clear of the water, which is the line
// that makes a canoe a canoe. The bow lifts a fraction more than the stern,
// which is the only asymmetry in her and is there so you can tell which way
// she is pointing.
const STATIONS = [
  { z: -1.05, rail: 0.035, wale: 0.030, keel: 0.020, ry: -0.34, wy: -0.16, ky: -0.02 },
  { z: -0.74, rail: 0.140, wale: 0.120, keel: 0.055, ry: -0.21, wy: -0.08, ky:  0.07 },
  { z: -0.36, rail: 0.210, wale: 0.180, keel: 0.085, ry: -0.16, wy: -0.04, ky:  0.12 },
  { z:  0.02, rail: 0.230, wale: 0.200, keel: 0.095, ry: -0.15, wy: -0.03, ky:  0.13 },
  { z:  0.40, rail: 0.210, wale: 0.180, keel: 0.085, ry: -0.16, wy: -0.04, ky:  0.12 },
  { z:  0.78, rail: 0.140, wale: 0.120, keel: 0.055, ry: -0.22, wy: -0.08, ky:  0.07 },
  { z:  1.08, rail: 0.035, wale: 0.030, keel: 0.020, ry: -0.36, wy: -0.17, ky: -0.02 },
];

function buildBoat(burnt) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);
  // Everything is the same timber when she has burnt, in two tones so the
  // planking still reads.
  let n = 0;
  const wood = (col) => (burnt ? (n++ % 2 ? CHAR : CHAR_B) : col);

  const box = (x0, y0, z0, x1, y1, z1, col) => {
    const q = [
      v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1),
      v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1),
    ];
    facet(m, [q[0], q[1], q[2], q[3]], col);
    facet(m, [q[4], q[5], q[6], q[7]], col);
    facet(m, [q[0], q[1], q[5], q[4]], col);
    facet(m, [q[3], q[2], q[6], q[7]], col);
    facet(m, [q[1], q[2], q[6], q[5]], col);
    facet(m, [q[0], q[3], q[7], q[4]], col);
  };

  // Loft the three lines the length of her.
  const rail = [], wale = [], keel = [];
  for (const st of STATIONS) {
    rail.push([v(-st.rail, st.ry, st.z), v(st.rail, st.ry, st.z)]);
    wale.push([v(-st.wale, st.wy, st.z), v(st.wale, st.wy, st.z)]);
    keel.push([v(-st.keel, st.ky, st.z), v(st.keel, st.ky, st.z)]);
  }

  for (let i = 0; i < STATIONS.length - 1; i++) {
    for (const side of [0, 1]) {
      // Upper strake, then lower.
      facet(m, [rail[i][side], rail[i + 1][side], wale[i + 1][side], wale[i][side]],
            wood(WOOD_UP));
      facet(m, [wale[i][side], wale[i + 1][side], keel[i + 1][side], keel[i][side]],
            wood(WOOD_LO));
    }
    // The bottom, and the inside of her seen over the rail.
    facet(m, [keel[i][0], keel[i + 1][0], keel[i + 1][1], keel[i][1]], wood(WOOD_BOT));
    facet(m, [rail[i][0], rail[i + 1][0], rail[i + 1][1], rail[i][1]], wood(INSIDE));
  }

  // Thwarts: three of them, sitting just under the rail where they belong,
  // and the only pale thing aboard. They are also what stops the inside
  // reading as a painted trough.
  for (const [z, w] of [[-0.52, 0.195], [0.04, 0.222], [0.56, 0.195]]) {
    box(-w, -0.182, z - 0.038, w, -0.144, z + 0.038, wood(THWART));
  }

  // A canvas bundle amidships. Something to be carrying, and it gives her a
  // little height to be read by at a distance.
  box(-0.125, -0.28, -0.38, 0.125, -0.165, -0.12, wood(PACK));

  // A lantern on the foredeck. The tug had a masthead light and a funnel top
  // that warmed at night; a canoe has neither, but the wink is worth keeping
  // -- it is how you find her on a dark sea -- so she carries a lamp.
  box(-0.05, -0.30, 0.66, 0.05, -0.20, 0.76, wood(LANTERN));
  facet(m, [v(-0.05, -0.31, 0.66), v(0.05, -0.31, 0.66),
            v(0.05, -0.31, 0.76), v(-0.05, -0.31, 0.76)], burnt ? CHAR : CAP);
  if (!burnt) capFaces.push(m.faces.length - 1);

  return m;
}

const BOAT = buildBoat(false);
const BOAT_WRECK = buildBoat(true);

// Running lights used to be lamps: screen-space squares with a halo round
// them, hung off the hull. At this resolution that reads as a sticker rather
// than as light. Instead the lantern glass warms for a few frames -- from a
// distance it is a wink somewhere on the water, which is all a light on a
// small boat ever is.
const LAMP = [255, 238, 176];

const BOAT_LIT = (() => {
  const m = recolour(BOAT, () => null);
  for (const i of capFaces) m.faces[i] = { idx: BOAT.faces[i].idx, col: LAMP, glow: true };
  return m;
})();

// Slower than the drone's, and offset per vessel so a crowded sea does not
// pulse in unison.
const BLINK_PERIOD = 78;
const BLINK_FLASH = 5;

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
    b.blinkAt = rndInt(BLINK_PERIOD);   // and where she is in her blink
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
      // The moment the deck goes under, she takes a last gulp: a ring of
      // spray thrown up as the hull displaces, then foam closing over.
      if (!b.wentUnder && b.sink >= SINK_TIME * 0.72) {
        b.wentUnder = true;
        for (let i = 0; i < 30; i++) {
          const a = rnd() * Math.PI * 2, r = (0.3 + rnd() * 0.8) * TILE;
          spawn((b.x + Math.cos(a) * r) | 0, SEA_LEVEL, (b.z + Math.sin(a) * r) | 0,
                Math.cos(a) * TILE * (0.004 + rnd() * 0.010),
                -(TILE * 0.018 + rnd() * TILE * 0.026),
                Math.sin(a) * TILE * (0.004 + rnd() * 0.010),
                [230, 244, 252], 30 + rndInt(26), P_GRAVITY | P_FADE, 2);
        }
        game.onShipGoesUnder(b.x, SEA_LEVEL, b.z);
      }

      if (b.sink >= SINK_TIME) {
        // Gone. Leave a patch of foam closing over where she was.
        for (let i = 0; i < 18; i++) {
          const a = rnd() * Math.PI * 2, r = rnd() * TILE * 1.0;
          spawn((b.x + Math.cos(a) * r) | 0, SEA_LEVEL, (b.z + Math.sin(a) * r) | 0,
                Math.cos(a) * TILE * 0.004, -rnd() * TILE * 0.006, Math.sin(a) * TILE * 0.004,
                [226, 240, 250], 34 + rndInt(26), P_GRAVITY | P_FADE, 2);
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
  b.wentUnder = false;
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

export function drawBoat(rd, b, camX, camY, camZ, fog = 0) {
  // She rides the same swell the sea is drawn with, so a vessel lifts on the
  // crest the water under her is on rather than sitting at a fixed height
  // while it moves around her.
  const heave = waveLift(b.x, b.z, depthAt(b.x, b.z));
  let y = (SEA_LEVEL + heave) | 0;
  let pitch = Math.sin(b.phase) * 0.035;          // gentle scend

  if (b.state === SINKING) {
    const t = b.sink / SINK_TIME;
    // Down by the stern, steepening, and under she goes.
    pitch = -0.05 - t * 0.85;
    y = (SEA_LEVEL + heave + t * t * TILE * 1.9) | 0;
  }

  let list = b.list || 0;
  if (b.state === SINKING) {
    const t = b.sink / SINK_TIME;
    list = (b.list || 0) + (b.listTarget || 0.3) * t * 1.6;
  }

  matFromAim(b.heading, pitch, aimMat);
  matRotZ(list, listMat);
  matMul(aimMat, listMat, boatMat);

  // A sinking vessel keeps her light showing until she goes under, which is a
  // good deal more affecting than switching it off the moment she is hit.
  let hull = BOAT;
  if (b.state === SINKING) {
    hull = BOAT_WRECK;
  } else if (sky.lamp > 0.05 && beacon(BLINK_PERIOD, BLINK_FLASH, b.blinkAt | 0)) {
    hull = BOAT_LIT;
  }

  // The same treatment as everything else standing in the world: a boat
  // crossing the front of the view goes to a flat shape rather than staying
  // lit while the trees either side of her have gone dark.
  const sil = silhouetteAmount((b.x - camX) / TILE, (b.z - camZ) / TILE);
  drawModel(rd, hull, boatMat, b.x, y, b.z, camX, camY, camZ, fog, sil);
}
