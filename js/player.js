// player.js -- the lander: how it is drawn, how it flies, and how it dies.
//
// The craft has no independent yaw. It leans, and leaning is what moves you:
// thrust always acts along the ship's own "up" axis, so tilting trades lift
// for sideways acceleration. That single idea is the whole flight model, and
// it is why the controls map so naturally onto a phone you physically tilt.

import { TILE, matFromAim, matApply, clamp, rnd, rndSigned } from './maths.js';
import { Model, shade } from './model.js';
import {
  landAltitude, SEA_LEVEL, LAUNCHPAD_ALT, LAUNCHPAD_Y,
  UNDERCARRIAGE_Y, LANDING_SPEED, LANDSCAPE_Z_MID, isOnLaunchpad,
} from './landscape.js';
import { MODELS, objectAt, objectOffset, isWreck } from './objects.js';
import { project, SCREEN_W, SCREEN_H } from './renderer.js';
import { spawnExhaust, spawnBullet, spawnExplosion, spawnSparks } from './particles.js';

// --- tuning ----------------------------------------------------------------

export const GRAVITY_START = 0x02800;
// The eye sits at y = 0, which is also the height of the tallest possible
// peak: the game is played skimming the landscape, within about five tiles of
// the ground, not cruising above it. The engines cut out just above that, so
// climbing is self-limiting and the landscape always stays in frame.
export const HIGHEST_ALTITUDE = -(TILE * 3);
export const FUEL_MAX = 0x4000;

const THRUST_HOVER = 0x02800;   // exactly cancels the starting gravity
const THRUST_FULL  = 0x04800;
const MAX_LEAN = 0.62;          // radians at full stick deflection
const LEAN_RATE = 0.22;         // how fast the craft follows the stick
const DRAG = 0.985;             // damping; without it the craft is unflyable

const FUEL_BURN_HOVER = 3;
const FUEL_BURN_FULL = 8;

const BULLET_SPEED = TILE * 0.075;
// How far along the nose the barrel ends, so shots leave the muzzle rather
// than the middle of the hull.
const MUZZLE = TILE * 1.26;
const SHIP_RADIUS = 0.3;   // in tiles, for scenery collisions

// Getting off the pad is the fiddliest moment in the game, so the first few
// seconds of every life are free: you can scrape the ground, clip a tree or
// come down hard without losing a ship. At 50Hz this is five seconds.
export const LAUNCH_GRACE = 250;
const CAMERA_CEILING = -((TILE * 3) / 2);  // how far the eye may rise above y = 0

// --- the ship model --------------------------------------------------------

// Faceted hull: every surface dead flat, meeting at hard angles, with a sharp
// chine running right round the waist where the upper and lower panels join.
// It suits this renderer -- flat shading is all it does, so a shape built only
// from flat panels reads exactly as intended, each facet catching the light
// differently.
//
// There is no undercarriage; the craft sets down on its keel, which is why the
// belly reaches exactly UNDERCARRIAGE_Y below the centre.

const SPINE   = [ 96, 150, 214];   // upper hull, steel blue
const SPINE_B = [ 74, 122, 182];   // alternating upper panels
const CHEEK   = [226, 108,  62];   // forward cheeks, warm accent
const FLANK   = [ 62, 160, 158];   // mid flanks, teal
const BELLY   = [206, 158,  74];   // keel, amber
const BELLY_B = [170, 124,  58];
const GLASS   = [ 36, 214, 226];   // canopy
const ENGINE  = [ 74,  78,  92];
const BARREL  = [ 92,  98, 112];
const MUZZLE_C= [242,  92,  64];
const FIN     = [232, 196,  74];

// Light from above, a little to the left and ahead. +y is down, so "above"
// is negative.
const LIGHT = (() => {
  const v = [-0.34, -1, 0.26];
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
})();

// Add a face shaded by its own normal, so the faceting does the work rather
// than hand-picked brightness. The normal is flipped outward where needed:
// the model is drawn without backface culling, so winding is free to be
// inconsistent.
//
// The ambient floor is deliberately high. The camera rides at the craft's own
// altitude, so the facets usually on show are the flanks and belly -- exactly
// the ones a purely directional light leaves in shadow, which against a black
// sky would reduce the whole craft to a silhouette.
function facet(m, idx, base) {
  const v = m.verts;
  const p = (i) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  const [ax, ay, az] = p(idx[0]);
  const [bx, by, bz] = p(idx[1]);
  const [cx, cy, cz] = p(idx[2]);

  const e1 = [bx - ax, by - ay, bz - az];
  const e2 = [cx - ax, cy - ay, cz - az];
  let n = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  n = [n[0] / len, n[1] / len, n[2] / len];

  let mx = 0, my = 0, mz = 0;
  for (const i of idx) { const q = p(i); mx += q[0]; my += q[1]; mz += q[2]; }
  const k = idx.length;
  if (n[0] * (mx / k) + n[1] * (my / k) + n[2] * (mz / k) < 0) {
    n = [-n[0], -n[1], -n[2]];
  }

  const lit = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  m.face(idx, shade(base, 0.70 + 0.46 * lit));
  return m;
}

