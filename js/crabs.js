// crabs.js -- shadow crabs: the one thing on the land that comes for you.
//
// Dark, low, many-legged things that scuttle about the dry ground, sideways
// as a crab does. Left alone they wander. Let the phoenix come down low near
// one and it notices -- its eyes are the only light it has -- and it
// scuttles at the bird with its claws up. A pinch does not kill: it takes a
// sixth of a full load of energy and throws the bird up and away, and the
// crab backs off for a moment before it will try again. It is the energy
// that kills, in the end, as everything does now.
//
// They can be beaten. Come down on one from above and it bursts into shadow.
// Only from above, and only coming down: sidle up to one low and level and
// it is the crab that gets the first word.
//
// Like the tanks they are a small pool, spawned in a ring round the bird on
// dry land and retired once it has left them far behind, so however far you
// fly there are only a handful being walked about.

import { TILE, matRotX, matRotY, matMul, matRotZ, rnd, rndSigned, rndInt } from './maths.js';
import { Model, facet, drawModel, drawShadow } from './model.js';
import { landAltitude, SEA_LEVEL, isOnLaunchpad, UNDERCARRIAGE_Y } from './landscape.js';
import { spawn, spawnSparks, P_RISE, P_GLOW, P_FADE } from './particles.js';

export const MAX_CRABS = 6;
export const CRAB_SCORE = 60;

const SPAWN_MIN = 10 * TILE;     // ring in which new ones appear
const SPAWN_MAX = 24 * TILE;
const RETIRE = 36 * TILE;        // ... and beyond which they are recycled
const PAD_CLEAR = 5;             // tiles: none closer than this to the pad
const PAD = [4, 4];

const WANDER = 0.012;            // tiles a frame: a slow sidle
const CHASE = 0.040;             // ... two tiles a second, at the bird
const NOTICE = 7;                // tiles across the ground it will see the bird from
const NOTICE_UP = 3;             // ... when the bird is no higher than this over it
const PINCH_REACH = 0.85;        // tiles, across the ground
const PINCH_UP = 0.9;            // tiles: the bird's feet within this of the ground there
const STOMP_REACH = 0.72;        // tiles: close enough over it to come down on it
const COOLDOWN = 150;            // frames a crab backs off after a pinch
const SNAP = 12;                 // frames the claws stay shut after one
// Before a pinch it stops and rears up, claws raised and open, for this
// long -- a fifth of a second and a bit -- and only pinches if the bird is
// still in reach at the end of it. It used to pinch the instant the bird
// came in range, which gave nothing to react to: now there is a moment to
// see it coming and get clear.
const WINDUP = 14;
// How long its claws stay raised after it has lost interest.
const RAISED_HOLD = 40;

// --- the model ---------------------------------------------------------------
//
// Units are tiles, ground at y = 0, up negative, facing +z. A shore crab: the
// shell wider than it is long, low and flat, with a spiked front edge; four
// walking legs a side, each two broad blades, hip to raised knee and knee
// down to the ground; two arms forward, one claw big and one small, as a
// shore crab's are; and two eyes on stalks, which make their own light -- by
// night they are all there is of it to see.
//
// Posed four ways at once: where it is in its stride, whether its claws are
// open or shut, and whether they are down, as it wanders, or raised, as it
// comes for you -- which is the one thing about a crab you need to be able to
// read from fifteen tiles away.
const SHELL = [56, 42, 80];
const SHELL_HI = [74, 56, 104];
const RIM = [36, 28, 54];
const LEG = [34, 27, 48];
const CLAW = [112, 42, 82];
const CLAW_TIP = [170, 58, 96];
const EYE = [255, 64, 96];
const S = 1.3;

