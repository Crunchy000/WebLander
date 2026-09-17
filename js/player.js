// player.js -- the lander: how it is drawn, how it flies, and how it dies.
//
// The craft has no independent yaw. It leans, and leaning is what moves you:
// thrust always acts along the ship's own "up" axis, so tilting trades lift
// for sideways acceleration. That single idea is the whole flight model, and
// it is why the controls map so naturally onto a phone you physically tilt.

import { TILE, matFromAim, matApply, clamp, rnd, rndSigned } from './maths.js';
import { Model, shade, facet, drawModel } from './model.js';
import {
  landAltitude, SEA_LEVEL, LAUNCHPAD_ALT, LAUNCHPAD_Y,
  UNDERCARRIAGE_Y, LANDING_SPEED, LANDSCAPE_Z_MID, isOnLaunchpad,
  groundRoughness, FLAT_ENOUGH,
} from './landscape.js';
import { MODELS, objectAt, objectOffset, isWreck, isBlocks, structureIndex } from './objects.js';
import { topple, isKnocked } from './blocks.js';
import { weather } from './weather.js';
import { project } from './renderer.js';
import { spawnExhaust, spawnBomb, spawnExplosion, spawnSparks, spawnDust } from './particles.js';
import { drawUav } from './uav.js';

// Which airframe to fly. The faceted lander and the tilt-rotor UAV share the
// same flight model, so this is a straight swap.
export const AIRFRAME = 'uav';   // 'lander' | 'uav'

// --- tuning ----------------------------------------------------------------

export const GRAVITY_START = 0x02800;
// The eye sits at y = 0, which is also the height of the tallest possible
// peak: the game is played skimming the landscape, within about five tiles of
// the ground, not cruising above it. The engines cut out just above that, so
// climbing is self-limiting and the landscape always stays in frame.
export const HIGHEST_ALTITUDE = -(TILE * 3);

// Where lift starts fading rather than where it stops. A tile and a bit of
// warning is enough to feel the air thinning and back off.
const CEILING_SOFT = HIGHEST_ALTITUDE + TILE * 1.2;
// Battery capacity. Doubled from the original tank so a sortie lasts about
// twice as long; the charge rate is doubled to match, so topping up still
// takes the same time on the ground.
export const CHARGE_MAX = 0x8000;

const THRUST_HOVER = 0x06600;   // hover thrust, doubled again for a much faster feel
const THRUST_FULL  = 0x0C000;   // full-throttle thrust, doubled again
const MAX_LEAN = Math.PI / 2;   // radians at full stick deflection -- exactly 90 degrees of lean
// How far the craft may lean while hover is held. Thrust acts along the roof,
// so leaning trades lift for speed, and past a certain angle there is not
// enough lift left to stand the craft up. Measured: hover holds altitude out
// to 66.9 degrees and sinks at 2.0 tiles/s at the full 90, where full thrust
// carries to 78.0. Hover is the mode you use to place the craft, so it is
// capped where it always climbs -- at 45 degrees it still makes 1.6 tiles/s
// with the stick buried.
const HOVER_LEAN = Math.PI / 4;
// Hover divides its thrust by the cosine of the lean, so the part of it
// pointing at the sky stays the same however far the craft is tipped over:
// lean in hover buys speed without costing height. The floor bounds the
// compensation -- at the 45 degree cap it is 1.41x, and if that cap were ever
// opened up it can never ask for more than double.
const HOVER_FLOOR = Math.max(Math.cos(HOVER_LEAN), 0.5);
const LEAN_RATE = 0.30;         // how fast the craft follows the stick -- snappier response
const DRAG = 0.985;             // damping; without it the craft is unflyable

const DRAW_HOVER = 3;    // power drawn per frame while hovering
const DRAW_FULL = 8;     // ... and under full thrust