function buildShip() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x, y, z);

  const CH = -0.06;             // chine height
  const KEEL_Y = 0.39;          // belly, at exactly the undercarriage height

  // The chine ring: the sharp edge round the waist.
  const c = [
    v( 0.00, CH,  0.95),   // 0  nose
    v( 0.46, CH,  0.12),   // 1  starboard shoulder
    v( 0.36, CH, -0.52),   // 2  starboard hip
    v( 0.00, CH, -0.80),   // 3  tail
    v(-0.36, CH, -0.52),   // 4  port hip
    v(-0.46, CH,  0.12),   // 5  port shoulder
  ];

  const tF = v(0.00, -0.40,  0.18);   // spine, forward
  const tR = v(0.00, -0.33, -0.40);   // spine, aft
  const bF = v(0.00, KEEL_Y,  0.14);  // keel, forward
  const bR = v(0.00, KEEL_Y - 0.03, -0.44);  // keel, aft

  // Upper facets, alternating tones so neighbouring panels stay distinct.
  facet(m, [c[0], c[1], tF], CHEEK);
  facet(m, [c[1], c[2], tR, tF], SPINE);
  facet(m, [c[2], c[3], tR], SPINE_B);
  facet(m, [c[3], c[4], tR], SPINE_B);
  facet(m, [c[4], c[5], tF, tR], SPINE);
  facet(m, [c[5], c[0], tF], CHEEK);

  // Canopy set into the spine.
  facet(m, [v(-0.13, -0.37, 0.14), v(0.13, -0.37, 0.14), v(0.00, -0.26, 0.52)], GLASS);

  // Lower facets.
  facet(m, [c[0], bF, c[1]], BELLY);
  facet(m, [c[1], bF, bR, c[2]], BELLY_B);
  facet(m, [c[2], bR, c[3]], FLANK);
  facet(m, [c[3], bR, c[4]], FLANK);
  facet(m, [c[4], bR, bF, c[5]], BELLY_B);
  facet(m, [c[5], bF, c[0]], BELLY);

  // Swept fins at the hips, for shape and a splash of colour.
  for (const sgn of [1, -1]) {
    facet(m, [
      v(sgn * 0.34, CH, -0.30),
      v(sgn * 0.62, CH - 0.02, -0.66),
      v(sgn * 0.30, CH, -0.74),
    ], FIN);
  }

  // Engine, faceted, under the tail.
  const eR = 0.15, eTop = [], eBot = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    eTop.push(v(Math.cos(a) * eR, 0.10, -0.34 + Math.sin(a) * eR));
    eBot.push(v(Math.cos(a) * eR * 1.4, 0.34, -0.34 + Math.sin(a) * eR * 1.4));
  }
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    facet(m, [eTop[i], eBot[i], eBot[j], eTop[j]], ENGINE);
  }

  // Cannon out of the nose, square-sectioned to match the hull.
  const bw = 0.06;
  const g = [
    v(-bw, CH - 0.05, 0.80), v(bw, CH - 0.05, 0.80),
    v( bw, CH + 0.06, 0.80), v(-bw, CH + 0.06, 0.80),
    v(-bw, CH - 0.05, 1.20), v(bw, CH - 0.05, 1.20),
    v( bw, CH + 0.06, 1.20), v(-bw, CH + 0.06, 1.20),
  ];
  facet(m, [g[0], g[1], g[5], g[4]], BARREL);
  facet(m, [g[3], g[2], g[6], g[7]], BARREL);
  facet(m, [g[1], g[2], g[6], g[5]], BARREL);
  facet(m, [g[0], g[3], g[7], g[4]], BARREL);
  m.face([g[4], g[5], g[6], g[7]], MUZZLE_C);

  return m;
}

export const SHIP_MODEL = buildShip();

// --- state -----------------------------------------------------------------

export class Player {
  constructor() {
    this.reset();
  }

