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
import { project } from './renderer.js';
import {
  spawnExhaust, spawnExplosion, spawnSparks, spawnSmoke, spawnDust, spawnSkimSpray, spawnFoam,
  spawnEmber,
} from './particles.js';
import { drawUav } from './uav.js';
import { drawBird } from './bird.js';
import { drawOrigami, shedEmbers } from './origami.js';
import { drawEgg, hatch } from './flames.js';
import { dropBomb } from './firebombs.js';
import { boatUnder, BOAT_DECK } from './boats.js';

// Which airframe to fly. The faceted lander, the quadrotor and the hoverbird
// all fly on the same model -- tilt the body, push along its own up axis --
// so this is a straight swap and nothing below it knows the difference.
export const AIRFRAME = 'origami';   // 'lander' | 'uav' | 'bird' | 'origami'

// --- tuning ----------------------------------------------------------------

export const GRAVITY_START = 0x02800;
// y = 0 is the height of the tallest possible peak. The ceiling is how far
// above that the engines will still lift, and it used to be three tiles: the
// game was played skimming the landscape, and three was as high as the craft
// could go and still be in frame, since the eye was pegged a tile and a half
// up and anything more than about 1.6 tiles above the eye leaves the top of
// the screen.
//
// Ten now, with the eye following the whole way so the craft stays framed.
// What you lose going up is the ground: the scan only draws from 10 to 26
// tiles out, and from ten tiles up that band is below the bottom of the
// frame. The horizon ranges fill it instead, which is what being high over a
// hazy plain looks like anyway.
export const HIGHEST_ALTITUDE = -(TILE * 10);

// Where lift starts fading rather than where it stops. A tile and a bit of
// warning is enough to feel the air thinning and back off.
const CEILING_SOFT = HIGHEST_ALTITUDE + TILE * 1.2;

// ... and the one that is actually met: two tiles over whatever is under the
// bird. It keeps the bird down among things -- a tree, a tower, a hill is to
// be flown round or through, not over the top of -- but it is soft, and it is
// only ever the climbing that it takes away:
//
// - Past it, the upward share of the push fades over GROUND_FADE -- to
//   nothing while still climbing, and to GROUND_LIFT_MIN of itself on the way
//   back down, which softens the descent but is too little to hold height
//   on. A hover sinks back to two tiles; full power tops out half a tile over. The push
//   across the ground is all still there, and so is a push downwards, upside
//   down at the top of a loop. (It used to take the whole push, sideways as
//   well: coming down a hill the ground fell away, the bird was suddenly over
//   the ceiling, and it lost its steering along with its lift.)
// - Nothing brakes speed there. A run-up and a pull into a loop carries over
//   it on momentum, and comes back down, having nothing to stay up on.
// - A hover over it sinks at no more than HOVER_SINK, so a cliff edge is a
//   descent, not a drop.
//
// Two things lift it: the warm air over a balloon (the game says where, as
// `thermal`), so they can still be climbed to and bounced on; and the sunset,
// when the phoenix is whole (`openSky`). The world-y ceiling above stays the
// hard limit, braked and then stopped.
export const GROUND_CEILING = TILE * 2.0;
const GROUND_FADE = TILE * 0.5;
const GROUND_LIFT_MIN = 0.12;      // under a fifth of full power's: never enough to hold on
const HOVER_SINK = TILE * 0.03;    // a step: a tile and a half a second
const LOOK_AHEAD = 25;             // steps: the ground is looked for this far ahead, and twice it
const LOOK_MAX = TILE * 3;         // ... but never more than this far
// Ridge lift. Held down among the hills, the bird meets them at speed, and
// its own push could not lift it up a steep face fast enough: a pilot flying
// at the ceiling into the steepest tenth of the slopes crashed into one run in
// four. Flying under power at ground that rises ahead, within RIDGE_NEAR of
// it, the air pushed up the face carries the bird up the slope's angle at the
// speed it is going.
const RIDGE_NEAR = TILE * 2.5;
const RIDGE_EASE = 0.3;            // how much of the way to that each step
// Ground effect: the same idea on the flat, land or sea. Under power, the
// nearer the surface the more the air trapped under the wings holds the bird
// up: an extra push of up to GE_LIFT of full power at the surface, fading to
// nothing at GE_NEAR, and a descent towards it cushioned. Not on hover, which
// is already holding the height it was asked to -- a skim, or a landing.
const GE_NEAR = TILE * 1.5;
const GE_LIFT = 0.25;              // of THRUST_FULL: over a g, at the surface
const GE_CUSHION = 0.12;           // of a descent taken off each step, at the surface
const CEILING_BRAKE = 0.8;         // what is left of a climb each step in the world-y ceiling's thin air
const THERMAL_OVER = TILE * 1.2;   // how far over a balloon's top its air carries
// Battery capacity. Doubled from the original tank so a sortie lasts about
// twice as long; the charge rate is doubled to match, so topping up still
// takes the same time on the ground.
export const CHARGE_MAX = 0x8000;

const THRUST_HOVER = 0x06600;   // hover thrust, doubled again for a much faster feel
const THRUST_FULL  = 0x0C000;   // full-throttle thrust, doubled again

