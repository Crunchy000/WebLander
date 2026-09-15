// particles.js -- the exhaust plume, bullets, explosions, smoke and spray.
//
// One flat pool of 484 particles, matching the original's ceiling. When the
// pool is full, new particles are simply dropped; the game is tuned around
// that limit, and a hard cap is what keeps the frame time flat when half the
// landscape is on fire.

import { TILE, rnd, rndSigned, rndInt } from './maths.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { project, projScale, SCREEN_W, SCREEN_H } from './renderer.js';

export const MAX_PARTICLES = 484;

// Behaviour flags.
export const P_GRAVITY = 1 << 0;  // falls
export const P_BOUNCE  = 1 << 1;  // bounces off the landscape
export const P_STICK   = 1 << 2;  // stops dead where it lands
export const P_FADE    = 1 << 3;  // dims towards black as it ages
export const P_BULLET  = 1 << 4;  // damages whatever it touches
export const P_SPLASH  = 1 << 5;  // throws up spray when it hits the sea
export const P_RISE    = 1 << 6;  // drifts upwards (smoke)

// Structure-of-arrays: a lot cheaper to churn through than 484 objects.
const x = new Int32Array(MAX_PARTICLES);
const y = new Int32Array(MAX_PARTICLES);
const z = new Int32Array(MAX_PARTICLES);
const vx = new Int32Array(MAX_PARTICLES);
const vy = new Int32Array(MAX_PARTICLES);
const vz = new Int32Array(MAX_PARTICLES);
const life = new Int32Array(MAX_PARTICLES);
const maxLife = new Int32Array(MAX_PARTICLES);
const flags = new Int32Array(MAX_PARTICLES);
const cr = new Uint8Array(MAX_PARTICLES);
const cg = new Uint8Array(MAX_PARTICLES);
const cb = new Uint8Array(MAX_PARTICLES);
const size = new Uint8Array(MAX_PARTICLES);
const alive = new Uint8Array(MAX_PARTICLES);

let count = 0;

export function resetParticles() {
  alive.fill(0);
  count = 0;
}

export function particleCount() {
  return count;
}

function alloc() {
  if (count >= MAX_PARTICLES) return -1;
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (!alive[i]) {
      alive[i] = 1;
      count++;
      return i;
    }
  }
  return -1;
}

export function spawn(px, py, pz, pvx, pvy, pvz, col, ttl, fl, sz = 1) {
  const i = alloc();
  if (i < 0) return -1;
  x[i] = px | 0; y[i] = py | 0; z[i] = pz | 0;
  vx[i] = pvx | 0; vy[i] = pvy | 0; vz[i] = pvz | 0;
  cr[i] = col[0]; cg[i] = col[1]; cb[i] = col[2];
  life[i] = ttl; maxLife[i] = ttl;
  flags[i] = fl;
  size[i] = sz;
  return i;
}

function kill(i) {
  alive[i] = 0;
  count--;
}

// --- recipes ---------------------------------------------------------------

const FLAME = [[255, 238, 136], [255, 170, 51], [255, 102, 34]];
const SMOKE = [[102, 102, 102], [136, 136, 136], [68, 68, 68]];
const SPRAY = [[187, 221, 255], [255, 255, 255]];
const SPARK = [[255, 255, 204], [255, 221, 102]];
const DUST  = [[176, 164, 136], [154, 144, 120], [196, 184, 156]];

const pick = (a) => a[rndInt(a.length)];

// The engine plume: particles thrown out along the ship's thrust axis, which
// then fall, bounce off the ground and splash into the sea.
export function spawnExhaust(px, py, pz, dvx, dvy, dvz, spread) {
  spawn(
    px, py, pz,
    dvx + rndSigned() * spread,
    dvy + rndSigned() * spread,
    dvz + rndSigned() * spread,
    pick(FLAME), 28 + rndInt(18),
    P_GRAVITY | P_BOUNCE | P_FADE | P_SPLASH, 2,
  );
}

// A bomb: released rather than fired, so it carries the craft's own velocity
// and lets gravity do the aiming. Heavier and slower-lived than a bullet, and
// drawn large enough to follow down.
export function spawnBomb(px, py, pz, bvx, bvy, bvz) {
  return spawn(px, py, pz, bvx, bvy, bvz, [96, 102, 118], 160,
               P_GRAVITY | P_BULLET | P_SPLASH, 5);
}

// A ball of debris flung out in every direction.
export function spawnExplosion(px, py, pz, n, speed, cols) {
  for (let i = 0; i < n; i++) {
    // Pick a direction on the unit sphere so the burst is even.
    const u = rndSigned(), a = rnd() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const sp = speed * (0.35 + rnd() * 0.65);
    spawn(px, py, pz,
      Math.cos(a) * s * sp, u * sp, Math.sin(a) * s * sp,
      cols ? pick(cols) : pick(FLAME),
      40 + rndInt(50),
      P_GRAVITY | P_BOUNCE | P_FADE | P_SPLASH,
      1 + rndInt(3));
  }
}

