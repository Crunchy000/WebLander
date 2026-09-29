// firebombs.js -- the phoenix's fire, dropped.
//
// A drop of the bird's own fire, let go from under it: it carries the bird's
// speed, so you aim by flying over the place rather than pointing at it, and
// it falls, trailing sparks, until it meets the ground and bursts. Anything
// in the burst that is a shadow crab is thrown over onto its back (see
// flipCrabsNear) and lies there waving its legs until it is off the screen.
// Over the sea it only hisses out.
//
// It costs a little energy, so it is a thing to spend rather than hold down.

import { TILE, rnd, rndSigned } from './maths.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { drawLamp } from './model.js';
import { spawn, spawnSkimSpray, P_RISE, P_GLOW, P_GRAVITY } from './particles.js';
import { flipCrabsNear } from './crabs.js';

const MAX_BOMBS = 10;
const FALL = (TILE * 0.004) | 0;   // gravity on a bomb, a step: it drops, half a second from hover height
const DRAG = 0.99;
const BURST = 1.7;                 // tiles: what the burst reaches
const EMBERS = [[255, 236, 160], [255, 176, 64], [255, 110, 24]];

const bombs = [];
for (let i = 0; i < MAX_BOMBS; i++) bombs.push({ live: false });

export function resetBombs() {
  for (const b of bombs) b.live = false;
}

// Let one go from under the bird. Returns false if none is free.
export function dropBomb(p) {
  const b = bombs.find((q) => !q.live);
  if (!b) return false;
  b.live = true;
  b.x = p.x; b.y = (p.y + TILE * 0.25) | 0; b.z = p.z;
  b.vx = (p.vx * 0.9) | 0;
  b.vy = (Math.max(0, p.vy) + TILE * 0.04) | 0;
  b.vz = (p.vz * 0.9) | 0;
  b.age = 0;
  return true;
}

export function updateBombs(game) {
  for (const b of bombs) {
    if (!b.live) continue;
    b.age++;
    b.vy = (b.vy + FALL) | 0;
    b.vx = (b.vx * DRAG) | 0;
    b.vz = (b.vz * DRAG) | 0;
    b.x = (b.x + b.vx) | 0;
    b.y = (b.y + b.vy) | 0;
    b.z = (b.z + b.vz) | 0;
    // A trail of sparks.
    if (b.age % 2 === 0) {
      spawn(b.x, b.y, b.z, rndSigned() * TILE * 0.004, -TILE * 0.004, rndSigned() * TILE * 0.004,
        EMBERS[(rnd() * 3) | 0], 18 + ((rnd() * 12) | 0), P_RISE | P_GLOW, 1);
    }
    const ground = landAltitude(b.x, b.z);
    if (b.y < ground && b.age < 400) continue;
    b.live = false;
    if (ground >= SEA_LEVEL) {
      // Into the sea: a hiss of steam and spray, and nothing else.
      for (let i = 0; i < 10; i++) {
        spawnSkimSpray(b.x, SEA_LEVEL - 1, b.z, rndSigned() * TILE * 0.01, -TILE * (0.01 + rnd() * 0.02), rndSigned() * TILE * 0.01);
      }
      if (game.onBombFizzle) game.onBombFizzle();
      continue;
    }
    // The burst: a ring of fire thrown out low, and sparks up.
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2, sp = TILE * (0.025 + rnd() * 0.025);
      spawn(b.x, (ground - TILE * 0.05) | 0, b.z, Math.cos(a) * sp, -TILE * 0.008 * rnd(), Math.sin(a) * sp,
        EMBERS[i % 3], 22 + ((rnd() * 16) | 0), P_GLOW, 3);
    }
    // ... a column of flame going up ...
    for (let i = 0; i < 14; i++) {
      spawn((b.x + rndSigned() * TILE * 0.2) | 0, (ground - TILE * 0.1) | 0, (b.z + rndSigned() * TILE * 0.2) | 0,
        rndSigned() * TILE * 0.004, -TILE * (0.02 + rnd() * 0.02), rndSigned() * TILE * 0.004,
        EMBERS[i % 3], 24 + ((rnd() * 14) | 0), P_RISE | P_GLOW, 4);
    }
    // ... and sparks thrown up to fall back.
    for (let i = 0; i < 18; i++) {
      spawn(b.x, (ground - TILE * 0.1) | 0, b.z, rndSigned() * TILE * 0.02, -TILE * (0.03 + rnd() * 0.03), rndSigned() * TILE * 0.02,
        EMBERS[i % 3], 30 + ((rnd() * 20) | 0), P_GLOW | P_GRAVITY, 1);
    }
    const flipped = flipCrabsNear(b.x, b.z, BURST);
    if (game.onBombBurst) game.onBombBurst(b.x, ground, b.z, flipped);
  }
}

// Drawn over the world, with the particles: a hot core in a glow.
export function drawBombs(rd, camX, camY, camZ) {
  for (const b of bombs) {
    if (!b.live) continue;
    // No halo: the lamp's glow is a square, and on something this small and
    // this fast it read as a box. The trail of sparks is the glow.
    drawLamp(rd, b.x, b.y, b.z, camX, camY, camZ, 0.13, [255, 140, 40], 0, false);
    drawLamp(rd, b.x, b.y, b.z, camX, camY, camZ, 0.07, [255, 244, 200], 0, false);
  }
}
