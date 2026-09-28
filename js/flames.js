// flames.js -- the five teardrop flames the phoenix gathers.
//
// The phoenix starts small: no tail, no streamer, half a load of energy.
// Five flames burn at fixed places around the start, each a teardrop of fire
// hanging over the ground, turning slowly and breathing up and down. Fly
// through one and the bird takes it in: a tongue of flame for its tail, a
// longer streamer behind it, and more room for energy (see Game.onFlameTaken).
//
// They have to be found, so each one also throws a column of light straight
// up into the sky, which can be seen from anywhere it is in front of you --
// the one thing in the world placed to be looked for.

import { TILE, matRotY, rnd, rndSigned } from './maths.js';
import { Model, drawModel } from './model.js';
import { sky } from './daylight.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { project, SCREEN_W, SCREEN_H } from './renderer.js';
import { spawn, P_RISE, P_GLOW } from './particles.js';

export const FLAME_COUNT = 5;

// Where they burn: spread over the whole world, which is 256 tiles each way
// and wraps round. Every one is ahead of the launchpad -- the camera looks
// only one way, and a flame behind it could never be seen -- about fifty
// tiles further on each time, swinging wider left and right, so the last is
// most of the way round the world. Each is moved to the nearest dry ground to
// its mark. The first two columns of light can be seen from the pad; the
// others, more than half the world away, come into view on the way out.
const START = [4, 4];
const MARKS = [[12, 40], [-30, 90], [55, 140], [-80, 190], [110, 235]];
const HOVER = 1.3;               // tiles above the ground
const REACH = 0.95;              // how close the bird must come, in tiles

function dryNear(cx, cz) {
  for (let r = 0; r < 24; r++) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(ang) * r), z = Math.round(cz + Math.sin(ang) * r);
      // Dry, and dry around it, so a flame is never out over the sea.
      let ok = true;
      for (let d = -1; d <= 1 && ok; d++) {
        if (landAltitude(((x + d) * TILE) | 0, (z * TILE) | 0) >= SEA_LEVEL) ok = false;
        if (landAltitude((x * TILE) | 0, ((z + d) * TILE) | 0) >= SEA_LEVEL) ok = false;
      }
      if (ok) return [x, z];
      if (r === 0) break;
    }
  }
  return [cx, cz];
}

const flames = MARKS.map(([dx, dz], k) => {
  const [x, z] = dryNear(START[0] + dx, START[1] + dz);
  return { k, x: (x * TILE) | 0, z: (z * TILE) | 0, taken: false, phase: k * 1.7 };
});

export function resetFlames() {
  for (const f of flames) f.taken = false;
}

function heightOf(f) {
  const bob = Math.sin(sky.tick * 0.05 + f.phase) * 0.12;
  return (landAltitude(f.x, f.z) - (HOVER + bob) * TILE) | 0;
}

// Called every step. Hands a flame to the game when the bird flies into it.
export function updateFlames(player, game) {
  if (player.dead) return;
  for (const f of flames) {
    if (f.taken) continue;
    const dx = ((f.x - player.x) | 0) / TILE, dz = ((f.z - player.z) | 0) / TILE;
    const dy = (heightOf(f) - player.y) / TILE;
    if (dx * dx + dy * dy + dz * dz > REACH * REACH) continue;
    f.taken = true;
    // A burst of sparks where it was.
    const y = heightOf(f);
    for (let i = 0; i < 26; i++) {
      spawn(f.x, y, f.z, rndSigned() * TILE * 0.03, -rnd() * TILE * 0.04, rndSigned() * TILE * 0.03,
        EMBERS[i % EMBERS.length], 40 + ((rnd() * 30) | 0), P_RISE | P_GLOW, 1);
    }
    game.onFlameTaken(f.k);
  }
}

export function flamesTaken() {
  let n = 0;
  for (const f of flames) if (f.taken) n++;
  return n;
}

export function flamesInRow(zLo, zHi, out) {
  for (const f of flames) {
    if (!f.taken && f.z >= zLo && f.z < zHi) out.push(f);
  }
  return out;
}

