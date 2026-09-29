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
import { Model, facet, drawModel, drawShadow, recolour } from './model.js';
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
// Units are tiles, ground at y = 0, up negative, facing +z. Chunky and low-
// poly: a tall faceted shell like a rounded box, two big eyes on its front
// face, two heavy claws each a block of a palm with two fingers -- dark along
// the edges that close on each other -- and short spiky legs, three a side.
//
// Posed four ways at once: where it is in its stride, whether its claws are
// open or shut, and whether they are down, as it wanders, or raised, as it
// comes for you -- which is the one thing about a crab you need to be able to
// read from fifteen tiles away.
const SHELL = [66, 50, 94];
const SHELL_TOP = [80, 62, 112];
const BELLY = [98, 84, 118];
const CLAW = [74, 56, 104];
const CLAW_DARK = [20, 15, 30];
const LEG = [48, 37, 70];
const EYE = [240, 236, 255];
const PUPIL = [14, 10, 22];
const S = 1.2;
const SHELL_MID = [0, -0.30, 0];

function buildCrab(frame, shut, raised, under = false) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);
  // Every face is wound to face out from the middle of its own part -- the
  // shell, a leg, an arm, a palm, a finger -- so the model can say it is
  // solid and the faces turned away from the camera are skipped rather than
  // sorted and drawn to be painted over. About half of them, at any angle.
  const out = (idx, c) => {
    const w = m.verts, i0 = idx[0] * 3, i1 = idx[1] * 3, i2 = idx[2] * 3;
    const ax = w[i1] - w[i0], ay = w[i1 + 1] - w[i0 + 1], az = w[i1 + 2] - w[i0 + 2];
    const bx = w[i2] - w[i0], by = w[i2 + 1] - w[i0 + 1], bz = w[i2 + 2] - w[i0 + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const dot = nx * (w[i0] - c[0] * S * TILE) + ny * (w[i0 + 1] - c[1] * S * TILE) + nz * (w[i0 + 2] - c[2] * S * TILE);
    return dot < 0 ? idx.slice().reverse() : idx;
  };
  const F = (idx, col, c) => facet(m, out(idx, c), col);

  // The shell: three rings of a box with its corners cut, and a top.
  const ring = (y, w, d, c) => [
    [w, d * (1 - c)], [w * (1 - c), d], [-w * (1 - c), d], [-w, d * (1 - c)],
    [-w, -d * (1 - c)], [-w * (1 - c), -d], [w * (1 - c), -d], [w, -d * (1 - c)],
  ].map(([x, z]) => v(x, y, z));
  const R = [
    { y: -0.12, w: 0.24, d: 0.20, c: 0.35 },
    { y: -0.32, w: 0.32, d: 0.27, c: 0.35 },
    { y: -0.48, w: 0.23, d: 0.19, c: 0.40 },
  ];
  const rings = R.map((r) => ring(r.y, r.w, r.d, r.c));
  for (let k = 0; k < 2; k++) {
    const A = rings[k], B = rings[k + 1];
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      F([A[i], A[j], B[j], B[i]], k ? SHELL_TOP : SHELL, SHELL_MID);
    }
  }
  // The top, flat, as one face. (Faces are what cost here, drawn on the
  // CPU with the JIT off; so what cannot be seen from the chase camera --
  // undersides, mostly -- is not built at all.)
  F(rings[2].slice(), SHELL_TOP, SHELL_MID);
  // ... and, for a crab thrown on its back, everything underneath: the
  // belly plate, and the undersides of the legs, the arms, the palms and the
  // lower fingers. Upright it is never seen, so it is only in those poses.
  if (under) F(rings[0].slice(), BELLY, SHELL_MID);

  // The eyes, on the front face of the upper band: a white square each,
  // lit, with a dark pupil low and to the inside, both a hair proud of it.
  {
    const a = R[1], b = R[2];
    const ny = -(a.d - b.d), nz = a.y - b.y;              // outward: forward and up
    const nl = Math.hypot(ny, nz);
    const on = (u, t, out) => {
      const w = (a.w * (1 - a.c)) * (1 - t) + (b.w * (1 - b.c)) * t;
      return v(u * w, a.y + (b.y - a.y) * t + (ny / nl) * out, a.d + (b.d - a.d) * t + (nz / nl) * out);
    };
    for (const sx of [1, -1]) {
      const q = (u0, u1, t0, t1, out) => sx > 0
        ? [on(u0, t0, out), on(u1, t0, out), on(u1, t1, out), on(u0, t1, out)]
        : [on(-u1, t0, out), on(-u0, t0, out), on(-u0, t1, out), on(-u1, t1, out)];
      m.faces.push({ idx: out(q(0.07, 0.76, 0.08, 0.97, 0.012), SHELL_MID), col: EYE, glow: true });
      F(q(0.10, 0.36, 0.12, 0.62, 0.024), PUPIL, SHELL_MID);
    }
  }

  // The legs: short spikes out and down from the back half of the shell,
  // three a side, in two sets that step in turn.
  const phase = (frame / 4) * Math.PI * 2;
  const LEGS_Z = [0.04, -0.07, -0.18];
  for (const sx of [1, -1]) {
    for (let k = 0; k < 3; k++) {
      const p = phase + (((k + (sx > 0 ? 0 : 1)) % 2) ? Math.PI : 0);
      const dz = Math.sin(p) * 0.06, lift = Math.max(0, Math.cos(p)) * 0.05;
      const z = LEGS_Z[k], hx = sx * 0.27, hy = -0.17;
      const h0 = v(hx, hy - 0.04, z), h1 = v(hx, hy + 0.03, z - 0.035), h2 = v(hx, hy + 0.03, z + 0.035);
      const tip = v(sx * 0.50, -lift, z + dz - 0.05 - k * 0.03);
      const lc = [(hx + sx * 0.50) / 2, (hy - lift) / 2, z];
      F([h2, h0, tip], LEG, lc);
      F([h0, h1, tip], LEG, lc);
      if (under) F([h1, h2, tip], LEG, lc);
    }
  }

  // The claws. Down in front of it as it wanders; raised high and forward
  // as it comes at you.
  const gap = shut ? 0.0 : 0.10;
  const lift = raised ? 0.16 : 0;
  for (const sx of [1, -1]) {
    // A three-sided arm from the shoulder, through the elbow, to the palm.
    const tri = (x, y, z, r) => [v(x, y - r, z), v(x + sx * r, y + r * 0.6, z), v(x - sx * r, y + r * 0.6, z)];
    const sh = tri(sx * 0.26, -0.24, 0.16, 0.05);
    const el = tri(sx * 0.42, -0.24 - lift * 0.5, 0.28 + lift * 0.05, 0.05);
    const px = sx * 0.40, py = -0.26 - lift, pz = 0.44 + lift * 0.1;
    const wr = tri(px, py, pz - 0.08, 0.055);
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const shC = [sx * 0.26, -0.24, 0.16], elC = [sx * 0.42, -0.24 - lift * 0.5, 0.28 + lift * 0.05];
    for (const [A, B, c] of [[sh, el, mid(shC, elC)], [el, wr, mid(elC, [px, py, pz - 0.08])]]) {
      // Not the underside, between the two lower corners (1 and 2).
      for (const i of under ? [0, 1, 2] : [0, 2]) F([A[i], A[(i + 1) % 3], B[(i + 1) % 3], B[i]], CLAW, c);
    }
    // The palm: a block.
    const hx = 0.09, hy = 0.08, hz = 0.08;
    const o = sx * hx, n = -sx * hx;        // outer and inner x offsets
    const P = (dx, dy, dz) => v(px + dx, py + dy, pz + dz);
    const bOT = P(o, -hy, -hz), bIT = P(n, -hy, -hz), bOB = P(o, hy, -hz), bIB = P(n, hy, -hz);
    const fOT = P(o, -hy, hz), fIT = P(n, -hy, hz), fOB = P(o, hy, hz), fIB = P(n, hy, hz);
    const fOM = P(o, 0, hz), fIM = P(n, 0, hz);
    const pc = [px, py, pz];
    F([bOT, bIT, fIT, fOT], CLAW, pc);            // top
    F([bOT, bOB, fOB, fOT], CLAW, pc);            // outer side
    F([bIT, bIB, fIB, fIT], CLAW, pc);            // inner side
    F([bOT, bIT, bIB, bOB], CLAW, pc);            // back
    if (under) F([bOB, bIB, fIB, fOB], CLAW, pc);  // bottom
    // The two fingers, from the upper and lower halves of its front: pale
    // outside, dark on the edges that meet.
    const tU = P(-sx * 0.03, -0.02 - gap, hz + 0.22);
    const uc = [px - sx * 0.01, py - 0.04 - gap * 0.3, pz + hz + 0.07];
    F([fOT, fIT, tU], CLAW, uc);
    F([fIT, fIM, tU], CLAW, uc);
    F([fOM, fOT, tU], CLAW, uc);
    F([fIM, fOM, tU], CLAW_DARK, uc);
    const tL = P(-sx * 0.03, 0.02 + gap * 0.7, hz + 0.17);
    const lc2 = [px - sx * 0.01, py + 0.04 + gap * 0.2, pz + hz + 0.06];
    F([fOM, fIM, tL], CLAW_DARK, lc2);
    F([fIM, fIB, tL], CLAW, lc2);
    F([fOB, fOM, tL], CLAW, lc2);
    if (under) F([fIB, fOB, tL], CLAW, lc2);

  }
  m.solid = true;
  return m;
}