  reset() {
    // Start sitting on the launchpad at the world origin.
    this.x = TILE * 4;
    this.y = LAUNCHPAD_Y;
    this.z = TILE * 4;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.leanDir = 0;
    this.lean = 0;
    this.matrix = matFromAim(0, 0);
    this.fuel = FUEL_MAX;
    this.landed = true;
    this.dead = false;
    this.deathTimer = 0;
    this.fireCooldown = 0;
    this.thrusting = 0;   // 0 none, 1 hover, 2 full
    this.grace = LAUNCH_GRACE;
  }

  // The camera sits behind and above, and never rotates -- the downward view
  // comes entirely from the eye being above the landscape with the screen
  // centre set high, which is why there is no view matrix anywhere in here.
  get camX() { return this.x; }

  // The eye rides at y = 0, the height of the tallest possible peak, and only
  // climbs if the ship goes above that. It stops climbing a few tiles up: let
  // it follow indefinitely and a hard climb walks the whole landscape off the
  // bottom of the screen, leaving you flying in a black void. Capping it means
  // an over-enthusiastic ascent flies off the top of the frame instead, which
  // tells the player exactly what they have done.
  get camY() { return Math.max(CAMERA_CEILING, Math.min(this.y, 0)); }
  get camZ() { return (this.z - LANDSCAPE_Z_MID) | 0; }

  get speed() {
    return Math.hypot(this.vx, this.vy, this.vz);
  }

  // While this holds, nothing can destroy the ship.
  get protected() {
    return this.grace > 0;
  }

  get altitude() {
    // Height above the ground directly below, in fixed point.
    return (landAltitude(this.x, this.z) - this.y - UNDERCARRIAGE_Y) | 0;
  }

  // -- flight ---------------------------------------------------------------

  // `stick` is the control input as x/y in [-1, 1]; `thrust` is 0, 1 (hover)
  // or 2 (full); `fire` is a boolean.
  update(stick, thrust, fire, gravity, game) {
    if (this.dead) {
      this.deathTimer--;
      return;
    }

    if (this.grace > 0) this.grace--;

    // Aim for the lean the stick is asking for, and ease towards it. The
    // magnitude of the deflection sets how hard we tilt, its angle sets which
    // way -- straight from the original's polar treatment of the mouse.
    // Bearing of the stick becomes the craft's heading; how hard you push
    // becomes how far its nose drops. Centring the stick leaves the heading
    // where it was, so the craft holds its facing rather than snapping back.
    const mag = Math.min(1, Math.hypot(stick.x, stick.y));
    const targetLean = mag * MAX_LEAN;
    const targetDir = (mag > 0.02) ? Math.atan2(stick.x, stick.y) : this.leanDir;

    // Interpolate the direction the short way round the circle.
    let dd = targetDir - this.leanDir;
    while (dd > Math.PI) dd -= Math.PI * 2;
    while (dd < -Math.PI) dd += Math.PI * 2;
    this.leanDir += dd * LEAN_RATE;
    this.lean += (targetLean - this.lean) * LEAN_RATE;

    matFromAim(this.leanDir, this.lean, this.matrix);

    // Out of fuel, or too high for the engines to bite, means no thrust.
    if (this.fuel <= 0) thrust = 0;
    if (this.y < HIGHEST_ALTITUDE) thrust = 0;
    this.thrusting = thrust;

    if (thrust) {
      const power = thrust === 2 ? THRUST_FULL : THRUST_HOVER;
      // "Up" in ship space is -y, since y points down.
      const up = matApply(this.matrix, 0, -1, 0);
      this.vx = (this.vx + up[0] * power) | 0;
      this.vy = (this.vy + up[1] * power) | 0;
      this.vz = (this.vz + up[2] * power) | 0;

      this.fuel -= thrust === 2 ? FUEL_BURN_FULL : FUEL_BURN_HOVER;
      if (this.fuel < 0) this.fuel = 0;

      this.emitExhaust(up, thrust);
    }

    // Gravity, then damping, then move.
    this.vy = (this.vy + gravity) | 0;
    this.vx = (this.vx * DRAG) | 0;
    this.vy = (this.vy * DRAG) | 0;
    this.vz = (this.vz * DRAG) | 0;

    this.x = (this.x + this.vx) | 0;
    this.y = (this.y + this.vy) | 0;
    this.z = (this.z + this.vz) | 0;

    if (this.fireCooldown > 0) this.fireCooldown--;
    if (fire && this.fireCooldown === 0) {
      this.fire();
      game.onShot();
      this.fireCooldown = 7;
    }

    this.checkGround(game);
  }

