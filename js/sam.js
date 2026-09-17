// sam.js -- radar and missile sites.
//
// Everything else in the game wants you low, because low is where the targets
// are and where the flying is interesting. Nothing punished you for climbing:
// the soft ceiling is a limit rather than a threat, and a tank will not fire
// on a craft that is not on the ground.
//
// A missile site is the other half of that argument. It sees a long way but
// it cannot see down, so it turns altitude from a free choice into a cost.
// Cross its ground at a couple of tiles and it never knows you were there;
// cross it high and it takes its time, tells you it has you, and launches.

import { TILE, matRotY, matApply, rnd, rndSigned, rndInt } from './maths.js';
import { Model, shade, facet, drawModel, drawLamp } from './model.js';
import { sky, beacon } from './daylight.js';
import { landAltitude, SEA_LEVEL, isOnLaunchpad, UNDERCARRIAGE_Y } from './landscape.js';
import { spawnExplosion, spawnSparks, spawnSmoke } from './particles.js';
import { objectAt, MODELS } from './objects.js';
import { project } from './renderer.js';

// Rare on purpose. A site is a landmark rather than a population: two of them
// within fifty tiles, trickled in slowly, so meeting one is an event you plan
// a route around instead of a tax on flying at all.
export const MAX_SITES = 2;
export const SAM_SCORE = 600;

const SPAWN_MIN = 24 * TILE;
const SPAWN_MAX = 40 * TILE;
const SPAWN_CHANCE = 0.0026;    // per empty slot per frame: about one a minute
const RETIRE = 56 * TILE;
const HIT_RADIUS = 1.70;        // tiles, for a bomb passing through one
const BLAST_RADIUS = 3.00;
const WRECK_LIFE = 900;

// The radar sees what the dish can see, and nothing else.
//
// The first version asked whether the craft was more than a couple of tiles
// above the ground directly beneath it, which is a rule about the craft
// rather than about the site. It gave the wrong answer in both directions: a
// craft high over a valley the site could not possibly see into counted as
// visible, and one skimming a ridge in plain view of the dish did not.
//
// Three conditions now. The craft has to be above the dish itself -- a dish
// cannot look down through the plinth it is bolted to -- the straight line
// from the dish to the craft has to be clear of everything standing between
// (hills, buildings, blocks, trees), and the craft has to be more than a
// couple of tiles off the surface under it.
//
// That last one is the ground clutter, and it is what makes hugging the
// terrain work even where the terrain is higher than the dish. Without it a
// craft skimming a plateau that happens to stand above a site in the next
// valley is in clear view and perfectly tracked, which is not how anything
// low over ground behaves. The surface it is measured from is the ground or
// the water, whichever is there: the altitude the game already keeps is
// clamped at sea level, so the sea counts as the surface without anything
// having to say so.
// How much bigger than its nominal size the whole site is drawn. It sets the
// dish height, so the radar geometry needs it as much as the models do.
const S = 1.30;

const RADAR_RANGE = 13 * TILE;
const DISH_EYE = TILE * 1.50 * S;   // where the dish sits above its own ground
const LOS_STEP = TILE * 0.5;        // how finely the line is walked
const LOS_MAX_STEPS = 48;
const CLUTTER = TILE * 2;           // clearance under which the craft is lost in it
const SWEEP_RATE = 0.022;       // radians a frame, idling
const TRACK_RATE = 0.055;       // ... and once it has something to look at

// How long it holds you before it shoots, and how fast that decays once you
// drop back down. Losing the lock is deliberately slower than gaining it: a
// hop over the floor and straight back down should still cost you.
// Four and a half seconds from first contact to launch, not two. The whole
// point of the thing is the decision it puts to you, and a decision needs
// long enough to notice the dish, read the bar and get the nose down.
//
// The decay is the other half of that. It is slower than the gain -- 0.7 of a
// frame's worth per frame -- so dropping under the floor works but has to be
// meant: a hop down and straight back up finds the lock most of the way to
// where it was. That was stated in the first version and was not true of it;
// the decay was 1.6, which cleared a full lock in two thirds of the time it
// took to build.
const LOCK_TIME = 225;
const LOCK_DECAY = 0.7;
const RELOAD = 420;

