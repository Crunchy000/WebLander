// tanks.js -- moving ground targets.
//
// Unlike the scenery, which is a pure function of tile coordinates and stores
// nothing, tanks are real entities: they drive about, so they need state. The
// pool is small and recycled -- they are spawned in a ring around the player
// and retired once they fall far behind, so however far you fly there are only
// ever a handful being simulated.

import { TILE, matRotY, matFromAim, matApply, rnd, rndSigned, rndInt } from './maths.js';
import { Model, shade, facet, drawModel } from './model.js';
import { landAltitude, SEA_LEVEL, isOnLaunchpad, UNDERCARRIAGE_Y } from './landscape.js';
import { spawnExplosion, spawnSparks, spawnSmoke } from './particles.js';
import { project } from './renderer.js';

export const MAX_TANKS = 9;
export const TANK_SCORE = 150;

const SPAWN_MIN = 14 * TILE;    // ring in which new tanks appear
const SPAWN_MAX = 26 * TILE;
const RETIRE = 44 * TILE;       // ... and beyond which they are recycled
const HIT_RADIUS = 1.00;        // tiles, for a bomb passing through one
const BLAST_RADIUS = 2.1;       // tiles, for the explosion where it lands
const WRECK_LIFE = 900;         // frames a burnt-out hull lingers

// Gunnery. Tanks only open up on a craft that is sitting on the ground: in
// the air you are a hard target and it would just be unfair, but the moment
// you set down to charge you are a stationary one, which is the whole tension
// of stopping to charge in the open.
const GUN_RANGE = 13 * TILE;
const RELOAD = 150;             // frames between rounds
const AIM_TOLERANCE = 0.30;     // radians the turret must be within to fire
const SHELL_SPEED = 0.21;       // tiles per frame
const SHELL_HIT = 0.9;          // tiles
const MAX_SHELLS = 24;

const shells = [];
let shellsFired = 0;

// --- models ----------------------------------------------------------------

const HULL_A  = [ 62,  74,  92];   // flanks, cold steel blue
const HULL_B  = [ 44,  54,  68];   // shadowed panels
const HULL_C  = [ 58,  92,  96];   // teal-tinted plate
const GLACIS  = [ 82, 100, 118];   // sloped front, catches the light
const DECK    = [ 96, 110, 128];
const REAR    = [ 70,  58,  72];   // engine deck, warmer
const TRACK   = [ 28,  29,  34];
const TRACK_B = [ 64,  66,  74];
const TURRET  = [ 72,  66, 104];   // indigo, distinct from the hull
const TURRET_T= [104,  96, 142];
const BARREL  = [116, 122, 136];
const OPTIC   = [ 86, 236, 244];   // sensor block, cyan
const MARK    = [255, 150,  40];   // hazard markings, so they read as targets
const MARK_B  = [255, 208,  64];
const MARK_C  = [236,  72,  62];
const CHAR    = [ 46,  42,  40];
const CHAR_B  = [ 68,  62,  58];

// Vertices go through here so the whole vehicle can be scaled in one place.
const S = 1.38;

// A box whose six faces can each take their own colour. Passing a single
// colour paints the lot; passing an object names the faces individually,
// which is what gives the hull its patchwork of tones.
function box(m, x0, y0, z0, x1, y1, z1, cols) {
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);
  const c = Array.isArray(cols) ? { all: cols } : cols;
  const pick = (k) => c[k] || c.all || c.body;

  const q = [
    v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1),
    v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1),
  ];
  facet(m, [q[0], q[1], q[2], q[3]], pick('top'));      // y0 is the upper face
  facet(m, [q[4], q[5], q[6], q[7]], pick('bottom'));
  facet(m, [q[0], q[1], q[5], q[4]], pick('back'));     // -z
  facet(m, [q[3], q[2], q[6], q[7]], pick('front'));    // +z
  facet(m, [q[1], q[2], q[6], q[5]], pick('right'));
  facet(m, [q[0], q[3], q[7], q[4]], pick('left'));
  return q;
}

