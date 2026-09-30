// firebombs.js -- the phoenix's fire, let loose all round it.
//
// It used to drop a bomb: a drop of fire let go from under the bird that
// fell, carrying its speed, and burst where it landed. Now the phoenix
// itself flares -- a burst of its own fire thrown out in every direction at
// once, up, down and all round, that reaches BURST_REACH. Whatever is in
// that sphere is caught: a shadow crab is thrown over onto its back (see
// flipCrabsNear) and lies there waving its legs until it is off the screen,
// and the king crab takes a hit. The reach is a distance, not an area on
// the ground, so it is a thing done low: from a tile up it covers most of
// its width on the ground, and from three up it reaches nothing below.
//
// It costs energy, and the fire takes a while to come back (see player.js),
// so it is a thing to time rather than hold down.

import { TILE, rnd, rndSigned } from './maths.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { spawn, spawnSkimSpray, P_RISE, P_GLOW, P_GRAVITY } from './particles.js';
import { flipCrabsNear, hitKing } from './crabs.js';

export const BURST_REACH = 3.0;    // tiles, in every direction
const EMBERS = [[255, 236, 160], [255, 176, 64], [255, 110, 24]];

// How much of the screen's warmth is left from the last burst, 1 to 0.
let flash = 0;
export function burstFlash() { return flash; }

export function resetBombs() {
  flash = 0;
}

// The phoenix flares where it is. Returns how many crabs it caught.
export function burst(p, game) {
  const ground = Math.min(landAltitude(p.x, p.z), SEA_LEVEL);
  const up = Math.max(0, (ground - p.y) / TILE);           // tiles over the ground or the sea
  flash = 1;

  // A shell of fire thrown out in every direction: points spread evenly over
  // a sphere (a spiral of them), each at a speed that carries it to about the
  // reach in its life, fading as it goes.
  const N = 64;
  for (let i = 0; i < N; i++) {
    const yv = 1 - (2 * (i + 0.5)) / N;                    // -1 .. 1
    const r = Math.sqrt(1 - yv * yv), a = i * 2.39996;     // the golden angle
    const sp = TILE * (0.07 + rnd() * 0.02);
    spawn(p.x, p.y, p.z, Math.cos(a) * r * sp + p.vx * 0.3, -yv * sp + p.vy * 0.3, Math.sin(a) * r * sp + p.vz * 0.3,
      EMBERS[i % 3], 26 + ((rnd() * 10) | 0), P_GLOW, 3);
  }
  // ... a hot heart of it that hangs a moment where the bird was ...
  for (let i = 0; i < 16; i++) {
    spawn(p.x, p.y, p.z, rndSigned() * TILE * 0.012, -TILE * (0.004 + rnd() * 0.01), rndSigned() * TILE * 0.012,
      EMBERS[i % 2], 30 + ((rnd() * 16) | 0), P_RISE | P_GLOW, 4);
  }
  // ... and where it reaches the ground or the sea, a ring of fire running
  // out across it, or a skirt of spray.
  if (up < BURST_REACH) {
    const ring = Math.sqrt(BURST_REACH * BURST_REACH - up * up);
    const n = Math.round(12 + ring * 8);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, sp = TILE * 0.06 * (ring / BURST_REACH);
      if (ground >= SEA_LEVEL) {
        spawnSkimSpray(p.x, SEA_LEVEL - 1, p.z, Math.cos(a) * sp, -TILE * (0.01 + rnd() * 0.02), Math.sin(a) * sp);
      } else {
        spawn(p.x, (ground - TILE * 0.05) | 0, p.z, Math.cos(a) * sp, -TILE * 0.006 * rnd(), Math.sin(a) * sp,
          EMBERS[i % 3], 22 + ((rnd() * 10) | 0), P_GLOW, 3);
      }
    }
    // Sparks thrown up to fall back.
    for (let i = 0; i < 10; i++) {
      spawn(p.x, (ground - TILE * 0.1) | 0, p.z, rndSigned() * TILE * 0.02, -TILE * (0.03 + rnd() * 0.03), rndSigned() * TILE * 0.02,
        EMBERS[i % 3], 30 + ((rnd() * 20) | 0), P_GLOW | P_GRAVITY, 1);
    }
  }

  // What it catches: on the ground, whatever is within the reach of the bird
  // -- which is the reach, across the ground, less the height it is up.
  let flipped = 0, left = -1;
  if (up < BURST_REACH) {
    const across = Math.sqrt(BURST_REACH * BURST_REACH - up * up);
    flipped = flipCrabsNear(p.x, p.z, across);
    // The king is big: his shell is half again the reach nearer.
    left = hitKing(p.x, p.z, across + 0.8);
  }
  if (game.onBombBurst) game.onBombBurst(p.x, ground, p.z, flipped);
  if (left >= 0 && game.onKingHit) game.onKingHit(left);
  return flipped;
}

// The warmth fades.
export function updateBombs() {
  if (flash > 0) flash = Math.max(0, flash - 0.12);
}

// Nothing of its own left to draw: the particles are the fire.
export function drawBombs() {}