// The fraction of full power that exactly cancels gravity -- about a fifth.
// It is the one landmark the throttle's travel has: everything below it
// sinks and everything above it climbs, and a throttle that does not put it
// somewhere you can find it is a throttle with all its useful part squashed
// into the first few millimetres. The controls lay their travel out around
// this, so it lives here with the numbers it is made of rather than as a
// figure copied into them.
//
// It is taken at the gravity a flight starts with. Gravity does climb later
// on, and the landmark climbs with it -- 0.21 of full power at the start,
// 0.28 and 0.35 at the two heavier settings -- so a throttle laid out around
// this one has its hold point drift up the travel as the day wears on rather
// than sitting exactly half way. Half, a little over half, and six tenths.
export const HOLD_THROTTLE = GRAVITY_START / THRUST_FULL;
// Radians of tilt at full stick. Pi, so the craft can go all the way over --
// nose straight down, and every attitude on the way there. Combined with the
// heading, which already covers the whole circle, that is the full sphere.
//
// It has a consequence worth knowing rather than discovering: thrust acts
// along the roof, so past ninety degrees it points at the ground. Bury the
// stick under full power and the craft drives itself down rather than merely
// failing to climb. Hover is still capped at forty-five and still holds its
// height, so there is always a setting that behaves.
// How far the stick alone may lean the craft.
//
// It was a half turn, so that a held stick could put the machine on its back
// -- but a half turn of range over one stick is a lot of degrees per
// millimetre, and spreading it unevenly to protect the middle only moved the
// problem: it bought ten degrees of bank per tenth of stick down at the
// bottom and forty-three at the top, so pushing past ninety leapt to a
// hundred and thirty-five instead of settling.
//
// Three quarters of a turn, spread evenly, is fourteen degrees per tenth of
// stick everywhere -- the same answer wherever you are, which is the whole
// of what "settles" means. Ninety sits at two thirds of stick with room
// either side of it rather than on a cliff.
//
// Nothing acrobatic goes. A hundred and thirty-five is well past vertical,
// and all the way over is what the loop is for: bury the stick and the lean
// stops being a position and becomes a rate, which carries it round through
// inverted and back. That was always the acrobatic route -- holding the
// stick at exactly the right spot to hang upside down was the bug that
// started all this.
const MAX_LEAN = (Math.PI * 3) / 4;
// Hover leans as far as anything else. It used to be capped at forty-five
// degrees, and barred from looping, on the grounds that it was the mode for
// placing the craft; but hover carries the craft's weight whatever the lean
// (see `holding` in update), so the cap bought no safety, only a machine
// that handled differently depending on which power it was on.
// Past the rim of the stick the tilt stops being a position and becomes a
// rate. Steering here has always been by position -- how far you push is how
// far the nose drops -- and that is exactly why a loop was impossible: full
// stick meant a hundred and eighty degrees and there was nowhere further to
// push, so the craft hung there inverted. Holding the stick hard over now
// keeps it rotating instead, round and back to level.
//
// The rate only applies at the very rim, so ordinary flying is unchanged:
// anything short of a buried stick is still a position, and you cannot loop
// by accident.
//
// It takes more to start a loop than to keep one going, and that gap is not a
// nicety. A mouse pushed to the edge of its range reads exactly 1.00 and sits
// there; a phone held over at twenty degrees reads about 0.97 with a hand in
// it, and a single threshold turns that into a switch being flicked several
// times a second. Measured over seven seconds of a stick held at 0.97 with
// four hundredths of wobble: the gate flipped forty-one times, the craft
// completed no turns at all, and it spent ninety per cent of the last two
// seconds hanging within thirty-five degrees of inverted -- which is the old
// stuck-at-180 bug arriving by a different road. Once it is round, it stays
// round until the stick is properly released.
// The stick's travel is spread evenly across that range. It was curved, to
// keep the zero-lift knife edge away from the middle of the stick while the
// range still ran to a half turn; with the range brought in, the knife edge
// sits at two thirds of its own accord and the curve was only buying unequal
// gain. Even is what settles.
const LOOP_AT = 0.96;      // stick deflection at which it becomes a rate
const LOOP_KEEP = 0.80;    // ... and where it goes back to being a position
const LOOP_RATE = 0.060;   // radians a frame, so a full turn takes about 1.7s
// A loop is flown on the wings. The push turning round on its own did nothing
// with the speed the bird came in with: flying forward into a loop, the push
// went forward and then down, and the speed carried it into a dive; and drag
// took four fifths of what it had over the turn. So while looping, the
// bird's speed in the plane of the loop is carried round a circle that
// starts where it went in -- forward, up, back over the top, down and out
// the way it came in -- LOOP_CARRY of the way onto it each step, losing only
// LOOP_DRAG a step and never slower than LOOP_MIN. The push does nothing to
// it there: turned by the lean, it braked the climb over the second quarter.
// The loop is as big as the run-up -- its radius is the speed over
// LOOP_RATE. The two-tile ceiling does not apply during one; the world-y
// limit does.
const LOOP_CARRY = 0.2;
const LOOP_DRAG = 0.997;
const LOOP_MIN = TILE * 0.05;      // a step: a loop from a standstill is still a loop
// How fast a hovering craft settles to a standstill vertically. Applied every
// frame to whatever vertical speed is left, so arriving at a hover from a
// dive is a catch rather than a wall: a 2 tiles/s descent is down to a tenth
// of that in about a quarter of a second.
const HOVER_SETTLE = 0.80;
// How much daylight the craft needs under it before hover stops pushing and
// starts holding. `landed` alone is too fine a gate -- the skids clear the
// ground by a thousandth of a tile, the hold takes over and the machine is
// pinned there. It doubles as the reason a hover will not fly you into a
// hillside: ground rising under you eats the clearance, and hover goes back
// to being a throttle until it has the room again.
const HOVER_CLEAR = TILE * 0.6;
// A centred height stick holds the height all the way down -- it never sets
// the craft down by itself, over land or over the sea -- but it will not
// hold it into rising ground either: within this much of the surface it
// lifts the craft clear at HOLD_RISE, about half a tile a second.
const HOLD_FLOOR = TILE * 0.3;
const HOLD_RISE = (LANDING_SPEED * 0.32) | 0;
// How quickly a craft told to stay where it is comes to rest across the
// ground, per step: a tenth of its speed left after three quarters of a
// second. See `stay` in update().
const STAY_SETTLE = 0.94;
// The sidestep: the height stick across, on the assisted controls. See `slide`
// in update(). Two tiles a second at full stick, eased in and out over a
// few frames so it neither jerks nor lurches.
const SLIDE_SPEED = TILE * 0.04;
const SLIDE_EASE = 0.15;