const MISSILE_SPEED = 0.155;    // tiles per frame
const MISSILE_TURN = 0.052;     // radians a frame of homing
const MISSILE_LIFE = 330;
const MISSILE_HIT = 1.05;       // tiles
const MAX_MISSILES = 6;

// --- palette ---------------------------------------------------------------

const BODY     = [ 56,  62,  70];   // charcoal, the colour of the whole thing
const BODY_D   = [ 40,  45,  52];   // its shaded faces
const BODY_L   = [ 74,  81,  90];   // and the ones catching the light
const TRIM     = [242, 150,  46];   // orange, round every edge that matters
const CYAN     = [ 64, 226, 232];   // ribs, and the panel slot
const PANEL_A  = [238, 240, 242];   // the white plates on the plinth
const PANEL_B  = [176, 180, 184];
const HUB      = [240, 242, 245];
const RAIL     = [ 62,  68,  76];
const TUBE     = [ 48,  53,  60];
const WARHEAD  = [214,  74,  58];
const FIN      = [236, 214,  84];
const MARK     = TRIM;
const ALERT    = [255,  64,  56];
const CHAR     = [ 46,  42,  40];
const CHAR_B   = [ 68,  62,  58];

// --- models ----------------------------------------------------------------

function box(m, x0, y0, z0, x1, y1, z1, cols) {
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);
  // A single colour goes in bare -- a colour is already an array, so wrapping
  // it in another list gives NaN when it is shaded.
  const c = Array.isArray(cols) ? { all: cols } : cols;
  const pick = (k) => c[k] || c.all;

  const q = [
    v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1),
    v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1),
  ];
  facet(m, [q[0], q[1], q[2], q[3]], pick('top'));      // y0 is the upper face
  facet(m, [q[4], q[5], q[6], q[7]], pick('bottom'));
  facet(m, [q[0], q[1], q[5], q[4]], pick('back'));
  facet(m, [q[3], q[2], q[6], q[7]], pick('front'));
  facet(m, [q[1], q[2], q[6], q[5]], pick('right'));
  facet(m, [q[0], q[3], q[7], q[4]], pick('left'));
  return q;
}

// A ring of points on a horizontal circle, for the plinth and its collar.
// Everything here is an n-gon rather than a box: the whole shape of the thing
// is round, and four sides would read as a crate with a dish on it.
function ring(m, n, r, y, turn = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + turn;
    out.push(m.vert(Math.cos(a) * r * S, y * S, Math.sin(a) * r * S));
  }
  return out;
}

// The emplacement: a tapered octagonal plinth with a trimmed lip and lit
// panels, a bearing collar, and the launch rails set out either side. The
// tower and the lattice mast are gone -- the dish sits on its own plinth, and
// the whole thing reads as one machine rather than an aerial bolted to a shed.
const PLINTH_N = 8;
const PLINTH_R0 = 0.94;    // at the ground
const PLINTH_R1 = 0.66;    // at the lip
const PLINTH_TOP = -0.66;