// POSES[stride][shut][raised]
const POSES = [0, 1, 2, 3].map((f) => [false, true].map((shut) =>
  [false, true].map((raised) => buildCrab(f, shut, raised))));
export const CRAB_MODEL = POSES[0][0][0];
// On its back: FLIPPED[stride][shut], with the underneath built.
const FLIPPED = [0, 1, 2, 3].map((f) => [false, true].map((shut) => buildCrab(f, shut, false, true)));

// --- the king ----------------------------------------------------------------
//
// The last flame is guarded. When the phoenix holds four, the king crab rises
// out of the ground at the fifth: more than twice the size of the others, in
// crimson, with a crown, and the flame floating over its shell. It keeps
// close to its flame, faces whatever comes, and pinches hard; it is too big
// to squash -- come down on it and the bird is thrown off its shell -- and
// it takes three fire bombs to overturn it. On its back, it lets the flame go.
const KING_S = 2.4;
const KING_HP = 3;
const KING_LEASH = 2.2;          // tiles from its flame it will go
const KING_NOTICE = 9;
const KING_SPEED = 0.03;
const KING_REACH = 1.9;          // tiles, across the ground, of its claws
const KING_UP = 2.0;             // ... and the bird's feet within this of the ground
const KING_BODY = 0.95;          // tiles: the shell, which the bird cannot be inside
const KING_TOP = 0.52 * S * KING_S;   // tiles: the top of its shell
const KING_WINDUP = 18;
const KING_COOL = 110;
const KING_BURST = 2.6;          // tiles: a fire bomb this close counts