// How many hits from a vessel's point defence the airframe will take. Shells
// and missiles still kill outright: those are ordnance, and dodging them is
// the game. A point-defence beam is a slap for being somewhere you should not
// be, and a slap that kills is just a rule you learn by dying to it.
export const HULL_HITS = 3;
const LEAN_RATE = 0.30;         // how fast the craft follows the stick -- snappier response
const DRAG = 0.985;             // damping; without it the craft is unflyable

const DRAW_HOVER = 3;    // power drawn per frame while hovering
const DRAW_FULL = 8;     // ... and under full thrust

// Where the bomb leaves the craft, and how hard it is pushed clear. Barely
// any push: it should fall away rather than be shot downwards.
const BAY_OFFSET = TILE * 0.34;
// A fire bomb: a fiftieth of a full load of energy, and a third of a second
// between them.
const BOMB_ENERGY = CHARGE_MAX / 50;
const BOMB_RELOAD = 16;
const RELEASE_SPEED = TILE * 0.010;
// Clearance, in tiles, within which the rotors start lifting dust.
const WASH_HEIGHT = 2.6;
// Skimming the sea: within this many tiles of the water the bird throws up
// spray and leaves foam, and at SKIM_FAST across it (four tiles a second)
// the wake is at its fullest. See skim().
const SKIM_HEIGHT = 1.8;
const SKIM_FAST = TILE * 0.08;
// Facing where it is going: not below FACE_SLOW (tiles a step, a tenth of a
// tile a second), all of the way from FACE_FAST (six tenths), and turning to
// it at FACE_EASE a step.
const FACE_SLOW = 0.002;
const FACE_FAST = 0.012;
const FACE_EASE = 0.15;
// How far the bird is drawn nose-down for a lean. Drawn at the whole lean --
// sixty degrees at half stick -- a bird flying away from the chase camera
// had its head below its tail on the screen, exactly as one flying towards
// it does, and which way it faced could not be read at all. A bird in fast
// flight keeps its body near level, so it is drawn at two fifths of the
// lean up to PITCH_KNEE, and from there catches up, to the whole lean at
// upright-and-over, so a loop still goes all the way round.
const PITCH_KNEE = 1.0;
const PITCH_SOFT = 0.4;
function drawnPitch(lean) {
  if (lean <= PITCH_KNEE) return lean * PITCH_SOFT;
  if (lean >= Math.PI) return lean;
  return PITCH_KNEE * PITCH_SOFT + (lean - PITCH_KNEE) * (Math.PI - PITCH_KNEE * PITCH_SOFT) / (Math.PI - PITCH_KNEE);
}
const SHIP_RADIUS = 0.3;
// A close shave: passing within SHAVE tiles of something's side, below its
// top, at SHAVE_SPEED or better. The same thing does not count again until
// the bird has been clear of it for SHAVE_AGAIN steps.
const SHAVE = 0.35;
const SHAVE_SPEED = TILE * 0.03;
const SHAVE_AGAIN = 60;   // in tiles, for scenery collisions
const SCAN = 2;            // tiles either way to test for scenery