function buildCrab(frame, shut, raised) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);

  // The shell: a low dome, wide across, on a dark rim.
  const SIDES = 6;
  const ring = (y, rx, rz) => {
    const r = [];
    for (let i = 0; i < SIDES; i++) {
      const a = (i / SIDES) * Math.PI * 2 + Math.PI / SIDES;
      r.push(v(Math.sin(a) * rx, y, Math.cos(a) * rz));
    }
    return r;
  };
  const r0 = ring(-0.10, 0.28, 0.18), r1 = ring(-0.16, 0.36, 0.24), r2 = ring(-0.23, 0.22, 0.14);
  const top = v(0, -0.26, -0.01);
  for (let i = 0; i < SIDES; i++) {
    const j = (i + 1) % SIDES;
    facet(m, [r0[i], r0[j], r1[j], r1[i]], RIM);
    facet(m, [r1[i], r1[j], r2[j], r2[i]], i === 0 || i === 5 ? SHELL_HI : SHELL);
    facet(m, [r2[i], r2[j], top], SHELL);
  }
  // Spikes along the front edge, either side of the eyes.
  for (const sx of [1, -1]) {
    facet(m, [v(sx * 0.20, -0.17, 0.20), v(sx * 0.30, -0.16, 0.12), v(sx * 0.33, -0.18, 0.22)], RIM);
    facet(m, [v(sx * 0.10, -0.18, 0.23), v(sx * 0.20, -0.17, 0.20), v(sx * 0.19, -0.19, 0.29)], RIM);
  }

  // The legs, in two sets that step in turn: while one is swinging forward
  // with its feet lifted, the other is on the ground pushing back.
  const phase = (frame / 4) * Math.PI * 2;
  const LEGS_Z = [0.10, 0.02, -0.06, -0.14];
  for (const sx of [1, -1]) {
    for (let k = 0; k < 4; k++) {
      const p = phase + (((k + (sx > 0 ? 0 : 1)) % 2) ? Math.PI : 0);
      const dz = Math.sin(p) * 0.06, lift = Math.max(0, Math.cos(p)) * 0.06;
      const z = LEGS_Z[k], spread = 1 + (k === 0 || k === 3 ? 0.08 : 0);
      const hipA = v(sx * 0.30, -0.13, z - 0.045), hipB = v(sx * 0.30, -0.13, z + 0.045);
      const kx = sx * 0.44 * spread, ky = -0.24, kz = z + dz * 0.5 + (z * 0.4);
      const knee = v(kx, ky, kz);
      const kneeA = v(kx, ky, kz - 0.035), kneeB = v(kx, ky, kz + 0.035);
      const tip = v(sx * 0.55 * spread, -lift, z + dz + z * 0.7);
      facet(m, [hipA, hipB, knee], LEG);
      facet(m, [kneeA, kneeB, tip], LEG);
    }
  }

  // The arms and claws: the big one on the right. Down in front of it as it
  // wanders; raised high and forward, open, as it comes at you.
  const gap = shut ? 0.015 : 0.14;
  for (const sx of [1, -1]) {
    const k = sx > 0 ? 1.35 : 0.95;
    const lift = raised ? 0.20 : 0;
    const shA = v(sx * 0.16, -0.13, 0.17), shB = v(sx * 0.22, -0.17, 0.17);
    const el = v(sx * 0.36, -0.22 - lift * 0.6, 0.28 + lift * 0.1);
    const elA = v(sx * 0.33, -0.20 - lift * 0.6, 0.28 + lift * 0.1), elB = v(sx * 0.39, -0.25 - lift * 0.6, 0.28 + lift * 0.1);
    const bx = sx * 0.27, by = -0.21 - lift, bz = 0.42 + lift * 0.15;
    const base = v(bx, by, bz);
    facet(m, [shA, shB, el], LEG);
    facet(m, [elA, elB, base], CLAW);
    // The palm, a closed wedge, so it reads as a lump from any side.
    const w = 0.08 * k, hU = 0.09 * k, hD = 0.06 * k;
    const back = v(bx, by, bz - 0.07 * k);
    const pL = v(bx - w, by, bz + 0.03), pR = v(bx + w, by, bz + 0.03);
    const pU = v(bx, by - hU, bz + 0.04), pD = v(bx, by + hD, bz + 0.04);
    facet(m, [back, pL, pU], CLAW); facet(m, [back, pU, pR], CLAW);
    facet(m, [back, pR, pD], CLAW); facet(m, [back, pD, pL], CLAW);
    facet(m, [pL, pU, pR, pD], CLAW);
    // The two jaws, opening up and down.
    const jA = v(bx - 0.055 * k, by - 0.03, bz + 0.04), jB = v(bx + 0.055 * k, by - 0.03, bz + 0.04);
    facet(m, [jA, jB, v(bx, by - 0.03 - gap * k, bz + 0.28 * k)], CLAW_TIP);
    const kA = v(bx - 0.045 * k, by + 0.02, bz + 0.04), kB = v(bx + 0.045 * k, by + 0.02, bz + 0.04);
    facet(m, [kA, kB, v(bx, by + 0.02 + gap * 0.6 * k, bz + 0.22 * k)], CLAW_TIP);
  }

  // Eyes on stalks, lit.
  for (const sx of [1, -1]) {
    facet(m, [v(sx * 0.05, -0.23, 0.13), v(sx * 0.09, -0.23, 0.13), v(sx * 0.09, -0.40, 0.18)], LEG);
    // Two crossed diamonds, so there is an eye to see from any side.
    const ex = sx * 0.09, ey = -0.42, ez = 0.19, e = 0.045;
    m.faces.push({ idx: [v(ex, ey - e, ez), v(ex + e, ey, ez), v(ex, ey + e, ez), v(ex - e, ey, ez)], col: EYE, glow: true });
    m.faces.push({ idx: [v(ex, ey - e, ez), v(ex, ey, ez + e), v(ex, ey + e, ez), v(ex, ey, ez - e)], col: EYE, glow: true });
  }
  return m;
}