// Hull and tracks. Sits with its belly on the ground, nose towards +z.
function buildHull(burnt) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);
  const body = burnt ? CHAR : HULL_A;
  const deck = burnt ? CHAR_B : DECK;
  const trk = burnt ? CHAR : TRACK;

  const trackCols = burnt ? [CHAR] : { all: trk, top: TRACK_B, right: HULL_B, left: HULL_B };
  box(m, -0.46, -0.16, -0.62, -0.28, 0.02, 0.62, trackCols);
  box(m,  0.28, -0.16, -0.62,  0.46, 0.02, 0.62, trackCols);

  // Hull between them, each panel its own tone.
  box(m, -0.30, -0.30, -0.56, 0.30, -0.02, 0.40, burnt ? [CHAR] : {
    all: body, top: deck, right: HULL_A, left: HULL_C, back: REAR, front: GLACIS,
  });

  // Sloped glacis plate at the front.
  facet(m, [
    v(-0.30, -0.30, 0.40), v(0.30, -0.30, 0.40),
    v(0.30, -0.04, 0.64), v(-0.30, -0.04, 0.64),
  ], burnt ? CHAR_B : GLACIS);

  if (!burnt) {
    // Deck stripe, for when you are directly overhead.
    facet(m, [
      v(-0.30, -0.31, -0.20), v(0.30, -0.31, -0.20),
      v(0.30, -0.31, -0.06), v(-0.30, -0.31, -0.06),
    ], MARK);

    // Flank chevrons. These are the ones that do the work: from the air you
    // mostly see a tank side-on, and a dark hull on dark tracks needs
    // something bright at eye level to separate it from the ground.
    for (const sgn of [1, -1]) {
      const x = sgn * 0.305;
      for (const [z0, z1, col] of [[-0.40, -0.18, MARK], [-0.10, 0.12, MARK_B], [0.20, 0.38, MARK]]) {
        facet(m, [
          v(x, -0.26, z0), v(x, -0.26, z1),
          v(x, -0.10, z1), v(x, -0.10, z0),
        ], col);
      }
    }
  }
  return m;
}

// Turret and gun, built about its own pivot so it can rotate independently --
// and, once the tank is killed, fly off on its own.
function buildTurret(burnt) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);
  const t = burnt ? CHAR : TURRET;

  box(m, -0.22, -0.26, -0.24, 0.22, 0.00, 0.22, burnt ? [CHAR] : {
    all: t, top: TURRET_T, front: shade(t, 1.25), back: MARK_C,
  });
  if (!burnt) {
    // Optics block on the front face.
    facet(m, [
      v(-0.09, -0.24, 0.225), v(0.09, -0.24, 0.225),
      v(0.09, -0.16, 0.225), v(-0.09, -0.16, 0.225),
    ], OPTIC);
  }
  if (!burnt) {
    for (const sgn of [1, -1]) {
      facet(m, [
        v(sgn * 0.225, -0.22, -0.18), v(sgn * 0.225, -0.22, 0.16),
        v(sgn * 0.225, -0.12, 0.16), v(sgn * 0.225, -0.12, -0.18),
      ], MARK);
    }
  }
  // Gun.
  box(m, -0.045, -0.20, 0.20, 0.045, -0.11, 0.78, burnt ? [CHAR_B] : [BARREL]);
  if (!burnt) {
    facet(m, [
      v(-0.045, -0.20, 0.78), v(0.045, -0.20, 0.78),
      v(0.045, -0.11, 0.78), v(-0.045, -0.11, 0.78),
    ], MARK);
  }
  return m;
}

const HULL = buildHull(false);
const HULL_WRECK = buildHull(true);
const TURRET_M = buildTurret(false);
const TURRET_WRECK = buildTurret(true);

// --- state -----------------------------------------------------------------

const ALIVE = 0, DYING = 1, WRECK = 2;