// Getting off the pad is the fiddliest moment in the game, so the first few
// seconds of every life are free: you can scrape the ground, clip a tree or
// come down hard without losing a ship. At 50Hz this is five seconds.
//
// It does not start until you first ask for power. It used to start the
// instant the craft appeared, which meant the clock was running while you
// were still reading the screen, working out the controls, or simply not
// there yet -- and a beginner who sat and looked at it for five
// seconds got no grace at all, which is the exact opposite of what it is for.
// Sitting on the pad costs nothing now: the five seconds begin the moment you
// lift.
export const LAUNCH_GRACE = 250;
// How far the eye may rise above y = 0. It follows the craft all the way to
// the ceiling now: the craft is drawn fifteen tiles in front of the eye, so
// anything much above the eye is off the top of the screen, and a ceiling the
// camera does not follow is a ceiling you fly out of sight through.
const CAMERA_CEILING = -(TILE * 10);

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
    this.thermal = 0x7fffffff;      // the top of the warm air over a balloon, if in it
    this.loopSense = 1;
    this.loopTurn = 0;
    this.openSky = false;
    // Start sitting on the launchpad at the world origin.
    this.x = TILE * 4;
    this.y = LAUNCHPAD_Y;
    this.z = TILE * 4;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.leanDir = 0;
    this.lean = 0;
    this.slideV = 0;
    this.looping = false;
    this.matrix = matFromAim(0, 0);
    // How the bird is drawn, which is not quite how it flies: see face().
    this.pose = matFromAim(0, 0);
    this.facing = 0;
    // How much it can hold, which grows as the phoenix gathers its flames
    // (the game sets it; see Game.onFlameTaken). It starts each life full.
    if (!this.chargeCap) this.chargeCap = CHARGE_MAX;
    this.charge = this.chargeCap;
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
    this.hits = 0;
    this.hitFlash = 0;
    this.grace = LAUNCH_GRACE;
    this.launched = false;      // has the pilot asked for power yet?
    this.onBoat = null;         // the canoe it is sat on, if it is
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

  // How far from upright, in [0, pi]. The lean runs all the way round now, so
  // five radians is nearly level again rather than wildly tipped -- and the
  // arrival test wants the angle, not the number.
  get tilt() {
    let a = this.lean % (Math.PI * 2);
    if (a < 0) a += Math.PI * 2;
    return a > Math.PI ? Math.PI * 2 - a : a;
  }

  get altitude() {
    // Height above the ground directly below, in fixed point.
    return (landAltitude(this.x, this.z) - this.y - UNDERCARRIAGE_Y) | 0;
  }

  // -- flight ---------------------------------------------------------------

  // `stick` is the control input as x/y in [-1, 1]; `thrust` is 0, 1 (hover)
  // or 2 (full); `fire` is a boolean.
  // `throttle` is how much of the full power is being asked for, -1 to 1. Most
  // ways of asking only say yes, and say it as 1; the height stick -- the
  // right thumb on the glass or the pad's right stick -- can say how much.
  // Hover is not scaled -- it is a setting rather than an amount, and a
  // half-strength hold that does not hold is no use to anybody.
  //
  // Negative is reverse thrust: the rotors driven the other way, pushing
  // along the floor rather than the roof. It is the same one force with a
  // sign on it, so everything downstream of it -- the ceiling, the battery,
  // the lean -- falls out of that rather than needing a second set of rules.
  // No control asks for it at present: the height stick's bottom is
  // "no power" rather than "backwards". It is kept because it costs nothing.
  //
  // `hold` is the height stick -- the pad's right stick, the right thumb on
  // the glass -- sitting centred, which asks the craft to stay at the height
  // it is at: a drone's altitude hold. It is the hover's physics without the
  // hover's handling: the lean keeps whatever authority it had, because the
  // stick passes through the middle all the time and the handling must not
  // change every time it does.
  //
  // `stay` is the same for the ground under it: the lean stick is one of the
  // assisted ones -- the pad's left stick, the left thumb -- and while it
  // sits centred with the engine running, the craft stops and stays put, as
  // a camera drone holding its position does. It does it without leaning
  // back into the stop, because the bird is drawn facing its lean, and
  // braking that way turned it round to face the way it had come.
  //
  // `slide`, -1 to 1, is the height stick across on those same controls: a
  // sidestep, left or right on the screen, with the bird kept level and
  // facing where it was. Nothing that flies by leaning can do that -- a
  // drone has to tip to go sideways, and so did this, which drew a bird
  // turned side-on and tipped over for what the player meant as a step to
  // one side. So it is not flown: it is simply where the player asked the
  // bird to be, laid over the flight rather than made out of it. It needs
  // the craft in the air and the engine running, like the other assists.
  update(stick, thrust, fire, gravity, game, throttle = 1, hold = false, stay = false, slide = 0) {
    if (this.dead) {
      this.deathTimer--;
      return;
    }

    // A hold only holds something in the air. Sat on the ground it asks for
    // nothing, so a centred stick neither lifts the craft off the pad nor
    // runs its battery there. In the air it holds the height it is at, as
    // low as that is: landing is the stick pushed down, never a hold.
    //
    // It used to settle instead, close to the ground: under the hover's
    // clearance a centred stick brought the craft down at a gentle rate, so
    // letting go near the ground set it down. Over the sea that set it down
    // in the water.
    if (!hold || thrust || this.landed) hold = false;

    // Reverse thrust cannot push a machine through the ground it is already
    // standing on, and letting it try is not harmless: one frame of full
    // power into the pad arrives as vertical speed, and vertical speed on
    // contact is what the arrival is judged on. Sat on its skids, pushing
    // down is simply nothing -- the same answer the stick gets there.
    if (this.landed && thrust === 2 && throttle < 0) thrust = 0;

    // The safe window runs from the first touch of power, not from the
    // moment the craft appears.
    if (thrust > 0 && !this.launched) {
      this.launched = true;
      // The phoenix breaks out of its flame. See drawEgg.
      if (AIRFRAME === 'origami') hatch(this.x, this.y, this.z);
      if (game && game.onHatched) game.onHatched();
    }
    if (this.launched && this.grace > 0) this.grace--;

    // Fire: a drop of the bird's own fire let go from under it. In the air
    // only, a little energy each, and not faster than BOMB_RELOAD.
    if (this.fireCooldown > 0) this.fireCooldown--;
    if (fire && this.launched && !this.landed && this.fireCooldown === 0 &&
        this.charge > BOMB_ENERGY && dropBomb(this)) {
      this.charge -= BOMB_ENERGY;
      this.fireCooldown = BOMB_RELOAD;
      if (game && game.onBombDropped) game.onBombDropped();
    }

    // Rotor phase: idling at rest, winding up with the throttle.
    this.rotorSpin = (this.rotorSpin + 0.34 + this.thrusting * 0.30) % (Math.PI * 2);

    // Aim for the lean the stick is asking for, and ease towards it. The
    // magnitude of the deflection sets how hard we tilt, its angle sets which
    // way -- straight from the original's polar treatment of the mouse.
    // Bearing of the stick becomes the craft's heading; how hard you push
    // becomes how far its nose drops. Centring the stick leaves the heading
    // where it was, so the craft holds its facing rather than snapping back.
    // On the ground the stick is not flying anything.
    //
    // It used to be. Sat on the pad with no power asked for at all, a stick
    // held over wound the craft round and round -- measured, three seconds of
    // it left the machine at 259 degrees of lean and still looping, on its
    // skids, before the flight had begun. With tilt steering that is not even
    // an unusual thing to do: the neutral belongs to the last flight until
    // this one lifts off, so simply picking the handset up differently is a
    // buried stick.
    //
    // Leaving the ground is what starts the flying, and it is the same
    // instant the tilt decides what straight ahead means (see onLiftoff), so
    // the two now agree: square on its skids until it is off them, then
    // whatever you ask for, from a neutral that was taken as you left.
    const mag = this.landed ? 0 : Math.min(1, Math.hypot(stick.x, stick.y));
    const targetLean = mag * MAX_LEAN;
    const targetDir = (mag > 0.02) ? Math.atan2(stick.x, stick.y) : this.leanDir;

    // Interpolate the direction the short way round the circle.
    let dd = targetDir - this.leanDir;
    while (dd > Math.PI) dd -= Math.PI * 2;
    while (dd < -Math.PI) dd += Math.PI * 2;
    this.leanDir += dd * LEAN_RATE;

    const wasLooping = this.looping;
    this.looping = mag >= (this.looping ? LOOP_KEEP : LOOP_AT);
    // Which way round: forward, up and over if it is going the way it leans
    // as the loop starts, and the other way if it is backing into it. See
    // LOOP_CARRY.
    if (this.looping && !wasLooping) {
      this.loopSense = this.vx * Math.sin(this.leanDir) + this.vz * Math.cos(this.leanDir) >= 0 ? 1 : -1;
      this.loopTurn = 0;
    }
    if (this.looping) {
      this.lean += LOOP_RATE;
      this.loopTurn += LOOP_RATE;
      // All the way round from where it went in: a loop the loop. (Counted
      // from the entry rather than at the lean's own wrap, since the loop is
      // flown from where it began -- see LOOP_CARRY.)
      if (this.loopTurn >= Math.PI * 2) {
        this.loopTurn -= Math.PI * 2;
        if (!this.landed && game && game.onTrick) game.onTrick('loop');
      }
    } else {
      // Ease the short way round, the same as the heading does. Without this
      // a craft coming off a loop at five radians would unwind backwards
      // through everything it had just flown.
      let dl = targetLean - this.lean;
      while (dl > Math.PI) dl -= Math.PI * 2;
      while (dl < -Math.PI) dl += Math.PI * 2;
      this.lean += dl * LEAN_RATE;
    }
    if (this.lean >= Math.PI * 2) this.lean -= Math.PI * 2;
    else if (this.lean < 0) this.lean += Math.PI * 2;

    matFromAim(this.leanDir, this.lean, this.matrix);

    // Past the handling, the hold is a hover. See above.
    if (hold) thrust = 1;

    // A flat battery means no thrust at all. Remembering that it was asked
    // for lets the HUD say so, rather than the machine simply going quiet.
    const asked = thrust;
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

    // How much power, and which way the rotors are turning. Hover is a
    // setting rather than an amount, so it is always all of it, forwards.
    const t = thrust === 2 ? Math.max(-1, Math.min(1, throttle)) : 1;

    let lift = 1;
    this.ceiling = 0;
    // The fade is on climbing, not on the rotors: it is the air running out
    // to push against on the way up. Pushing yourself back down out of it is
    // not the same ask, and being pinned at the ceiling with a weak way down
    // would be the worst place to put one.
    if (thrust && t > 0 && this.y < CEILING_SOFT) {
      lift = Math.max(0, (this.y - HIGHEST_ALTITUDE) / (CEILING_SOFT - HIGHEST_ALTITUDE));
      this.ceiling = 1 - lift;
    }
    // Two tiles over the ground (or the sea) under the bird, or a little over
    // the top of the balloon it is beside: `climb` is the share of the upward
    // push it still gets. See GROUND_CEILING.
    let over = 0, climb = 1, warm = false;
    if (!this.openSky && !this.landed && !this.looping) {
      // The ground is the highest of what is under the bird and what it will
      // be over in a half and a whole second, so the ceiling rises ahead of a
      // hill rather than on it: measured from underfoot alone, the way up a
      // slope opened only once the bird was already on it.
      let ground = Math.min(landAltitude(this.x, this.z), SEA_LEVEL);
      for (let k = 1; k <= 2; k++) {
        const ax = (this.x + clamp(this.vx * LOOK_AHEAD * k, -LOOK_MAX, LOOK_MAX)) | 0;
        const az = (this.z + clamp(this.vz * LOOK_AHEAD * k, -LOOK_MAX, LOOK_MAX)) | 0;
        const a = landAltitude(ax, az);
        if (a < ground) ground = a;
      }
      let start = (ground - UNDERCARRIAGE_Y - GROUND_CEILING) | 0;
      if (this.thermal !== 0x7fffffff && this.thermal - THERMAL_OVER < start) {
        start = (this.thermal - THERMAL_OVER) | 0;
        warm = true;
      }
      over = start - this.y;
      if (over > 0) {
        // The little that is left is only there on the way down: going up
        // past it, the climb is momentum and nothing else, and slows as
        // anything thrown up does.
        climb = Math.max(this.vy > 0 ? GROUND_LIFT_MIN : 0, 1 - over / GROUND_FADE);
        if (thrust && t > 0) this.ceiling = Math.max(this.ceiling, 1 - climb);
      }
    }
    this.thrusting = thrust;

    // Hover holds the height it is at, but only once there is a height worth
    // holding: a machine on its skids needs lifting off them first, and a
    // hold cannot lift what is already resting. Below the clearance hover is
    // a throttle; above it, a brake.
    // A height stick held centred is a hold at any height (see above).
    const holding = thrust === 1 && !this.landed && (hold || this.altitude > HOVER_CLEAR);

    // In a loop the wings fly it, from the speed it had coming into this step
    // (see LOOP_CARRY); the push's own share in the plane is set aside below.
    const winged = this.looping && thrust > 0 && !this.landed;
    const wsy = Math.sin(this.leanDir), wcy = Math.cos(this.leanDir);
    const wD0 = this.vx * wsy + this.vz * wcy, wU0 = -this.vy;
    if (thrust) {
      const power = (thrust === 2 ? THRUST_FULL * t : THRUST_HOVER) * lift;
      // "Up" in ship space is -y, since y points down.
      const up = matApply(this.matrix, 0, -1, 0);
      if (power < 0) {
        // Pushing down (the height stick below letting go): straight down,
        // whatever the lean, so coming down faster does not also brake or
        // shove the craft across the ground.
        this.vy = (this.vy - power) | 0;
      } else {
        this.vx = (this.vx + up[0] * power) | 0;
        this.vz = (this.vz + up[2] * power) | 0;
        // A hovering craft spends the sky-facing share of its thrust
        // standing still rather than climbing; that is dealt with below,
        // where gravity is. Everything else pushes with all of it.
        // Upwards, only what the air over the ground ceiling gives.
        if (!holding) this.vy = (this.vy + up[1] * power * (up[1] < 0 ? climb : 1)) | 0;
      }

      // Rotors turning still cost something, but pushing at a ceiling for no
      // lift should not drain the pack at the full rate.
      // Half the power costs about half the pack, which is the whole reason
      // to have a throttle in a machine that runs out.
      // Reverse costs what forward costs: it is the same rotors doing the
      // same work, and a free way down would make the throttle a one-way
      // decision with no price on it.
      const draw = thrust === 2 ? DRAW_FULL * (0.25 + 0.75 * Math.abs(t)) : DRAW_HOVER;
      this.charge -= draw * (0.35 + 0.65 * lift);
      if (this.charge < 0) this.charge = 0;

      // Rotors and wings both beat the air down; an engine bell does not.
      if (AIRFRAME === 'lander') this.emitExhaust(up, thrust, t);
      else this.rotorWash();
    }

    // Gravity, then damping, then move. There is no wind: see weather.js.
    //
    // A hovering craft carries its own weight, so gravity is taken off it --
    // all but the share the thinning air at the ceiling has already stopped
    // it from answering. Push a hover up there and it starts to sink, same as
    // anything else.
    // Up a rising slope, the ridge lift. See RIDGE_NEAR.
    if (thrust > 0 && !this.landed && !this.looping && this.altitude < RIDGE_NEAR) {
      const sp = Math.hypot(this.vx, this.vz);
      if (sp > TILE * 0.01) {
        const dx = clamp(this.vx * LOOK_AHEAD, -LOOK_MAX, LOOK_MAX), dz = clamp(this.vz * LOOK_AHEAD, -LOOK_MAX, LOOK_MAX);
        const rise = Math.min(landAltitude(this.x, this.z), SEA_LEVEL) - Math.min(landAltitude((this.x + dx) | 0, (this.z + dz) | 0), SEA_LEVEL);
        if (rise > 0) {
          const want = -sp * rise / Math.hypot(dx, dz);
          if (this.vy > want) this.vy = (this.vy + (want - this.vy) * RIDGE_EASE) | 0;
        }
      }
    }
    // ... and on the flat, ground effect. See GE_NEAR.
    if (thrust === 2 && t > 0 && !this.landed && !holding) {
      const near = (Math.min(landAltitude(this.x, this.z), SEA_LEVEL) - this.y - UNDERCARRIAGE_Y) | 0;
      if (near < GE_NEAR) {
        const k = 1 - Math.max(0, near) / GE_NEAR;
        this.vy = (this.vy - THRUST_FULL * GE_LIFT * t * k) | 0;
        if (this.vy > 0) this.vy = (this.vy * (1 - GE_CUSHION * k)) | 0;
      }
    }
    // So does a loop in progress, on any power: the push goes all the way
    // round and comes to nothing over a turn, and gravity alone would take
    // three tiles off it -- every loop from anywhere near the two-tile
    // ceiling ended in the sea. Carried, it comes back round to about where
    // it began.
    const carried = holding || (this.looping && thrust > 0);
    this.vy = (this.vy + (carried ? Math.round(gravity * (1 - lift * climb)) : gravity)) | 0;
    // Staying put: the lean stick centred on an assisted control, in the
    // air, with power to do it. A craft falling with its engine off, or a
    // flat pack, gets no help.
    const staying = stay && !this.landed && thrust > 0 && mag === 0;
    const drag = winged ? LOOP_DRAG : DRAG;
    this.vx = (this.vx * drag) | 0;
    this.vy = (this.vy * drag) | 0;
    this.vz = (this.vz * drag) | 0;
    // Round the loop on the wings. See LOOP_CARRY.
    if (winged) {
      const vD = this.vx * wsy + this.vz * wcy;      // along the lean, now
      const sp = Math.max(LOOP_MIN, Math.hypot(wD0, wU0) * LOOP_DRAG);
      const tD = this.loopSense * Math.cos(this.loopTurn), tU = Math.sin(this.loopTurn);
      let nD = wD0 + (sp * tD - wD0) * LOOP_CARRY, nU = wU0 + (sp * tU - wU0) * LOOP_CARRY;
      // Turned, not slowed: easing across the corner shortens the vector,
      // and over a loop that alone took three fifths of the speed.
      const nl = Math.hypot(nD, nU) || 1;
      nD *= sp / nl;
      nU *= sp / nl;
      this.vx = (this.vx + (nD - vD) * wsy) | 0;
      this.vz = (this.vz + (nD - vD) * wcy) | 0;
      this.vy = (-nU) | 0;
    }
    // The world-y ceiling is the one that is not to be broken: a climb into
    // its thin air is braked, and at the top it stops (below, after moving).
    if (this.y < CEILING_SOFT && this.vy < 0) this.vy = (this.vy * CEILING_BRAKE) | 0;
    // So is the top of a balloon's warm air: a column you can ride all the way
    // up is one you arrive at the top of fast, and it carried the bird five
    // tiles past the top of the balloon it was climbing to.
    if (warm && over > 0 && this.vy < 0) this.vy = (this.vy * CEILING_BRAKE) | 0;

    // ... and whatever vertical speed it still had is bled away, so it comes
    // to rest at the height it was given rather than drifting off it.
    // Not once it is past the ground ceiling's fade, though: over the edge of
    // a cliff, or out of a balloon's warm air, it comes down to where it can
    // hold -- at a steady HOVER_SINK -- rather than settling a tile a minute.
    if (holding && over > GROUND_FADE) {
      if (this.vy > HOVER_SINK) this.vy = HOVER_SINK;
    } else if (holding && lift > 0) this.vy = (this.vy * HOVER_SETTLE) | 0;
    // ... but not into the ground coming up under it.
    if (holding && hold && this.altitude < HOLD_FLOOR && this.vy > -HOLD_RISE) this.vy = -HOLD_RISE;
    // ... and the same across the ground, when it has been told to stay.
    if (staying) {
      this.vx = (this.vx * STAY_SETTLE) | 0;
      this.vz = (this.vz * STAY_SETTLE) | 0;
    }
    // The sidestep, eased towards what the stick asks for. See `slide`.
    const slideWant = !this.landed && thrust > 0 ? clamp(slide, -1, 1) * SLIDE_SPEED : 0;
    this.slideV += (slideWant - this.slideV) * SLIDE_EASE;
    if (Math.abs(this.slideV) < 1) this.slideV = 0;

    // A damaged airframe trails smoke, and trails more of it the worse it is.
    // The HUD counts the hits, but the thing you are actually looking at is
    // the craft, so the craft has to say so too.
    if (this.hitFlash > 0) this.hitFlash--;
    if (this.hits > 0 && !this.dead) {
      const every = Math.max(4, 16 - this.hits * 5);
      if ((this.smokeTick = (this.smokeTick | 0) + 1) % every === 0) {
        spawnSmoke(this.x, this.y, this.z);
      }
    }

    this.x = (this.x + this.vx + this.slideV) | 0;
    this.y = (this.y + this.vy) | 0;
    if (this.y < HIGHEST_ALTITUDE) {
      this.y = HIGHEST_ALTITUDE;
      if (this.vy < 0) this.vy = 0;
    }
    this.z = (this.z + this.vz) | 0;

    this.face();
    if (!this.landed) this.skim();
    if (AIRFRAME === 'origami' && this.launched) shedEmbers(this);

    this.checkGround(game);

    // Out of energy is the end of this life: there is no glide and no
    // falling, the fire simply goes out. Unless it is sat somewhere it can
    // take on charge, which is the one place an empty bird is not stranded.
    if (!this.dead && this.charge <= 0 && !this.charging) this.die(game, 'spent');
  }

  // Which way the bird looks: where it is going.
  //
  // The flying is all in the lean: `matrix` is tipped along the stick, and
  // thrust goes along its roof. It was drawn that way too, facing wherever
  // it leaned -- so a bird leaning back to slow down turned round and flew
  // on tail first, and one coasting towards the camera came at you
  // backwards. So it is drawn facing its direction of travel once it is
  // moving, and facing its lean when it is not.
  //
  // It is drawn as it always was otherwise -- the same nose-down pitch for
  // the lean -- except that only the part of the lean along the way it
  // faces tips it. Leaning back against its speed, or across it, leaves it
  // level rather than standing it on its tail or on its side. Only the
  // picture: the flying still goes by `matrix`.
  face() {
    const speed = Math.hypot(this.vx, this.vz) / TILE;
    // Not in a loop, or leaning past upright: there the travel swings right
    // round and the bird would spin to follow it. It faces its lean.
    const w = this.looping || this.lean > Math.PI / 2 ? 0
      : clamp((speed - FACE_SLOW) / (FACE_FAST - FACE_SLOW), 0, 1);
    let want = this.leanDir;
    if (w > 0) {
      let d = Math.atan2(this.vx, this.vz) - this.leanDir;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      want += d * w;
    }
    let d = want - this.facing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.facing += d * FACE_EASE;
    let off = this.leanDir - this.facing;
    while (off > Math.PI) off -= Math.PI * 2;
    while (off < -Math.PI) off += Math.PI * 2;
    matFromAim(this.facing, drawnPitch(this.lean) * Math.max(0, Math.cos(off)), this.pose);
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

  // Skimming the sea. Low over open water the bird's wingbeat blows spray up
  // and out from under it, and moving across the water it throws a rooster
  // tail of spray up behind it and leaves a trail of foam lying on the sea,
  // spreading into a V as it goes. All of it thicker the lower it is, and
  // the wake the faster -- which is also a read on how close to the water
  // you are, the way the dust is over land. Flat out at the lowest it keeps
  // about three hundred particles going, of the pool's 484, which leaves
  // room for a splash or an explosion at the same time.
  skim() {
    if (landAltitude(this.x, this.z) < SEA_LEVEL) return;
    const clearance = (SEA_LEVEL - (this.y + UNDERCARRIAGE_Y)) / TILE;
    if (clearance < 0 || clearance > SKIM_HEIGHT) return;
    const low = 1 - clearance / SKIM_HEIGHT;
    const sea = SEA_LEVEL - 1;

    // Downwash: droplets blown up and outwards, while the wings are beating.
    if (this.thrusting && rnd() < low * 0.8) {
      const a = rnd() * Math.PI * 2, r = (0.3 + rnd() * 0.5) * TILE;
      const out = TILE * (0.006 + 0.010 * low);
      spawnSkimSpray((this.x + Math.cos(a) * r) | 0, sea, (this.z + Math.sin(a) * r) | 0,
        Math.cos(a) * out, -TILE * (0.010 + 0.018 * low * rnd()), Math.sin(a) * out);
    }

    // The wake, if it is going anywhere.
    const vx = this.vx + this.slideV, vz = this.vz;
    const speed = Math.hypot(vx, vz);
    if (speed < TILE * 0.006) return;
    const fast = Math.min(1, speed / SKIM_FAST);
    const ux = vx / speed, uz = vz / speed;           // along the track
    const sx = -uz, sz = ux;                          // across it
    // The rooster tail: thrown up behind, fanned out to the sides, going
    // slower than the bird so it falls away behind.
    for (let n = low * fast * 4 + rnd(); n >= 1; n--) {
      const side = rndSigned();
      spawnSkimSpray(
        (this.x - ux * TILE * 0.2 + sx * side * TILE * 0.2) | 0, sea,
        (this.z - uz * TILE * 0.2 + sz * side * TILE * 0.2) | 0,
        vx * 0.45 + sx * side * TILE * 0.03,
        -TILE * (0.016 + 0.03 * low * fast * rnd()),
        vz * 0.45 + sz * side * TILE * 0.03);
    }
    // Foam, left lying, drifting apart into a V -- which is the part of the
    // wake the chase camera sees, since the trail itself runs back towards
    // it and out of the bottom of the frame.
    for (let n = low * (0.4 + 0.8 * fast) + rnd(); n >= 1; n--) {
      const side = rnd() < 0.5 ? -1 : 1;
      const spread = TILE * (0.004 + 0.010 * fast) * (0.6 + 0.4 * rnd());
      spawnFoam(
        (this.x + sx * side * TILE * 0.15 * rnd()) | 0,
        (this.z + sz * side * TILE * 0.15 * rnd()) | 0,
        sx * side * spread, sz * side * spread);
    }
  }

  emitExhaust(up, thrust, t = 1) {
    const n = thrust === 2 ? 3 : 2;
    // Out of the engine bell, opposite to thrust -- so under reverse it comes
    // out of the other end, which is the only visible sign of which way the
    // power is going.
    const dir = t < 0 ? -1 : 1;
    const ex = (this.x - up[0] * TILE * 0.32 * dir) | 0;
    const ey = (this.y - up[1] * TILE * 0.32 * dir) | 0;
    const ez = (this.z - up[2] * TILE * 0.32 * dir) | 0;
    const jet = (thrust === 2 ? TILE * 0.028 : TILE * 0.018) * dir;
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

  // -- contact with the ground ----------------------------------------------

  checkGround(game) {
    if (this.hitScenery(game)) return;

    let ground = landAltitude(this.x, this.z);
    // Over the sea a canoe is somewhere to set down: her rails are the
    // ground there.
    const boat = ground >= SEA_LEVEL ? boatUnder(this.x, this.z) : null;
    if (boat) ground = BOAT_DECK;
    const feet = (this.y + UNDERCARRIAGE_Y) | 0;

    if (feet < ground) {
      this.onBoat = null;
      // Just left the ground. The tilt steering takes this as the moment to
      // decide what straight ahead means -- see Game.onLiftoff.
      if (this.landed && game) game.onLiftoff();
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
                       this.tilt > 0.45;

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
      this.onBoat = boat;
      if (boat && game.onBoatLanding) game.onBoatLanding(boat);
      game.onTouchdown(onPad);
    }

    // Charge anywhere the ground is level enough to sit square on. The pad is
    // simply the best surface there is -- but it is also the one place every
    // tank on the map knows how to find.
    const flat = onPad || groundRoughness(this.x, this.z) <= FLAT_ENOUGH;
    this.charging = flat && this.charge < this.chargeCap;

    if (this.charging) {
      this.charge = Math.min(this.chargeCap, this.charge + (onPad ? 80 : 52));
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
    if (this.shaveCool > 0) this.shaveCool--;

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
        if (ddx * ddx + ddz * ddz > r * r) {
          // Not in it -- but past it close, low and quick is a close shave.
          if (game && game.onTrick && !this.landed &&
              ddx * ddx + ddz * ddz < (r + SHAVE) * (r + SHAVE) &&
              Math.hypot(this.vx, this.vz) > SHAVE_SPEED &&
              (this.y + UNDERCARRIAGE_Y) > landAltitude(wx, wz) - model.height) {
            const key = ox * 4096 + oz;
            if (key !== this.shavedKey || this.shaveCool <= 0) game.onTrick('shave');
            this.shavedKey = key;
            this.shaveCool = SHAVE_AGAIN;
          }
          continue;
        }

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

  // A beam has found the airframe. Returns true if that was the last one it
  // had in it.
  takeHit(game) {
    if (this.dead || this.protected) return false;
    this.hits++;
    this.hitFlash = 22;
    spawnSparks(this.x, this.y, this.z, 14);
    if (this.hits >= HULL_HITS) {
      this.die(game, 'beam');
      return true;
    }
    return false;
  }

  die(game, how) {
    if (this.dead) return;
    // The launch grace covers every cause, tank fire included. Checking here
    // rather than at each call site means a new way of dying cannot forget.
    if (this.protected) return;
    this.dead = true;
    this.deathTimer = 110;
    if (how === 'spent') {
      // Burnt out: not an explosion, a phoenix going to embers, which drift
      // up and away before it rises again at the pad.
      for (let i = 0; i < 44; i++) {
        spawnEmber(this.x, this.y, this.z,
          rndSigned() * TILE * 0.02, -rnd() * TILE * 0.03, rndSigned() * TILE * 0.02);
      }
    } else {
      spawnExplosion(this.x, this.y, this.z, 60, TILE * 0.045, null);
      spawnSparks(this.x, this.y, this.z, 20);
    }
    game.onDeath(how);
  }

  // -- drawing --------------------------------------------------------------

  draw(rd, camX, camY, camZ) {
    if (this.dead) return;

    if (AIRFRAME === 'origami') {
      // Until the first touch of power the phoenix is still a flame, sat on
      // the pad: it hatches when it launches.
      if (this.launched) drawOrigami(rd, this, camX, camY, camZ);
      else drawEgg(rd, this.x, (this.y + UNDERCARRIAGE_Y) | 0, this.z, camX, camY, camZ);
    } else if (AIRFRAME === 'bird') {
      drawBird(rd, this, camX, camY, camZ);
    } else if (AIRFRAME === 'uav') {
      drawUav(rd, this, camX, camY, camZ);
    } else {
      drawModel(rd, SHIP_MODEL, this.matrix, this.x, this.y, this.z, camX, camY, camZ);
    }

    // A flame licking out of the engine while the motor is lit. The UAV lifts
    // on rotors, so it carries no visible thrust at all -- the spinning props
    // are the only cue that the motors are running.
    if (this.thrusting && AIRFRAME === 'lander') {
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