function buildBase(burnt) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);
  const body = burnt ? CHAR : BODY;
  const dark = burnt ? CHAR : BODY_D;

  const foot = ring(m, PLINTH_N, PLINTH_R0, 0.02, Math.PI / PLINTH_N);
  const lip = ring(m, PLINTH_N, PLINTH_R1, PLINTH_TOP, Math.PI / PLINTH_N);

  // The tapered flanks, alternating light and dark so the facets read.
  for (let i = 0; i < PLINTH_N; i++) {
    const j = (i + 1) % PLINTH_N;
    facet(m, [lip[i], lip[j], foot[j], foot[i]], i % 2 ? body : dark);
  }
  facet(m, lip.slice().reverse(), burnt ? CHAR_B : BODY_L);

  if (!burnt) {
    // The orange lip, as a band standing just proud of the top edge, and a
    // second one round the foot. It is the only warm colour on the model and
    // it is what makes the silhouette legible against grass or snow.
    const lipA = ring(m, PLINTH_N, PLINTH_R1 + 0.035, PLINTH_TOP + 0.005, Math.PI / PLINTH_N);
    const lipB = ring(m, PLINTH_N, PLINTH_R1 + 0.09, PLINTH_TOP + 0.10, Math.PI / PLINTH_N);
    for (let i = 0; i < PLINTH_N; i++) {
      const j = (i + 1) % PLINTH_N;
      facet(m, [lipA[i], lipA[j], lipB[j], lipB[i]], TRIM);
    }

    // White plates on the flanks, and a cyan slot between them. Proud of the
    // face by a hair so the sort puts them in front of it.
    for (let i = 0; i < PLINTH_N; i++) {
      const a = (i / PLINTH_N) * Math.PI * 2 + Math.PI / PLINTH_N + Math.PI / PLINTH_N;
      const cx = Math.cos(a), cz = Math.sin(a);
      const tx = -cz, tz = cx;                 // along the face
      const push = 0.03;
      const at = (w, y) => v(cx * (0.80 + push) + tx * w, y, cz * (0.80 + push) + tz * w);
      if (i % 2 === 0) {
        facet(m, [at(-0.20, -0.50), at(0.20, -0.50), at(0.20, -0.16), at(-0.20, -0.16)],
              i % 4 === 0 ? PANEL_A : PANEL_B);
      } else {
        facet(m, [at(-0.035, -0.46), at(0.035, -0.46), at(0.055, -0.14), at(-0.055, -0.14)], CYAN);
      }
    }
  }

  // The bearing the dish turns on: a squat collar, stepped.
  const cA = ring(m, PLINTH_N, 0.40, PLINTH_TOP, 0);
  const cB = ring(m, PLINTH_N, 0.40, -0.92, 0);
  for (let i = 0; i < PLINTH_N; i++) {
    const j = (i + 1) % PLINTH_N;
    facet(m, [cB[i], cB[j], cA[j], cA[i]], i % 2 ? body : dark);
  }
  facet(m, cB.slice().reverse(), burnt ? CHAR : BODY_L);

  // Launch rails, low and out to the sides, so the plinth keeps the middle.
  for (const sx of [-0.78, 0.78]) {
    box(m, sx - 0.13, -0.34, -0.42, sx + 0.13, -0.16, 0.34, burnt ? CHAR_B : RAIL);
    box(m, sx - 0.09, -0.50, -0.30, sx + 0.09, -0.34, 0.26, burnt ? CHAR_B : TUBE);
    if (!burnt) {
      facet(m, [
        v(sx - 0.09, -0.50, 0.262), v(sx + 0.09, -0.50, 0.262),
        v(sx + 0.09, -0.34, 0.262), v(sx - 0.09, -0.34, 0.262),
      ], WARHEAD);
      facet(m, [
        v(sx - 0.09, -0.505, -0.30), v(sx + 0.09, -0.505, -0.30),
        v(sx + 0.09, -0.505, -0.12), v(sx - 0.09, -0.505, -0.12),
      ], FIN);
    }
  }
  return m;
}

// The dish, built about its own bearing so it can turn independently of the
// plinth under it.
//
// A twelve-sided charcoal face with an orange rim, cyan ribs running out from
// a white hub, and the feed on a short spike out of the middle. The face is
// dark, so what you actually see when it comes round is the rim and the ribs
// lighting up -- and when it turns away there is nothing on the back at all.
// That contrast is the whole warning system: you can tell where it is looking
// from further away than you can read any instrument.
const DISH_R = 0.84;
const DISH_RAKE = 0.46;         // radians it leans back, looking up and out
const DISH_FACES = 12;
const YOKE = -1.02;             // where the dish hangs off the collar