// Crimson for the violet, the eyes left white.
const crimson = (c) => (c[0] > 200 ? null : [Math.min(255, Math.round(c[0] * 1.9 + 20)), Math.round(c[1] * 0.55), Math.round(c[2] * 0.6)]);
const KING_POSES = POSES.map((f) => f.map((sh) => sh.map((m) => recolour(m, crimson))));
const KING_FLIPPED = FLIPPED.map((f) => f.map((m) => recolour(m, crimson)));

// The crown: a gold band round the top of the shell with five points.
const GOLD = [238, 192, 84], GOLD_D = [196, 146, 52];
const CROWN = (() => {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);
  const N = 10, lo = [], hi = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    lo.push(v(Math.sin(a) * 0.16, -0.50, Math.cos(a) * 0.12));
    hi.push(v(Math.sin(a) * 0.17, -0.57, Math.cos(a) * 0.13));
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    facet(m, [lo[i], lo[j], hi[j], hi[i]], i % 2 ? GOLD : GOLD_D);
    if (i % 2 === 0) {
      const a = ((i + 1) / N) * Math.PI * 2;
      facet(m, [hi[i], hi[(i + 2) % N], v(Math.sin(a) * 0.19, -0.70, Math.cos(a) * 0.15)], GOLD);
    }
  }
  return m;
})();