// POSES[stride][shut][raised]
const POSES = [0, 1, 2, 3].map((f) => [false, true].map((shut) =>
  [false, true].map((raised) => buildCrab(f, shut, raised))));
export const CRAB_MODEL = POSES[0][0][0];

// --- state -------------------------------------------------------------------

const crabs = [];
for (let i = 0; i < MAX_CRABS; i++) crabs.push({ live: false });

export function resetCrabs() {
  for (const c of crabs) c.live = false;
}

export function crabCount() {
  return crabs.reduce((n, c) => n + (c.live ? 1 : 0), 0);
}

// Dry, and not the pad: the one place a crab never goes, so the bird always
// has somewhere to sit and charge in peace.
function walkable(x, z) {
  return landAltitude(x, z) < SEA_LEVEL - TILE * 0.15 && !isOnLaunchpad(x, z);
}

function nearPad(x, z) {
  const dx = (((x - PAD[0] * TILE) | 0) / TILE), dz = (((z - PAD[1] * TILE) | 0) / TILE);
  return dx * dx + dz * dz < PAD_CLEAR * PAD_CLEAR;
}

function place(c, px, pz) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = rnd() * Math.PI * 2;
    const r = SPAWN_MIN + rnd() * (SPAWN_MAX - SPAWN_MIN);
    const x = (px + Math.cos(a) * r) | 0;
    const z = (pz + Math.sin(a) * r) | 0;
    if (!walkable(x, z) || nearPad(x, z)) continue;
    c.live = true;
    c.x = x; c.z = z;
    c.h = rnd() * Math.PI * 2;           // which way it faces
    c.side = rnd() < 0.5 ? 1 : -1;       // ... and which way it is sidling
    c.turn = 40 + rndInt(160);
    c.gait = rnd() * 4;
    c.cool = 0;
    c.snap = 0;
    c.chasing = false;
    c.windup = 0;
    c.raised = 0;
    c.moving = false;
    return true;
  }
  return false;
}

// --- update ------------------------------------------------------------------

export function updateCrabs(player, game) {
  const px = player.x, pz = player.z;
  for (const c of crabs) {
    if (!c.live) {
      if (rnd() < 0.01) place(c, px, pz);
      continue;
    }
    const dx = ((px - c.x) | 0) / TILE, dz = ((pz - c.z) | 0) / TILE;
    const across = Math.hypot(dx, dz);
    if (across * TILE > RETIRE) { c.live = false; continue; }

    if (c.cool > 0) c.cool--;
    if (c.snap > 0) c.snap--;

    const ground = landAltitude(c.x, c.z);
    const up = (ground - (player.y + UNDERCARRIAGE_Y)) / TILE;   // the bird's feet over its ground
    const live = !player.dead && player.launched;

    // Coming down on it from above squashes it.
    if (live && across < STOMP_REACH && up > 0 && up < 0.5 && player.vy > TILE * 0.004 && !player.landed) {
      squash(c, ground, game);
      continue;
    }

    // Close enough and low enough: it rears up for a pinch (see WINDUP),
    // and pinches if the bird is still there when it comes down. Never while
    // the bird is still in its first few seconds, and never on the pad.
    const inReach = live && across < PINCH_REACH && up < PINCH_UP &&
      !player.protected && !(player.landed && isOnLaunchpad(px, pz));
    if (c.windup > 0) {
      if (--c.windup === 0) {
        c.cool = COOLDOWN;
        c.snap = SNAP;
        if (inReach) {
          spawnSparks(player.x, player.y, player.z, 6);
          game.onPinched(c);
        }
      }
      continue;
    }
    if (inReach && c.cool === 0) {
      c.windup = WINDUP;
      c.raised = RAISED_HOLD;
      c.snap = 0;
      c.moving = false;
      continue;
    }
    if (c.raised > 0) c.raised--;

    // What it wants: the bird if it has seen it and is not backing off,
    // otherwise wherever it was going.
    const was = c.chasing;
    c.chasing = live && c.cool === 0 && across < NOTICE && up < NOTICE_UP;
    // It has just seen the bird: a clatter of claws, which is the warning.
    if (c.chasing && !was && game.onCrabNotice) game.onCrabNotice(c, across);
    let speed = WANDER;
    if (c.chasing) {
      c.raised = RAISED_HOLD;
      // Sideways at it: its side points along the way it wants to go.
      const bearing = Math.atan2(dx, dz);
      const want = bearing - Math.PI / 2;
      let d = want - c.h;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      c.h += Math.max(-0.08, Math.min(0.08, d));
      c.side = 1;
      speed = across > 0.35 ? CHASE : 0;
      // Claws working as it comes.
      if ((c.gait | 0) % 3 === 0 && c.snap === 0 && rnd() < 0.05) c.snap = 6;
    } else if (c.cool > COOLDOWN - 60) {
      // Just pinched: straight back off, away from the bird.
      const bearing = Math.atan2(-dx, -dz);
      c.h = bearing - Math.PI / 2;
      c.side = 1;
      speed = CHASE * 0.8;
    } else if (--c.turn <= 0) {
      c.h += rndSigned() * 0.9;
      if (rnd() < 0.4) c.side = -c.side;
      c.turn = 50 + rndInt(180);
    }

    // Move along its own side, turning back from the water and the pad.
    const mx = Math.cos(c.h) * c.side, mz = -Math.sin(c.h) * c.side;
    const nx = (c.x + mx * speed * TILE) | 0, nz = (c.z + mz * speed * TILE) | 0;
    c.moving = false;
    if (speed > 0 && walkable(nx, nz)) {
      c.x = nx; c.z = nz;
      c.gait = (c.gait + speed * 14) % 4;
      c.moving = true;
    } else if (speed > 0) {
      c.side = -c.side;
      c.h += rndSigned() * 0.6;
      c.turn = 30 + rndInt(60);
    }
  }
}