function buildDish(burnt) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);

  // A point on the dish at radius r, `depth` forward of the panel. Leaning it
  // back rolls the panel's up axis into z, so the disc stays flat and the rim
  // stays a ring.
  const at = (i, r, depth, spin = 0) => {
    const a = ((i + spin) / DISH_FACES) * Math.PI * 2 + Math.PI / DISH_FACES;
    const x = Math.cos(a) * r;
    const u = Math.sin(a) * r;
    return v(x, -u * Math.cos(DISH_RAKE), depth - u * Math.sin(DISH_RAKE));
  };

  const front = [], back = [], rim = [];
  for (let i = 0; i < DISH_FACES; i++) {
    front.push(at(i, DISH_R * 0.93, 0.10));
    rim.push(at(i, DISH_R, 0.05));
    back.push(at(i, DISH_R * 0.93, -0.04));
  }

  // The face goes in as twelve wedges rather than one polygon. That is not
  // decoration: faces are sorted back to front by their centre, and a single
  // disc has one centre, so anything drawn on the half of it that leans away
  // from you sorts behind the whole disc and vanishes. The first build lost
  // the top six ribs to exactly that. Wedges put each rib next to facets at
  // its own depth, and they give the dish the faceted shading it wants.
  const hubF = [];
  for (let i = 0; i < DISH_FACES; i++) hubF.push(at(i, 0.20, 0.10));
  for (let i = 0; i < DISH_FACES; i++) {
    const j = (i + 1) % DISH_FACES;
    facet(m, [hubF[i], front[i], front[j], hubF[j]],
          burnt ? CHAR_B : shade(BODY_D, i % 2 ? 1.0 : 0.86));
  }
  const hubB = [];
  for (let i = 0; i < DISH_FACES; i++) hubB.push(at(i, 0.20, -0.04));
  for (let i = 0; i < DISH_FACES; i++) {
    const j = (i + 1) % DISH_FACES;
    facet(m, [hubB[j], back[j], back[i], hubB[i]],
          burnt ? CHAR : shade(BODY, i % 2 ? 1.0 : 0.88));
  }
  // The rim, in orange, as a band round the edge on both sides.
  for (let i = 0; i < DISH_FACES; i++) {
    const j = (i + 1) % DISH_FACES;
    facet(m, [front[i], front[j], rim[j], rim[i]], burnt ? CHAR : TRIM);
    facet(m, [rim[i], rim[j], back[j], back[i]], burnt ? CHAR : shade(TRIM, 0.62));
  }

  if (!burnt) {
    // Ribs out from the hub, a hair proud of the face so the depth sort puts
    // them in front of it rather than fighting with it.
    // Each rib goes in as three segments rather than one long quad. Same
    // reason the face is wedges: a quad spanning several wedges sorts by its
    // middle, so the far end of it disappears behind the panel it lies on.
    // One long rib came out dashed; three short ones do not.
    const SEGS = 3;
    for (let i = 0; i < DISH_FACES; i++) {
      for (let k = 0; k < SEGS; k++) {
        const r0 = 0.19 + (DISH_R * 0.90 - 0.19) * (k / SEGS);
        const r1 = 0.19 + (DISH_R * 0.90 - 0.19) * ((k + 1) / SEGS);
        const w0 = 0.036 - 0.018 * (k / SEGS);
        const w1 = 0.036 - 0.018 * ((k + 1) / SEGS);
        facet(m, [
          at(i - w0, r0, 0.125), at(i + w0, r0, 0.125),
          at(i + w1, r1, 0.125), at(i - w1, r1, 0.125),
        ], CYAN);
      }
    }
    // The hub, over the top of where they all meet.
    const hub = [];
    for (let i = 0; i < DISH_FACES; i++) hub.push(at(i, 0.23, 0.15));
    facet(m, hub, HUB);
  }

  // The feed, on a spike out of the hub, angled as the reference has it.
  box(m, -0.045, -0.30, 0.12, 0.045, -0.04, 0.30, burnt ? CHAR : BODY_D);
  if (!burnt) {
    facet(m, [
      v(-0.045, -0.34, 0.26), v(0.045, -0.34, 0.26),
      v(0.045, -0.28, 0.32), v(-0.045, -0.28, 0.32),
    ], CYAN);
  }

  // The pedestal, from the back of the dish down to the bearing it turns on.
  // It has to reach: with a short stub the dish hung in mid air the moment it
  // came side on and the gap was in plain sight.
  box(m, -0.24, -0.10, -0.32, 0.24, 0.34, -0.04, burnt ? CHAR : BODY);
  box(m, -0.17, 0.30, -0.26, 0.17, 0.60, -0.02, burnt ? CHAR : BODY_D);
  return m;
}

const BASE = buildBase(false);
const BASE_WRECK = buildBase(true);
const DISH_M = buildDish(false);
const DISH_WRECK = buildDish(true);

// --- state -----------------------------------------------------------------

const ALIVE = 0, WRECK = 1;
const sites = [];
for (let i = 0; i < MAX_SITES; i++) sites.push({ live: false, state: ALIVE });