const tanks = [];
for (let i = 0; i < MAX_TANKS; i++) {
  tanks.push({ live: false, state: ALIVE });
}

export function resetTanks() {
  for (const t of tanks) { t.live = false; t.state = ALIVE; }
  shells.length = 0;
  shellsFired = 0;
}

export function shellCount() {
  return shells.length;
}

// Rounds fired since the last reset. A shell is consumed the moment it
// arrives, so the live count is a transient and useless for telling whether
// the guns are working.
export function shellsFiredTotal() {
  return shellsFired;
}

export function tankCount() {
  return tanks.reduce((n, t) => n + (t.live ? 1 : 0), 0);
}

function placeTank(t, px, pz) {
  // Somewhere in a ring around the player, on dry land, clear of the pad.
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = rnd() * Math.PI * 2;
    const r = SPAWN_MIN + rnd() * (SPAWN_MAX - SPAWN_MIN);
    const x = (px + Math.cos(a) * r) | 0;
    const z = (pz + Math.sin(a) * r) | 0;
    if (isOnLaunchpad(x, z)) continue;
    if (landAltitude(x, z) >= SEA_LEVEL - TILE * 0.3) continue;

    t.live = true;
    t.state = ALIVE;
    t.x = x; t.z = z;
    t.heading = rnd() * Math.PI * 2;
    t.turret = t.heading;
    t.speed = (0.010 + rnd() * 0.010) * TILE;   // per frame
    t.turnTimer = 60 + rndInt(180);
    t.wreckTimer = 0;
    t.smokeTick = rndInt(20);
    t.reload = RELOAD + rndInt(RELOAD);
    return true;
  }
  return false;
}

// --- update ----------------------------------------------------------------

export function updateTanks(player, game) {
  const px = player.x, pz = player.z;

  for (const t of tanks) {
    if (!t.live) {
      // Trickle new ones in rather than spawning a whole wave at once.
      if (rnd() < 0.02) placeTank(t, px, pz);
      continue;
    }

    // Retire anything left far behind.
    const dx = (t.x - px) / TILE, dz = (t.z - pz) / TILE;
    if (Math.hypot(dx, dz) * TILE > RETIRE) { t.live = false; continue; }

    if (t.state === WRECK) {
      if (--t.wreckTimer <= 0) { t.live = false; continue; }
      if ((t.smokeTick = (t.smokeTick + 1) % 9) === 0) {
        spawnSmoke(t.x, (landAltitude(t.x, t.z) - TILE * 0.5) | 0, t.z);
      }
      continue;
    }

    if (t.state === DYING) {
      // The turret is still in the air.
      t.tvy += 0x2800;
      t.tx += t.tvx; t.ty += t.tvy; t.tz += t.tvz;
      t.tspin += t.tspinRate;
      const ground = landAltitude(t.tx, t.tz);
      if (t.ty >= ground) {
        t.ty = ground;
        t.state = WRECK;
        t.wreckTimer = WRECK_LIFE;
        spawnSparks(t.tx, t.ty, t.tz, 8);
      }
      if ((t.smokeTick = (t.smokeTick + 1) % 5) === 0) {
        spawnSmoke(t.x, (landAltitude(t.x, t.z) - TILE * 0.5) | 0, t.z);
      }
      continue;
    }

    // Driving. Change course now and then.
    if (--t.turnTimer <= 0) {
      t.heading += rndSigned() * 1.2;
      t.turnTimer = 70 + rndInt(200);
    }

    const nx = (t.x + Math.sin(t.heading) * t.speed) | 0;
    const nz = (t.z + Math.cos(t.heading) * t.speed) | 0;

    // Turn back from the shoreline rather than driving into the sea.
    if (landAltitude(nx, nz) >= SEA_LEVEL - TILE * 0.2) {
      t.heading += 1.6 + rnd();
      t.turnTimer = 40 + rndInt(60);
    } else {
      t.x = nx; t.z = nz;
    }

    // The turret tracks the player, which is unsettling and also tells you
    // at a glance which of them have noticed you.
    const want = Math.atan2(px - t.x, pz - t.z);
    let d = want - t.turret;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    t.turret += Math.max(-0.03, Math.min(0.03, d));

    // Open fire on a craft that has set down, once laid on and reloaded.
    if (t.reload > 0) t.reload--;
    const range = Math.hypot(px - t.x, pz - t.z);
    if (player.landed && !player.dead && t.reload === 0 &&
        range < GUN_RANGE && Math.abs(d) < AIM_TOLERANCE &&
        shells.length < MAX_SHELLS) {
      fireShell(t, player, game);
      t.reload = RELOAD + rndInt(60);
    }
  }

  updateShells(player, game);
}