  emitExhaust(up, thrust) {
    const n = thrust === 2 ? 3 : 2;
    // Out of the engine bell, opposite to thrust.
    const ex = (this.x - up[0] * TILE * 0.32) | 0;
    const ey = (this.y - up[1] * TILE * 0.32) | 0;
    const ez = (this.z - up[2] * TILE * 0.32) | 0;
    const jet = thrust === 2 ? TILE * 0.028 : TILE * 0.018;
    for (let i = 0; i < n; i++) {
      spawnExhaust(
        ex, ey, ez,
        this.vx - up[0] * jet,
        this.vy - up[1] * jet,
        this.vz - up[2] * jet,
        TILE * 0.006,
      );
    }
  }

  fire() {
    // The gun points out through the ship's nose, along its local forward
    // axis, so aiming means leaning: level flight shoots straight ahead,
    // tipping forward walks the shots down into the landscape.
    const nose = matApply(this.matrix, 0, 0, 1);

    spawnBullet(
      (this.x + nose[0] * MUZZLE) | 0,
      (this.y + nose[1] * MUZZLE) | 0,
      (this.z + nose[2] * MUZZLE) | 0,
      (this.vx + nose[0] * BULLET_SPEED) | 0,
      (this.vy + nose[1] * BULLET_SPEED) | 0,
      (this.vz + nose[2] * BULLET_SPEED) | 0,
    );
  }

  // -- contact with the ground ----------------------------------------------

  checkGround(game) {
    if (this.hitScenery(game)) return;

    const ground = landAltitude(this.x, this.z);
    const feet = (this.y + UNDERCARRIAGE_Y) | 0;

    if (feet < ground) {
      this.landed = false;
      return;
    }

    // We are touching something.
    if (ground >= SEA_LEVEL) {
      if (!this.protected) {
        this.die(game, 'sea');
        return;
      }
      // During grace, ditching just leaves you sitting on the surface.
    }

    // Judge the arrival on three counts: how hard you came down, how fast you
    // were sliding, and whether you were anywhere near upright. Coming down
    // hard is the one that usually gets you.
    const vertical = Math.abs(this.vy);
    const horizontal = Math.hypot(this.vx, this.vz);

    const badArrival = vertical > LANDING_SPEED ||
                       horizontal > LANDING_SPEED * 1.6 ||
                       this.lean > 0.45;

    if (badArrival && !this.protected) {
      this.die(game, 'crash');
      return;
    }
    // Inside the grace period a bad arrival is simply absorbed: we fall
    // through to the landing code below, which sets the ship down safely.

    const onPad = isOnLaunchpad(this.x, this.z) && ground === LAUNCHPAD_ALT;

    this.y = (ground - UNDERCARRIAGE_Y) | 0;
    this.vy = 0;
    this.vx = (this.vx * 0.7) | 0;
    this.vz = (this.vz * 0.7) | 0;

    if (!this.landed) {
      this.landed = true;
      game.onTouchdown(onPad);
    }
    if (onPad && this.fuel < FUEL_MAX) {
      this.fuel = Math.min(FUEL_MAX, this.fuel + 40);
      game.onRefuel();
    }
  }

  // Flying into the scenery is fatal. The original keeps a minimum safe height
  // for clearing objects; this is the same idea done as a cylinder test, so
  // you can thread between two trees but not through one.
  hitScenery(game) {
    if (this.protected) return false;
    const tx = this.x >> 24, tz = this.z >> 24;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ox = (tx + dx) | 0, oz = (tz + dz) | 0;
        const type = objectAt(ox, oz);
        if (type < 0 || isWreck(type)) continue;

        const model = MODELS[type];
        const [jx, jz] = objectOffset(ox, oz);
        const wx = ((ox * TILE) | 0) + jx;
        const wz = ((oz * TILE) | 0) + jz;

        const ddx = (this.x - wx) / TILE;
        const ddz = (this.z - wz) / TILE;
        const r = model.radius / TILE + SHIP_RADIUS;
        if (ddx * ddx + ddz * ddz > r * r) continue;

        // Are we low enough to be in it?
        const base = landAltitude(wx, wz);
        const top = (base - model.height) | 0;
        if ((this.y + UNDERCARRIAGE_Y) < top) continue;

        this.die(game, 'crash');
        return true;
      }
    }
    return false;
  }

  die(game, how) {
    if (this.dead) return;
    this.dead = true;
    this.deathTimer = 110;
    spawnExplosion(this.x, this.y, this.z, 60, TILE * 0.045, null);
    spawnSparks(this.x, this.y, this.z, 20);
    game.onDeath(how);
  }

  // -- drawing --------------------------------------------------------------

  draw(rd, camX, camY, camZ) {
    if (this.dead) return;
    drawModel(rd, SHIP_MODEL, this.matrix, this.x, this.y, this.z, camX, camY, camZ);

    // A flame licking out of the engine while the motor is lit.
    if (this.thrusting) {
      const up = matApply(this.matrix, 0, -1, 0);
      const len = (this.thrusting === 2 ? 0.75 : 0.4) * (0.7 + rnd() * 0.6);
      drawFlame(rd, this, up, len, camX, camY, camZ);
    }
  }
}