// Where the bomb leaves the craft, and how hard it is pushed clear. Barely
// any push: it should fall away rather than be shot downwards.
const BAY_OFFSET = TILE * 0.34;
const RELEASE_SPEED = TILE * 0.010;
// Clearance, in tiles, within which the rotors start lifting dust.
const WASH_HEIGHT = 2.6;
const SHIP_RADIUS = 0.3;   // in tiles, for scenery collisions
const SCAN = 2;            // tiles either way to test for scenery

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
    this.charge = CHARGE_MAX;
    this.charging = false;
    this.landed = true;
    this.dead = false;
    this.deathTimer = 0;
    this.fireCooldown = 0;
    this.thrusting = 0;   // 0 none, 1 hover, 2 full
    // Which lean limit is in force. It follows the last thrust setting the
    // pilot asked for and stays there when the trigger is let go, so the
    // craft handles the same whether you are holding power or coasting.
    // Full range until told otherwise.
    this.leanMode = 2;
    this.grace = LAUNCH_GRACE;
    this.rotorSpin = 0;
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

    // Rotor phase: idling at rest, winding up with the throttle.
    this.rotorSpin = (this.rotorSpin + 0.34 + this.thrusting * 0.30) % (Math.PI * 2);

    // Aim for the lean the stick is asking for, and ease towards it. The
    // magnitude of the deflection sets how hard we tilt, its angle sets which
    // way -- straight from the original's polar treatment of the mouse.
    // Bearing of the stick becomes the craft's heading; how hard you push
    // becomes how far its nose drops. Centring the stick leaves the heading
    // where it was, so the craft holds its facing rather than snapping back.
    const mag = Math.min(1, Math.hypot(stick.x, stick.y));
    // Hover asks for a gentle machine, so it gets one: the same stick travel
    // buys half the lean. The setting latches on the last thrust hit rather
    // than lasting only while the trigger is down -- otherwise the craft's
    // handling changes under you every time you ease off the power, which is
    // the moment you can least afford a surprise. Asked for rather than
    // delivered: a flat battery takes the lift away below, but it should not
    // silently hand back the authority the pilot chose to give up.
    if (thrust) this.leanMode = thrust;
    const targetLean = mag * (this.leanMode === 1 ? HOVER_LEAN : MAX_LEAN);
    const targetDir = (mag > 0.02) ? Math.atan2(stick.x, stick.y) : this.leanDir;

    // Interpolate the direction the short way round the circle.
    let dd = targetDir - this.leanDir;
    while (dd > Math.PI) dd -= Math.PI * 2;
    while (dd < -Math.PI) dd += Math.PI * 2;
    this.leanDir += dd * LEAN_RATE;
    this.lean += (targetLean - this.lean) * LEAN_RATE;

    matFromAim(this.leanDir, this.lean, this.matrix);

    // A flat battery means no thrust at all. Remembering that it was asked
    // for lets the HUD say so, rather than the machine simply going quiet.
    this.flat = thrust > 0 && this.charge <= 0;
    if (this.charge <= 0) thrust = 0;

    // The ceiling is a soft one.
    //
    // It used to be a switch: above a fixed height thrust became zero, the
    // rotors stopped and the engine went silent, and you fell. Worse, the
    // height was measured in world y while the instrument reads height above
    // ground -- so the same ALT gave lift over a valley and none over a hill,
    // which is exactly the kind of thing that feels like a glitch rather than
    // a limit. Measured: cut at ALT 7.5 in one place and ALT 3.7 in another.
    //
    // Now the lift fades out across the last tile or so. The rotors keep
    // turning and the engine keeps running, so it reads as thin air to push
    // against instead of a failure, and the HUD names it.
    let lift = 1;
    this.ceiling = 0;
    if (thrust && this.y < CEILING_SOFT) {
      lift = Math.max(0, (this.y - HIGHEST_ALTITUDE) / (CEILING_SOFT - HIGHEST_ALTITUDE));
      this.ceiling = 1 - lift;
    }
    this.thrusting = thrust;

    if (thrust) {
      let power = (thrust === 2 ? THRUST_FULL : THRUST_HOVER) * lift;
      // Hover keeps whatever climb it had, at any lean it allows. Thrust acts
      // along the roof, so tipping the craft over normally robs the sky of
      // its share; dividing by the cosine puts that share back. Full thrust
      // is left alone -- trading lift for speed is the flying, and a machine
      // that could not be made to sink would not be one.
      if (thrust === 1) power /= Math.max(Math.cos(this.lean), HOVER_FLOOR);
      // "Up" in ship space is -y, since y points down.
      const up = matApply(this.matrix, 0, -1, 0);
      this.vx = (this.vx + up[0] * power) | 0;
      this.vy = (this.vy + up[1] * power) | 0;
      this.vz = (this.vz + up[2] * power) | 0;

      // Rotors turning still cost something, but pushing at a ceiling for no
      // lift should not drain the pack at the full rate.
      const draw = thrust === 2 ? DRAW_FULL : DRAW_HOVER;
      this.charge -= draw * (0.35 + 0.65 * lift);
      if (this.charge < 0) this.charge = 0;

      if (AIRFRAME === 'uav') this.rotorWash();
      else this.emitExhaust(up, thrust);
    }

    // Gravity, then wind, then damping, then move.
    //
    // Wind only has purchase on a machine that is off the ground. Sitting on
    // its skids it is not going anywhere, and a craft that slid about the
    // landing pad in a breeze would be maddening rather than atmospheric.
    this.vy = (this.vy + gravity) | 0;
    if (!this.landed) {
      this.vx = (this.vx + weather.windX) | 0;
      this.vz = (this.vz + weather.windZ) | 0;
    }
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
      this.fireCooldown = 45;
    }

    this.checkGround(game);
  }

  // Downwash off the ground. Only close in, and only over land -- it is grit
  // being thrown about, which is also a useful read on how much clearance is
  // left underneath you.
  rotorWash() {
    const ground = landAltitude(this.x, this.z);
    if (ground >= SEA_LEVEL) return;

    const clearance = (ground - (this.y + UNDERCARRIAGE_Y)) / TILE;
    if (clearance < 0 || clearance > WASH_HEIGHT) return;

    // Thicker the lower you are.
    const strength = 1 - clearance / WASH_HEIGHT;
    if (rnd() > strength * 0.9) return;

    const a = rnd() * Math.PI * 2;
    const r = (0.5 + rnd() * 0.8) * TILE;
    const speed = TILE * (0.004 + 0.010 * strength);
    spawnDust(
      (this.x + Math.cos(a) * r) | 0,
      ground,
      (this.z + Math.sin(a) * r) | 0,
      Math.cos(a) * speed,
      Math.sin(a) * speed,
    );
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
    // Bombs are dropped, not fired. They leave the bay along the craft's own
    // down axis, carrying its velocity, and gravity does the rest -- so you
    // aim by flying over the target rather than by pointing at it.
    const down = matApply(this.matrix, 0, 1, 0);

    spawnBomb(
      (this.x + down[0] * BAY_OFFSET) | 0,
      (this.y + down[1] * BAY_OFFSET) | 0,
      (this.z + down[2] * BAY_OFFSET) | 0,
      (this.vx + down[0] * RELEASE_SPEED) | 0,
      (this.vy + down[1] * RELEASE_SPEED) | 0,
      (this.vz + down[2] * RELEASE_SPEED) | 0,
    );
  }

  // -- contact with the ground ----------------------------------------------

  checkGround(game) {
    if (this.hitScenery(game)) return;

    const ground = landAltitude(this.x, this.z);
    const feet = (this.y + UNDERCARRIAGE_Y) | 0;

    if (feet < ground) {
      this.landed = false;
      this.charging = false;
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

    // Charge anywhere the ground is level enough to sit square on. The pad is
    // simply the best surface there is -- but it is also the one place every
    // tank on the map knows how to find.
    const flat = onPad || groundRoughness(this.x, this.z) <= FLAT_ENOUGH;
    this.charging = flat && this.charge < CHARGE_MAX;

    if (this.charging) {
      this.charge = Math.min(CHARGE_MAX, this.charge + (onPad ? 80 : 52));
      game.onCharging();
    }
  }

  // Flying into the scenery. A tree is fatal, as it always was -- the original
  // keeps a minimum safe height for clearing objects and this is the same idea
  // done as a cylinder test, so you can thread between two trees but not
  // through one.
  //
  // A stack of wooden blocks is not fatal. It falls over, which is the only
  // thing a stack of blocks has ever done when something flew into it, and it
  // would be a poor toy box that punished you for finding that out.
  hitScenery(game) {
    const tx = this.x >> 24, tz = this.z >> 24;

    // Two tiles either way, not one. A block structure now reaches over a
    // tile from its own centre, so a neighbour-only scan could put you
    // through the end of a bridge without ever testing it.
    for (let dz = -SCAN; dz <= SCAN; dz++) {
      for (let dx = -SCAN; dx <= SCAN; dx++) {
        const ox = (tx + dx) | 0, oz = (tz + dz) | 0;
        const type = objectAt(ox, oz);
        if (type < 0 || isWreck(type)) continue;

        const blocks = isBlocks(type);
        if (blocks && isKnocked(ox, oz)) continue;   // already down; fly over it

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

        if (blocks) {
          this.knockOver(game, ox, oz, type, wx, base, wz);
          continue;
        }

        if (this.protected) return false;
        this.die(game, 'crash');
        return true;
      }
    }
    return false;
  }

  // Shoulder a structure over. The harder you were going, the further the
  // blocks fly; and you come off worse for it too, bouncing back and losing
  // most of your speed, so barging through a village is a real decision
  // rather than a free one.
  knockOver(game, ox, oz, type, wx, base, wz) {
    const speed = this.speed / TILE;
    const force = Math.max(0.9, Math.min(3.2, 0.9 + speed * 26));
    if (!topple(ox, oz, structureIndex(type), wx, base, wz, this.x, this.z, force)) return;

    game.onBlocksKnocked(type, wx, base, wz, force);

    // The rebound: away from the stack, and most of the way stopped.
    let px = this.x - wx, pz = this.z - wz;
    const len = Math.hypot(px, pz) || 1;
    px /= len; pz /= len;
    const kick = TILE * 0.010;
    this.vx = (this.vx * 0.35 + px * kick) | 0;
    this.vz = (this.vz * 0.35 + pz * kick) | 0;
    this.vy = (this.vy * 0.5 - TILE * 0.004) | 0;
  }

  die(game, how) {
    if (this.dead) return;
    // The launch grace covers every cause, tank fire included. Checking here
    // rather than at each call site means a new way of dying cannot forget.
    if (this.protected) return;
    this.dead = true;
    this.deathTimer = 110;
    spawnExplosion(this.x, this.y, this.z, 60, TILE * 0.045, null);
    spawnSparks(this.x, this.y, this.z, 20);
    game.onDeath(how);
  }

  // -- drawing --------------------------------------------------------------

  draw(rd, camX, camY, camZ) {
    if (this.dead) return;

    if (AIRFRAME === 'uav') {
      drawUav(rd, this, camX, camY, camZ);
    } else {
      drawModel(rd, SHIP_MODEL, this.matrix, this.x, this.y, this.z, camX, camY, camZ);
    }

    // A flame licking out of the engine while the motor is lit. The UAV lifts
    // on rotors, so it carries no visible thrust at all -- the spinning props
    // are the only cue that the motors are running.
    if (this.thrusting && AIRFRAME !== 'uav') {
      const up = matApply(this.matrix, 0, -1, 0);
      const len = (this.thrusting === 2 ? 0.75 : 0.4) * (0.7 + rnd() * 0.6);
      drawFlame(rd, this, up, len, camX, camY, camZ);
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