function fireShell(t, player, game) {
  const ground = landAltitude(t.x, t.z);
  const muzzleY = (ground - TILE * 0.42) | 0;
  const mx = (t.x + Math.sin(t.turret) * TILE * 0.9) | 0;
  const mz = (t.z + Math.cos(t.turret) * TILE * 0.9) | 0;

  // Aim at the craft itself rather than the ground under it.
  const tx = player.x, ty = (player.y + UNDERCARRIAGE_Y * 0.5) | 0, tz = player.z;
  const dx = tx - mx, dy = ty - muzzleY, dz = tz - mz;
  const len = Math.hypot(dx, dy, dz) || 1;
  const sp = SHELL_SPEED * TILE;

  shells.push({
    x: mx, y: muzzleY, z: mz,
    vx: (dx / len) * sp, vy: (dy / len) * sp, vz: (dz / len) * sp,
    life: 120,
  });

  shellsFired++;
  spawnSparks(mx, muzzleY, mz, 4);
  game.onTankFired(mx, muzzleY, mz);
}

function updateShells(player, game) {
  for (let i = shells.length - 1; i >= 0; i--) {
    const sh = shells[i];
    sh.x = (sh.x + sh.vx) | 0;
    sh.y = (sh.y + sh.vy) | 0;
    sh.z = (sh.z + sh.vz) | 0;

    let done = --sh.life <= 0;

    // Did it find the craft?
    if (!done && !player.dead) {
      const dx = (sh.x - player.x) / TILE;
      const dy = (sh.y - player.y) / TILE;
      const dz = (sh.z - player.z) / TILE;
      if (dx * dx + dy * dy + dz * dz < SHELL_HIT * SHELL_HIT) {
        spawnExplosion(sh.x, sh.y, sh.z, 14, TILE * 0.03, null);
        game.onPlayerShelled();
        done = true;
      }
    }

    // Or the ground.
    if (!done && sh.y >= landAltitude(sh.x, sh.z)) {
      const g = landAltitude(sh.x, sh.z);
      if (g < SEA_LEVEL) spawnExplosion(sh.x, g, sh.z, 8, TILE * 0.016, null);
      done = true;
    }

    if (done) shells.splice(i, 1);
  }
}

// Shells are drawn straight, not bucketed by row: they are in the air and
// brief, and losing one behind a hill matters less than seeing it coming.
const shellPt = { x: 0, y: 0 };

export function drawShells(rd, camX, camY, camZ) {
  for (const sh of shells) {
    if (!project((sh.x - camX) | 0, (sh.y - camY) | 0, (sh.z - camZ) | 0, shellPt)) continue;
    const x = Math.round(shellPt.x), y = Math.round(shellPt.y);
    // A bright core with a dimmer halo, so a round in flight is unmistakable.
    rd.rect(x - 2, y - 2, 5, 5, [190, 90, 40]);
    rd.rect(x - 1, y - 1, 3, 3, [255, 236, 150]);
  }
}

// --- being hit -------------------------------------------------------------