// --- model drawing ---------------------------------------------------------

const scratch = [];
const pt = { x: 0, y: 0 };

// Draw a model's faces back to front. With only a dozen or so faces per
// object a straight depth sort is cheaper than anything cleverer, and it
// copes with the concave shapes (legs, fins) that culling alone would not.
export function drawModel(rd, model, matrix, wx, wy, wz, camX, camY, camZ) {
  const verts = model.verts;
  const n = verts.length / 3;

  // Transform and project every vertex once.
  while (scratch.length < n * 3) scratch.push(0);
  let anyVisible = false;
  for (let i = 0; i < n; i++) {
    let px = verts[i * 3], py = verts[i * 3 + 1], pz = verts[i * 3 + 2];
    if (matrix) {
      const r = matApply(matrix, px, py, pz);
      px = r[0]; py = r[1]; pz = r[2];
    }
    const vx = (wx + px - camX) | 0;
    const vy = (wy + py - camY) | 0;
    const vz = (wz + pz - camZ) | 0;
    if (project(vx, vy, vz, pt)) {
      scratch[i * 3] = pt.x;
      scratch[i * 3 + 1] = pt.y;
      scratch[i * 3 + 2] = vz;
      anyVisible = true;
    } else {
      scratch[i * 3 + 2] = -1; // behind the camera
    }
  }
  if (!anyVisible) return;

  // Depth-sort the faces by their mean distance.
  const faces = model.faces;
  const order = [];
  for (let f = 0; f < faces.length; f++) {
    const idx = faces[f].idx;
    let depth = 0, ok = true;
    for (let k = 0; k < idx.length; k++) {
      const d = scratch[idx[k] * 3 + 2];
      if (d < 0) { ok = false; break; }
      depth += d;
    }
    if (!ok) continue;
    order.push([depth / idx.length, f]);
  }
  order.sort((a, b) => b[0] - a[0]);

  for (const [, f] of order) {
    const { idx, col } = faces[f];
    const i0 = idx[0] * 3, i1 = idx[1] * 3, i2 = idx[2] * 3;
    if (idx.length === 3) {
      rd.tri(scratch[i0], scratch[i0 + 1], scratch[i1], scratch[i1 + 1],
             scratch[i2], scratch[i2 + 1], col);
    } else {
      const i3 = idx[3] * 3;
      rd.quad(scratch[i0], scratch[i0 + 1], scratch[i1], scratch[i1 + 1],
              scratch[i2], scratch[i2 + 1], scratch[i3], scratch[i3 + 1], col);
    }
  }
}

const fa = { x: 0, y: 0 }, fb = { x: 0, y: 0 }, fc = { x: 0, y: 0 };

function drawFlame(rd, p, up, len, camX, camY, camZ) {
  const bx = p.x - up[0] * TILE * 0.3;
  const by = p.y - up[1] * TILE * 0.3;
  const bz = p.z - up[2] * TILE * 0.3;
  const tx = bx - up[0] * TILE * len;
  const ty = by - up[1] * TILE * len;
  const tz = bz - up[2] * TILE * len;
  const w = TILE * 0.12;

  if (!project((bx - w - camX) | 0, (by - camY) | 0, (bz - camZ) | 0, fa)) return;
  if (!project((bx + w - camX) | 0, (by - camY) | 0, (bz - camZ) | 0, fb)) return;
  if (!project((tx - camX) | 0, (ty - camY) | 0, (tz - camZ) | 0, fc)) return;
  rd.tri(fa.x, fa.y, fb.x, fb.y, fc.x, fc.y, [255, 190, 60]);
  rd.tri((fa.x + fb.x) / 2 - 1.5, fa.y, (fa.x + fb.x) / 2 + 1.5, fa.y,
         (fc.x + (fa.x + fb.x) / 2) / 2, (fc.y + fa.y) / 2, [255, 245, 190]);
}