// Burst into shadow: a puff of dark smoke and a few embers from its eyes.
const SMOKE = [[40, 30, 58], [26, 20, 38], [58, 44, 80]];
function squash(c, ground, game) {
  c.live = false;
  const y = (ground - TILE * 0.2) | 0;
  for (let i = 0; i < 26; i++) {
    spawn(c.x, y, c.z, rndSigned() * TILE * 0.03, -rnd() * TILE * 0.03, rndSigned() * TILE * 0.03,
      SMOKE[i % SMOKE.length], 40 + ((rnd() * 30) | 0), P_RISE | P_FADE, 2);
  }
  for (let i = 0; i < 8; i++) {
    spawn(c.x, y, c.z, rndSigned() * TILE * 0.02, -rnd() * TILE * 0.04, rndSigned() * TILE * 0.02,
      EYE, 30 + ((rnd() * 20) | 0), P_RISE | P_GLOW, 1);
  }
  game.onCrabSquashed(c);
}

// --- drawing -----------------------------------------------------------------

export function crabsInRow(zLo, zHi, out) {
  for (const c of crabs) {
    if (c.live && c.z >= zLo && c.z < zHi) out.push(c);
  }
  return out;
}

const rot = new Float64Array(9), tip = new Float64Array(9), mat = new Float64Array(9);
const back = new Float64Array(9), mat2 = new Float64Array(9);

export function drawCrab(rd, c, camX, camY, camZ, fog = 0, row = 0) {
  const ground = landAltitude(c.x, c.z);
  // A pool of shadow under it, wider than it is: it is a shadow thing.
  drawShadow(rd, c.x, c.z, TILE * 0.55, 0.75, camX, camY, camZ, row, fog, 0);
  // Tipped across the slope it stands on, side to side, so its legs meet the
  // ground on a hillside.
  const d = TILE * 0.4;
  const sx = Math.cos(c.h), sz = -Math.sin(c.h);
  const a = landAltitude((c.x + sx * d) | 0, (c.z + sz * d) | 0);
  const b = landAltitude((c.x - sx * d) | 0, (c.z - sz * d) | 0);
  matRotY(c.h, rot);
  matRotZ(Math.atan2(a - b, 2 * d), tip);
  matMul(rot, tip, mat);
  // Rearing for a pinch: tipped back, claws up and open. Walking: a bob
  // with each step.
  const rear = c.windup > 0 ? Math.min(1, (WINDUP - c.windup + 1) / 5) : 0;
  if (rear > 0) {
    matRotX(0.35 * rear, back);
    matMul(mat, back, mat2);
    mat.set(mat2);
  }
  const bob = c.moving ? Math.abs(Math.sin(c.gait * Math.PI)) * 0.025 * TILE : 0;
  const pose = POSES[(c.gait | 0) & 3][c.snap > 0 ? 1 : 0][c.raised > 0 || rear > 0 ? 1 : 0];
  drawModel(rd, pose, mat, c.x, (ground - bob - rear * 0.06 * TILE) | 0, c.z, camX, camY, camZ, fog);
}