// Test a bomb against every live tank. Returns true if one was destroyed.
export function tankHit(bx, by, bz, game) {
  for (const t of tanks) {
    if (!t.live || t.state !== ALIVE) continue;

    const dx = (bx - t.x) / TILE, dz = (bz - t.z) / TILE;
    if (dx * dx + dz * dz > HIT_RADIUS * HIT_RADIUS) continue;

    const ground = landAltitude(t.x, t.z);
    if (by < ground - TILE * 1.4 || by > ground + TILE * 0.4) continue;

    killTank(t, game);
    return true;
  }
  return false;
}

// Everything caught by a bomb going off. A free-falling bomb against a moving
// target is a matter of leading it, so the blast has to have some reach --
// requiring a direct hit on something that drives at a tile a second would be
// no fun at all.
export function tankBlast(bx, by, bz, game) {
  let killed = 0;
  for (const t of tanks) {
    if (!t.live || t.state !== ALIVE) continue;
    const dx = (bx - t.x) / TILE, dz = (bz - t.z) / TILE;
    if (dx * dx + dz * dz > BLAST_RADIUS * BLAST_RADIUS) continue;
    killTank(t, game);
    killed++;
  }
  return killed;
}

function killTank(t, game) {
  const ground = landAltitude(t.x, t.z);
  const mid = (ground - TILE * 0.35) | 0;

  // A proper blast: a fast core, slower debris thrown wide, and sparks.
  spawnExplosion(t.x, mid, t.z, 34, TILE * 0.055, null);
  spawnExplosion(t.x, mid, t.z, 26, TILE * 0.022,
    [[120, 116, 108], [86, 84, 80], [150, 62, 34]]);
  spawnSparks(t.x, mid, t.z, 22);

  // Blow the turret off, spinning.
  t.state = DYING;
  t.tx = t.x; t.ty = mid; t.tz = t.z;
  t.tvx = rndSigned() * TILE * 0.018;
  t.tvz = rndSigned() * TILE * 0.018;
  t.tvy = -(TILE * 0.055 + rnd() * TILE * 0.025);
  t.tspin = t.turret;
  t.tspinRate = rndSigned() * 0.34;
  t.smokeTick = 0;

  game.addScore(TANK_SCORE);
  game.onTankDestroyed(t.x, mid, t.z);
}

// --- drawing ---------------------------------------------------------------

const hullMat = new Float64Array(9);
const turMat = new Float64Array(9);

// Tanks are handed to the landscape scan so they draw in the right row, which
// keeps them correctly hidden behind hills in front of them.
export function tanksInRow(zLo, zHi, out) {
  for (const t of tanks) {
    if (!t.live) continue;
    if (t.z >= zLo && t.z < zHi) out.push(t);
  }
  return out;
}

export function drawTank(rd, t, camX, camY, camZ) {
  const ground = landAltitude(t.x, t.z);

  // Pitch the hull to sit along the slope it is standing on.
  const d = TILE * 0.55;
  const ahead = landAltitude((t.x + Math.sin(t.heading) * d) | 0,
                             (t.z + Math.cos(t.heading) * d) | 0);
  const behind = landAltitude((t.x - Math.sin(t.heading) * d) | 0,
                              (t.z - Math.cos(t.heading) * d) | 0);
  const pitch = Math.atan2(ahead - behind, 2 * d);

  matFromAim(t.heading, pitch, hullMat);
  const wrecked = t.state !== ALIVE;
  drawModel(rd, wrecked ? HULL_WRECK : HULL, hullMat,
            t.x, ground, t.z, camX, camY, camZ);

  if (t.state === ALIVE) {
    matRotY(t.turret, turMat);
    const seat = matApply(hullMat, 0, -0.30 * TILE, -0.06 * TILE);
    drawModel(rd, TURRET_M, turMat,
              (t.x + seat[0]) | 0, (ground + seat[1]) | 0, (t.z + seat[2]) | 0,
              camX, camY, camZ);
  } else {
    // Detached turret, wherever it has got to.
    matRotY(t.tspin, turMat);
    drawModel(rd, TURRET_WRECK, turMat, t.tx, t.ty, t.tz, camX, camY, camZ);
  }
}