export function spawnSparks(px, py, pz, n) {
  for (let i = 0; i < n; i++) {
    spawn(px, py, pz,
      rndSigned() * TILE * 0.045, -rnd() * TILE * 0.05, rndSigned() * TILE * 0.045,
      pick(SPARK), 18 + rndInt(20), P_GRAVITY | P_FADE, 1);
  }
}

// Rotor wash: grit thrown outwards off the ground under a hovering rotor.
export function spawnDust(px, py, pz, outX, outZ) {
  spawn(px, py, pz,
    outX, -TILE * 0.004 - rnd() * TILE * 0.004, outZ,
    pick(DUST), 22 + rndInt(20), P_GRAVITY | P_FADE, 2);
}

// Smoke climbing from a wreck.
export function spawnSmoke(px, py, pz) {
  spawn(px, py, pz,
    rndSigned() * TILE * 0.006, -TILE * 0.008 - rnd() * TILE * 0.006, rndSigned() * TILE * 0.006,
    pick(SMOKE), 60 + rndInt(50), P_RISE | P_FADE, 2 + rndInt(2));
}

function spawnSplash(px, pz, seaY) {
  const n = 3 + rndInt(4);
  for (let i = 0; i < n; i++) {
    spawn(px, seaY, pz,
      rndSigned() * TILE * 0.02, -rnd() * TILE * 0.05 - TILE * 0.01, rndSigned() * TILE * 0.02,
      pick(SPRAY), 18 + rndInt(16), P_GRAVITY | P_FADE, 1);
  }
}

// --- update ----------------------------------------------------------------

// Called with the current gravity, plus a callback used to ask the game
// whether a bullet has hit anything. The callback returns true if the bullet
// should be consumed.
export function updateParticles(gravity, onBulletHit) {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (!alive[i]) continue;

    const fl = flags[i];

    if (fl & P_GRAVITY) vy[i] = (vy[i] + gravity) | 0;
    if (fl & P_RISE) vy[i] = (vy[i] - (gravity >> 3)) | 0;

    x[i] = (x[i] + vx[i]) | 0;
    y[i] = (y[i] + vy[i]) | 0;
    z[i] = (z[i] + vz[i]) | 0;

    if (--life[i] <= 0) { kill(i); continue; }

    const ground = landAltitude(x[i], z[i]);

    // Bullets damage what they touch, and are consumed doing it.
    if (fl & P_BULLET) {
      if (onBulletHit(i, x[i], y[i], z[i])) { kill(i); continue; }
    }

    if (y[i] >= ground) {
      // Hit the ground (or the sea).
      if (ground >= SEA_LEVEL) {
        if (fl & P_SPLASH) spawnSplash(x[i], z[i], SEA_LEVEL);
        kill(i);
        continue;
      }
      if (fl & P_BOUNCE) {
        y[i] = ground;
        // Lose most of the energy, and shed some sideways too.
        vy[i] = -(vy[i] >> 1) | 0;
        vx[i] = (vx[i] * 0.6) | 0;
        vz[i] = (vz[i] * 0.6) | 0;
        // Once it is barely moving, let it settle out rather than jittering.
        if (vy[i] > -(TILE >> 11)) { kill(i); continue; }
      } else if (fl & P_STICK) {
        y[i] = ground;
        vx[i] = vy[i] = vz[i] = 0;
      } else {
        kill(i);
        continue;
      }
    }
  }
}

// --- drawing ---------------------------------------------------------------

const pt = { x: 0, y: 0 };

// Particles are drawn as small screen-aligned rectangles whose size falls off
// with distance, in the same 1x1 to 3x2 range the original used.
export function drawParticles(rd, camX, camY, camZ) {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (!alive[i]) continue;

    const vzs = (z[i] - camZ) | 0;
    if (!project((x[i] - camX) | 0, (y[i] - camY) | 0, vzs, pt)) continue;
    if (pt.x < -4 || pt.x > SCREEN_W + 4 || pt.y < -4 || pt.y > SCREEN_H + 4) continue;

    // Size class from the base size and how near it is.
    const s = projScale(vzs) * TILE;
    let w = 1, h = 1;
    if (s > 0.9) { w = 3; h = 2; }
    else if (s > 0.55) { w = 2; h = 2; }
    else if (s > 0.3) { w = 2; h = 1; }
    if (size[i] === 1 && w > 2) { w = 2; h = 1; }
    // Sizes above 2 scale up rather than adding a fixed pixel, so a bomb can
    // be genuinely chunky and still be recognisable at the far end of the map.
    if (size[i] >= 3) { const g = size[i] - 2; w += g; h += g; }

    let r = cr[i], g = cg[i], b = cb[i];
    if (flags[i] & P_FADE) {
      // Cool down towards black over the particle's life.
      const t = life[i] / maxLife[i];
      const f = t * t * (3 - 2 * t);
      r = (r * f) | 0; g = (g * f) | 0; b = (b * f) | 0;
    }

    rd.rect(Math.round(pt.x) - (w >> 1), Math.round(pt.y) - (h >> 1), w, h, [r, g, b]);
  }
}

// Expose particle positions so the game can test bullets against scenery.
export const particleData = { x, y, z, flags, alive };