const king = { live: false, king: true };

export function spawnKing(x, z, guard) {
  Object.assign(king, {
    live: true, x, z, hx: x, hz: z, h: 0, side: 1, gait: 0, snap: 0, windup: 0,
    cool: 60, raised: 40, flipped: 0, flipSide: 1, hp: KING_HP, hurt: 0, rise: 0,
    moving: false, scale: KING_S, guard,
  });
  // It comes up out of the ground in a burst of dust and shadow.
  const y = landAltitude(x, z);
  for (let i = 0; i < 40; i++) {
    const a = rnd() * Math.PI * 2, sp = TILE * (0.01 + rnd() * 0.02);
    spawn(x, y, z, Math.cos(a) * sp, -TILE * 0.01 * rnd(), Math.sin(a) * sp,
      SMOKE[i % SMOKE.length], 50 + ((rnd() * 30) | 0), P_RISE | P_FADE, 3);
  }
}

export function kingInfo() {
  return king.live ? king : null;
}

// A fire bomb bursting at (x, z). Returns the king's hits left if it was
// caught in it, or -1.
export function hitKing(x, z, reach = KING_BURST) {
  if (!king.live || king.flipped || king.rise < 1) return -1;
  const dx = ((king.x - x) | 0) / TILE, dz = ((king.z - z) | 0) / TILE;
  if (dx * dx + dz * dz > reach * reach) return -1;
  king.hp--;
  king.hurt = 24;
  king.snap = 10;
  king.windup = 0;
  king.cool = Math.max(king.cool, 50);
  if (king.hp <= 0) {
    king.flipped = 1;
    king.flipSide = rnd() < 0.5 ? 1 : -1;
  }
  return king.hp;
}

function updateKing(player, game) {
  const c = king;
  if (!c.live) return;
  if (c.rise < 1) { c.rise = Math.min(1, c.rise + 1 / 60); return; }
  if (c.flipped) {
    c.flipped++;
    c.gait = (c.gait + 0.25) % 4;
    if (rnd() < 0.06) c.snap = 6;
    return;
  }
  if (c.hurt > 0) c.hurt--;
  if (c.cool > 0) c.cool--;
  if (c.snap > 0) c.snap--;
  if (c.raised > 0) c.raised--;

  const dx = ((player.x - c.x) | 0) / TILE, dz = ((player.z - c.z) | 0) / TILE;
  const across = Math.hypot(dx, dz);
  const ground = landAltitude(c.x, c.z);
  const up = (ground - (player.y + UNDERCARRIAGE_Y)) / TILE;
  const live = !player.dead && player.launched;

  // Its shell: too big to squash. Coming down on it throws the bird off, and
  // nothing gets inside it.
  if (live && across < KING_BODY && up < KING_TOP + 0.3) {
    if (up > KING_TOP - 0.4 && player.vy > 0) {
      player.vy = (-TILE * 0.05) | 0;
      if (game && game.onKingBounce) game.onKingBounce();
    } else if (across > 0.01) {
      const k = KING_BODY / across;
      player.x = (c.x + dx * k * TILE) | 0;
      player.z = (c.z + dz * k * TILE) | 0;
    }
  }

  // A pinch: rear up, then close, if the bird is still there.
  const inReach = live && across < KING_REACH && up < KING_UP && !player.protected;
  if (c.windup > 0) {
    if (--c.windup === 0) {
      c.cool = KING_COOL;
      c.snap = SNAP;
      if (inReach) {
        spawnSparks(player.x, player.y, player.z, 10);
        game.onPinched(c);
      }
    }
    return;
  }
  if (inReach && c.cool === 0) {
    c.windup = KING_WINDUP;
    c.raised = RAISED_HOLD;
    c.moving = false;
    return;
  }

  // Face whatever comes near, and go to meet it -- never far from the flame.
  const sees = live && across < KING_NOTICE && up < 6;
  let tx = c.hx, tz = c.hz;
  if (sees) {
    c.raised = RAISED_HOLD;
    let ox = ((player.x - c.hx) | 0) / TILE, oz = ((player.z - c.hz) | 0) / TILE;
    const ol = Math.hypot(ox, oz);
    if (ol > KING_LEASH) { ox *= KING_LEASH / ol; oz *= KING_LEASH / ol; }
    tx = (c.hx + ox * TILE) | 0; tz = (c.hz + oz * TILE) | 0;
    const want = Math.atan2(dx, dz);
    let d = want - c.h;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    c.h += Math.max(-0.05, Math.min(0.05, d));
  }
  const mx = ((tx - c.x) | 0) / TILE, mz = ((tz - c.z) | 0) / TILE;
  const ml = Math.hypot(mx, mz);
  c.moving = ml > 0.2;
  if (c.moving) {
    const step = Math.min(ml, KING_SPEED);
    c.x = (c.x + (mx / ml) * step * TILE) | 0;
    c.z = (c.z + (mz / ml) * step * TILE) | 0;
    c.gait = (c.gait + step * 10) % 4;
  }
}