const missiles = [];
let launched = 0;

export function resetSams() {
  for (const s of sites) { s.live = false; s.state = ALIVE; }
  missiles.length = 0;
  launched = 0;
}

export function samCount() {
  return sites.reduce((n, s) => n + (s.live && s.state === ALIVE ? 1 : 0), 0);
}

export function missilesLaunchedTotal() {
  return launched;
}

// The worst lock anywhere, 0 to 1, for the HUD and the warning tone to read.
// One number rather than a list: you do not need to know which site has you,
// you need to know how long you have.
export function samThreat() {
  let worst = 0;
  for (const s of sites) {
    if (s.live && s.state === ALIVE) worst = Math.max(worst, s.lock / LOCK_TIME);
  }
  return Math.min(1, worst);
}

export function missilesInFlight() {
  return missiles.length;
}

function place(s, px, pz) {
  // Somewhere in a ring around the player, on ground flat enough to build on
  // and clear of the pad. A site that spawns on a cliff reads as scenery.
  for (let attempt = 0; attempt < 16; attempt++) {
    const a = rnd() * Math.PI * 2;
    const r = SPAWN_MIN + rnd() * (SPAWN_MAX - SPAWN_MIN);
    const x = (px + Math.cos(a) * r) | 0;
    const z = (pz + Math.sin(a) * r) | 0;
    if (isOnLaunchpad(x, z)) continue;

    const base = landAltitude(x, z);
    if (base >= SEA_LEVEL - TILE * 0.4) continue;

    // Flat: no corner of the apron more than a third of a tile off the middle.
    let flat = true;
    for (let i = 0; i < 4 && flat; i++) {
      const b = (i / 4) * Math.PI * 2;
      const h = landAltitude((x + Math.cos(b) * TILE * 0.8) | 0,
                             (z + Math.sin(b) * TILE * 0.8) | 0);
      if (Math.abs(h - base) > TILE * 0.33) flat = false;
    }
    if (!flat) continue;

    s.live = true;
    s.state = ALIVE;
    s.x = x; s.z = z;
    s.dish = rnd() * Math.PI * 2;
    s.lock = 0;
    s.reload = rndInt(RELOAD);
    s.wreckTimer = 0;
    s.smokeTick = rndInt(20);
    s.blinkAt = rndInt(46);
    return true;
  }
  return false;
}

// --- update ----------------------------------------------------------------

export function updateSams(player, game) {
  const px = player.x, pz = player.z;

  for (const s of sites) {
    if (!s.live) {
      if (rnd() < SPAWN_CHANCE) place(s, px, pz);
      continue;
    }

    if (Math.hypot(s.x - px, s.z - pz) > RETIRE) { s.live = false; continue; }

    if (s.state === WRECK) {
      if (--s.wreckTimer <= 0) { s.live = false; continue; }
      if ((s.smokeTick = (s.smokeTick + 1) % 9) === 0) {
        spawnSmoke(s.x, (landAltitude(s.x, s.z) - TILE * 0.6) | 0, s.z);
      }
      continue;
    }

    // Can it see you? In range, above the dish, clear of the clutter, and
    // nothing in the way. The first three are arithmetic and the last is a
    // walk along the line, so they are asked in that order -- most of the
    // time the answer is no before the expensive question is reached.
    const base = landAltitude(s.x, s.z);
    const eyeY = (base - DISH_EYE) | 0;
    const range = Math.hypot(px - s.x, pz - s.z);
    const seen = !player.dead && range < RADAR_RANGE &&
                 player.y < eyeY &&
                 player.altitude > CLUTTER &&
                 clearLine(s.x, eyeY, s.z, px, player.y, pz);

    if (seen) {
      // Swing onto the bearing rather than snapping to it: the dish coming
      // round to face you is the first thing you get, before any siren.
      const want = Math.atan2(px - s.x, pz - s.z);
      let d = want - s.dish;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      s.dish += Math.max(-TRACK_RATE, Math.min(TRACK_RATE, d));
      s.lock++;
    } else {
      s.dish += SWEEP_RATE;
      s.lock -= LOCK_DECAY;
      if (s.lock < 0) s.lock = 0;
    }

    if (s.reload > 0) s.reload--;
    if (s.lock >= LOCK_TIME && s.reload === 0 && missiles.length < MAX_MISSILES) {
      launch(s, player, game);
      s.lock = LOCK_TIME * 0.45;      // it still has you; it just has to reload
      s.reload = RELOAD + rndInt(120);
    }
  }

  updateMissiles(player, game);
}