// --- the teardrop ----------------------------------------------------------
//
// A drop of fire: round at the bottom, drawn out to a point at the top, faced
// in rings like everything else. It makes its own light. A second, larger
// copy is laid over it translucent, which is the glow.
const EMBERS = [[255, 226, 140], [255, 170, 60], [255, 110, 24]];
const RINGS = [
  // height (up is negative), radius, colour
  [0.30, 0.0, [255, 150, 40]],
  [0.22, 0.17, [255, 128, 28]],
  [0.02, 0.26, [255, 176, 60]],
  [-0.22, 0.20, [255, 206, 96]],
  [-0.46, 0.10, [255, 232, 150]],
  [-0.78, 0.0, [255, 246, 200]],
];
const SIDES = 7;
function teardrop(scale) {
  const m = new Model();
  const idx = [];
  for (const [h, r] of RINGS) {
    const ring = [];
    if (r === 0) {
      ring.push(m.vert(0, h * scale, 0));
    } else {
      for (let i = 0; i < SIDES; i++) {
        const a = (i / SIDES) * Math.PI * 2;
        ring.push(m.vert(Math.cos(a) * r * scale, h * scale, Math.sin(a) * r * scale));
      }
    }
    idx.push(ring);
  }
  for (let j = 0; j + 1 < RINGS.length; j++) {
    const a = idx[j], b = idx[j + 1], col = RINGS[j + 1][2];
    for (let i = 0; i < SIDES; i++) {
      const i2 = (i + 1) % SIDES;
      // Alternate facets a shade apart, so it reads as faceted, not smooth.
      const c = i % 2 ? col : col.map((v) => Math.round(v * 0.9));
      if (a.length === 1) m.faces.push({ idx: [a[0], b[i2], b[i]], col: c, glow: true });
      else if (b.length === 1) m.faces.push({ idx: [a[i], a[i2], b[0]], col: c, glow: true });
      else m.faces.push({ idx: [a[i], a[i2], b[i2], b[i]], col: c, glow: true });
    }
  }
  return m;
}
const DROP = teardrop(1);
const HALO = teardrop(1.45);
const spin = new Float64Array(9);

export function drawFlame(rd, f, camX, camY, camZ, fog = 0) {
  const y = heightOf(f);
  drawBeacon(rd, f, y, camX, camY, camZ);
  matRotY(sky.tick * 0.03 + f.phase, spin);
  drawModel(rd, DROP, spin, f.x, y, f.z, camX, camY, camZ, fog * 0.5);
  drawModel(rd, HALO, spin, f.x, y, f.z, camX, camY, camZ, fog * 0.5, 0, 0.32);
}

// --- the beacons -----------------------------------------------------------
//
// A column of light from each flame straight up into the sky, drawn added to
// whatever is behind it: a thin bright core and a wider faint haze, fading
// out as it climbs. Near ones are drawn with their flame, in its row of the
// landscape; ones beyond the drawn landscape by drawBeacons, before it.
const pa = { x: 0, y: 0 }, pb = { x: 0, y: 0 };
const cBase = [0, 0, 0, 0], cTop = [0, 0, 0, 0];
const BEACON_UP = 60;            // tiles
function drawBeacon(rd, f, y, camX, camY, camZ) {
  const vx = (f.x - camX) | 0, vz = (f.z - camZ) | 0;
  if (!project(vx, (y - camY) | 0, vz, pa)) return;
  if (!project(vx, (y - BEACON_UP * TILE - camY) | 0, vz, pb)) return;
  if (pa.x < -20 || pa.x > SCREEN_W + 20 || pb.y > SCREEN_H) return;
  const near = Math.max(0.6, Math.min(3, (0.14 * TILE * 512) / vz));
  // Brighter against the dark: by day it is a pale shaft, by night a pillar.
  const k = 0.35 + 0.65 * sky.lamp;
  rd.blend('add');
  for (const [wide, gain] of [[4.5, 0.10], [1, 0.42]]) {
    const w = near * wide;
    cBase[0] = 255; cBase[1] = 170; cBase[2] = 70; cBase[3] = Math.round(255 * gain * k);
    cTop[0] = 255; cTop[1] = 120; cTop[2] = 40; cTop[3] = 0;
    rd.quadShaded(pa.x - w, pa.y, cBase, pa.x + w, pa.y, cBase,
                  pb.x + w * 0.4, pb.y, cTop, pb.x - w * 0.4, pb.y, cTop);
  }
  rd.blend('over');
}

// The far ones: every flame beyond the drawn landscape, drawn before it so
// the ground in front of the column's foot hides it.
export function drawBeacons(rd, camX, camY, camZ, beyond) {
  for (const f of flames) {
    if (f.taken) continue;
    const dz = (f.z - camZ) | 0;
    if (dz < beyond) continue;
    drawBeacon(rd, f, heightOf(f), camX, camY, camZ);
  }
}