// --- state -------------------------------------------------------------------

const crabs = [];
for (let i = 0; i < MAX_CRABS; i++) crabs.push({ live: false });

export function resetCrabs() {
  for (const c of crabs) c.live = false;
  king.live = false;
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
    c.flipped = 0;          // 0 upright; counts up once thrown over
    c.flipSide = 1;
    return true;
  }
  return false;
}

// --- update ------------------------------------------------------------------

export function updateCrabs(player, game) {
  updateKing(player, game);
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

    // On its back: harmless, legs going, claws snapping at nothing, until it
    // is off the screen -- and then it is gone, and another will come.
    if (c.flipped) {
      c.flipped++;
      c.gait = (c.gait + 0.35) % 4;
      if (rnd() < 0.08) c.snap = 5;
      if (c.flipped > FLIP_TIME && !onScreen(c, player)) c.live = false;
      continue;
    }

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

// (The king, stepped from updateCrabs.)
// Where the chase camera can see: the drawn landscape runs from ten to
// thirty-four tiles in front of the eye, a little under half as wide as it
// is far either side.
function onScreen(c, player) {
  const dz = ((c.z - player.camZ) | 0) / TILE;
  const dx = ((c.x - player.camX) | 0) / TILE;
  return dz > 9 && dz < 35 && Math.abs(dx) < dz * 0.48 + 1;
}

// A fire bomb's burst: every crab within `reach` tiles is thrown over onto
// its back. Returns how many.
const FLIP_TIME = 24;            // steps the throw takes, before it can go
export function flipCrabsNear(x, z, reach) {
  let n = 0;
  for (const c of crabs) {
    if (!c.live || c.flipped) continue;
    const dx = ((c.x - x) | 0) / TILE, dz = ((c.z - z) | 0) / TILE;
    if (dx * dx + dz * dz > reach * reach) continue;
    c.flipped = 1;
    c.windup = 0;
    c.chasing = false;
    // Over away from the burst.
    const sx = Math.cos(c.h), sz = -Math.sin(c.h);
    c.flipSide = dx * sx + dz * sz >= 0 ? 1 : -1;
    n++;
  }
  return n;
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
      [255, 90, 120], 30 + ((rnd() * 20) | 0), P_RISE | P_GLOW, 1);
  }
  game.onCrabSquashed(c);
}

// --- drawing -----------------------------------------------------------------