// Is the straight line from the dish to the craft clear of the landscape and
// of whatever is standing on it? Walked at half-tile steps, which is fine
// enough that a single hill cannot be stepped over and coarse enough to cost
// about as much as one row of the landscape scan.
//
// Remember +y points down: ground is in the way when its top is ABOVE the
// ray, which means a smaller y.
function clearLine(x0, y0, z0, x1, y1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  const flat = Math.hypot(dx, dz);
  let steps = Math.ceil(flat / LOS_STEP);
  if (steps < 2) return true;
  if (steps > LOS_MAX_STEPS) steps = LOS_MAX_STEPS;

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = (x0 + dx * t) | 0;
    const z = (z0 + dz * t) | 0;
    const rayY = y0 + (y1 - y0) * t;

    let top = landAltitude(x, z);
    // Whatever is standing on that tile stands in the way too. The model's
    // own height is enough -- a tree is not wide enough for its footprint to
    // matter at this sampling, and the tile it is recorded on is where it is.
    const type = objectAt(x >> 24, z >> 24);
    if (type >= 0) {
      const m = MODELS[type];
      if (m) top -= m.height;
    }

    if (top < rayY) return false;
  }
  return true;
}

function launch(s, player, game) {
  const base = landAltitude(s.x, s.z);
  const side = rnd() < 0.5 ? -0.30 : 0.30;
  const x = (s.x + side * S * TILE) | 0;
  const y = (base - TILE * 0.5) | 0;
  const z = s.z;

  const dx = player.x - x;
  const dy = (player.y + UNDERCARRIAGE_Y * 0.5) - y;
  const dz = player.z - z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const sp = MISSILE_SPEED * TILE;

  missiles.push({
    x, y, z,
    vx: (dx / len) * sp, vy: (dy / len) * sp, vz: (dz / len) * sp,
    life: MISSILE_LIFE, trail: 0,
  });
  launched++;
  spawnSparks(x, y, z, 8);
  game.onSamLaunch(x, y, z);
}

function updateMissiles(player, game) {
  const sp = MISSILE_SPEED * TILE;

  for (let i = missiles.length - 1; i >= 0; i--) {
    const m = missiles[i];

    // Homing, as a limited turn towards the craft rather than a straight line
    // to it. A missile that simply tracks is unavoidable and therefore not a
    // decision; one that has to turn can be made to overshoot.
    if (!player.dead) {
      const dx = player.x - m.x, dy = player.y - m.y, dz = player.z - m.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const wx = (dx / len) * sp, wy = (dy / len) * sp, wz = (dz / len) * sp;
      m.vx += (wx - m.vx) * MISSILE_TURN;
      m.vy += (wy - m.vy) * MISSILE_TURN;
      m.vz += (wz - m.vz) * MISSILE_TURN;
      // Re-normalise, so turning costs nothing in speed.
      const v = Math.hypot(m.vx, m.vy, m.vz) || 1;
      m.vx = (m.vx / v) * sp; m.vy = (m.vy / v) * sp; m.vz = (m.vz / v) * sp;
    }

    m.x = (m.x + m.vx) | 0;
    m.y = (m.y + m.vy) | 0;
    m.z = (m.z + m.vz) | 0;

    if ((m.trail = (m.trail + 1) % 3) === 0) spawnSmoke(m.x, m.y, m.z);

    let done = --m.life <= 0;

    if (!done && !player.dead) {
      const dx = (m.x - player.x) / TILE;
      const dy = (m.y - player.y) / TILE;
      const dz = (m.z - player.z) / TILE;
      if (dx * dx + dy * dy + dz * dz < MISSILE_HIT * MISSILE_HIT) {
        spawnExplosion(m.x, m.y, m.z, 18, TILE * 0.034, null);
        game.onPlayerHitBySam();
        done = true;
      }
    }

    if (!done && m.y >= landAltitude(m.x, m.z)) {
      const g = landAltitude(m.x, m.z);
      if (g < SEA_LEVEL) spawnExplosion(m.x, g, m.z, 10, TILE * 0.02, null);
      done = true;
    }

    if (done) missiles.splice(i, 1);
  }
}

// --- being hit -------------------------------------------------------------

export function samHit(bx, by, bz, game) {
  for (const s of sites) {
    if (!s.live || s.state !== ALIVE) continue;
    const dx = (bx - s.x) / TILE, dz = (bz - s.z) / TILE;
    if (dx * dx + dz * dz > HIT_RADIUS * HIT_RADIUS) continue;
    const base = landAltitude(s.x, s.z);
    if (by < base - TILE * 1.4 || by > base + TILE * 0.3) continue;
    destroy(s, game);
    return true;
  }
  return false;
}

// A bomb that went off nearby rather than through one.
export function samBlast(bx, by, bz, game) {
  for (const s of sites) {
    if (!s.live || s.state !== ALIVE) continue;
    const dx = (bx - s.x) / TILE, dz = (bz - s.z) / TILE;
    if (dx * dx + dz * dz > BLAST_RADIUS * BLAST_RADIUS) continue;
    destroy(s, game);
  }
}

function destroy(s, game) {
  const base = landAltitude(s.x, s.z);
  s.state = WRECK;
  s.wreckTimer = WRECK_LIFE;
  s.lock = 0;
  // The rounds still on the rails go up with it, which is why a site is worth
  // more than anything else in the game.
  spawnExplosion(s.x, (base - TILE * 0.5) | 0, s.z, 52, TILE * 0.05, null);
  spawnSparks(s.x, (base - TILE * 0.3) | 0, s.z, 22);
  game.onSamDestroyed(s.x, base, s.z);
}

// --- drawing ---------------------------------------------------------------

export function samsInRow(zLo, zHi, out) {
  for (const s of sites) {
    if (s.live && s.z >= zLo && s.z < zHi) out.push(s);
  }
  return out;
}

const dishMat = new Float64Array(9);

export function drawSam(rd, s, camX, camY, camZ, fog = 0) {
  const base = landAltitude(s.x, s.z);
  const wrecked = s.state !== ALIVE;

  matRotY(0, dishMat);
  drawModel(rd, wrecked ? BASE_WRECK : BASE, dishMat,
            s.x, base, s.z, camX, camY, camZ, fog);

  matRotY(s.dish, dishMat);
  drawModel(rd, wrecked ? DISH_WRECK : DISH_M, dishMat,
            s.x, (base - TILE * 1.50 * S) | 0, s.z, camX, camY, camZ, fog);

  if (wrecked) return;

  // A red lamp on the mast, blinking faster the closer it is to launching.
  // It is the same information the HUD carries, put where you are looking --
  // at the thing that is about to shoot you.
  const t = Math.min(1, s.lock / LOCK_TIME);
  const period = t > 0 ? Math.max(8, Math.round(46 - 34 * t)) : 46;
  if (beacon(period, Math.max(3, period >> 1), s.blinkAt | 0)) {
    // On the apron corners rather than the tower: the dish swings right round,
    // and a warning light the warning itself can hide is no warning.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      drawLamp(rd, (s.x + Math.cos(a) * 0.74 * S * TILE) | 0,
               (base - TILE * 0.60 * S) | 0,
               (s.z + Math.sin(a) * 0.74 * S * TILE) | 0, camX, camY, camZ,
               0.018 + 0.030 * t, t > 0.02 ? ALERT : MARK, fog);
    }
  }
}

const mp = { x: 0, y: 0 };

// Missiles draw straight rather than bucketed by row: they are brief and in
// the air, and one lost behind a hill is a hit you could not have read.
export function drawMissiles(rd, camX, camY, camZ) {
  for (const m of missiles) {
    if (!project((m.x - camX) | 0, (m.y - camY) | 0, (m.z - camZ) | 0, mp)) continue;
    const x = Math.round(mp.x), y = Math.round(mp.y);
    rd.rect(x - 1, y - 1, 3, 3, WARHEAD);
    rd.rect(x, y, 1, 1, [255, 232, 200]);
  }
}