export function crabsInRow(zLo, zHi, out) {
  for (const c of crabs) {
    if (c.live && c.z >= zLo && c.z < zHi) out.push(c);
  }
  if (king.live && king.z >= zLo && king.z < zHi) out.push(king);
  return out;
}

const rot = new Float64Array(9), tip = new Float64Array(9), mat = new Float64Array(9);
const back = new Float64Array(9), mat2 = new Float64Array(9);

const scaled = new Float64Array(9);
// The matrix, with the model made k times its size.
function grow(m, k) {
  for (let i = 0; i < 9; i++) scaled[i] = m[i] * k;
  return scaled;
}

export function drawCrab(rd, c, camX, camY, camZ, fog = 0, row = 0) {
  const ground = landAltitude(c.x, c.z);
  // The king comes up out of the ground, growing as it comes; and shakes
  // when it is hit.
  const k = c.king ? KING_S * (0.25 + 0.75 * (1 - (1 - c.rise) * (1 - c.rise))) : 1;
  const px = c.king && c.hurt > 0 ? (c.x + Math.sin(c.hurt * 2.1) * 0.06 * TILE * k) | 0 : c.x;
  const poses = c.king ? KING_POSES : POSES, flippedPoses = c.king ? KING_FLIPPED : FLIPPED;
  // A pool of shadow under it, wider than it is: it is a shadow thing.
  drawShadow(rd, c.x, c.z, TILE * 0.55 * k, 0.75, camX, camY, camZ, row, fog, 0);
  // Tipped across the slope it stands on, side to side, so its legs meet the
  // ground on a hillside.
  const d = TILE * 0.4;
  const sx = Math.cos(c.h), sz = -Math.sin(c.h);
  const a = landAltitude((c.x + sx * d) | 0, (c.z + sz * d) | 0);
  const b = landAltitude((c.x - sx * d) | 0, (c.z - sz * d) | 0);
  matRotY(c.h, rot);
  matRotZ(Math.atan2(a - b, 2 * d), tip);
  matMul(rot, tip, mat);
  // Thrown over: rolled onto its back about its own length, in a hop, and
  // lying there shell-down.
  if (c.flipped) {
    const t = Math.min(1, c.flipped / 14);
    const e = t * t * (3 - 2 * t);
    matRotZ(-Math.PI * e * c.flipSide, back);
    matMul(mat, back, mat2);
    const hop = Math.sin(Math.PI * t) * 0.6 * TILE * (c.king ? 1.5 : 1);
    const lie = 0.52 * S * TILE * e * k;
    const pose = flippedPoses[(c.gait | 0) & 3][c.snap > 0 ? 1 : 0];
    const m2 = k !== 1 ? grow(mat2, k) : mat2;
    drawModel(rd, pose, m2, px, (ground - hop - lie) | 0, c.z, camX, camY, camZ, fog);
    if (c.king) drawModel(rd, CROWN, m2, px, (ground - hop - lie) | 0, c.z, camX, camY, camZ, fog);
    return;
  }
  // Rearing for a pinch: tipped back, claws up and open. Walking: a bob
  // with each step.
  const rear = c.windup > 0 ? Math.min(1, ((c.king ? KING_WINDUP : WINDUP) - c.windup + 1) / 5) : 0;
  if (rear > 0) {
    matRotX(0.35 * rear, back);
    matMul(mat, back, mat2);
    mat.set(mat2);
  }
  const bob = c.moving ? Math.abs(Math.sin(c.gait * Math.PI)) * 0.025 * TILE * k : 0;
  const pose = poses[(c.gait | 0) & 3][c.snap > 0 ? 1 : 0][c.raised > 0 || rear > 0 ? 1 : 0];
  const m1 = k !== 1 ? grow(mat, k) : mat;
  const y = (ground - bob - rear * 0.06 * TILE * k) | 0;
  drawModel(rd, pose, m1, px, y, c.z, camX, camY, camZ, fog);
  if (c.king) drawModel(rd, CROWN, m1, px, y, c.z, camX, camY, camZ, fog);
}
