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
import { spawnExhaust, spawnExplosion, spawnSparks, spawnSmoke, spawnDust } from './particles.js';
import { drawUav } from './uav.js';
import { drawBird } from './bird.js';
import { drawOrigami } from './origami.js';

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
// The descent hover allows on a flat battery. Comfortably inside
// LANDING_SPEED, which is the fastest arrival the ground will forgive, so a
// craft that comes down under it and level will walk away.
const AUTO_DESCENT = (LANDING_SPEED * 0.6) | 0;
// The descent a centred height stick settles into near the ground: gentle
// enough that a craft let go of there arrives with room to spare.
const HOLD_SETTLE = (LANDING_SPEED * 0.4) | 0;
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
const RELEASE_SPEED = TILE * 0.010;
// Clearance, in tiles, within which the rotors start lifting dust.
const WASH_HEIGHT = 2.6;
const SHIP_RADIUS = 0.3;   // in tiles, for scenery collisions
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
    this.autorotating = false;
    this.hits = 0;
    this.hitFlash = 0;
    this.grace = LAUNCH_GRACE;
    this.launched = false;      // has the pilot asked for power yet?
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
    // runs its battery there. Above the hover's clearance it is the hover.
    //
    // In between, close to the ground, it settles: whatever power brings the
    // descent to a steady HOLD_SETTLE, so letting go of the stick near the
    // ground sets the craft down. It was the power that exactly carries the
    // craft's weight, which sounds the same and is not: drag bleeds the
    // descent away, and the craft hung a hand's width off the ground
    // indefinitely -- measured, eight seconds without arriving.
    if (!hold || thrust || this.landed) {
      hold = false;
    } else if (!(this.altitude > HOVER_CLEAR)) {
      hold = false;
      thrust = 2;
      throttle = clamp((gravity + (this.vy - HOLD_SETTLE) * 0.2) / THRUST_FULL, 0, 1);
    }

    // Reverse thrust cannot push a machine through the ground it is already
    // standing on, and letting it try is not harmless: one frame of full
    // power into the pad arrives as vertical speed, and vertical speed on
    // contact is what the arrival is judged on. Sat on its skids, pushing
    // down is simply nothing -- the same answer the stick gets there.
    if (this.landed && thrust === 2 && throttle < 0) thrust = 0;

    // The safe window runs from the first touch of power, not from the
    // moment the craft appears.
    if (thrust > 0) this.launched = true;
    if (this.launched && this.grace > 0) this.grace--;

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

    this.looping = mag >= (this.looping ? LOOP_KEEP : LOOP_AT);
    if (this.looping) {
      this.lean += LOOP_RATE;
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
    this.thrusting = thrust;

    // Hover holds the height it is at, but only once there is a height worth
    // holding: a machine on its skids needs lifting off them first, and a
    // hold cannot lift what is already resting. Below the clearance hover is
    // a throttle; above it, a brake.
    const holding = thrust === 1 && !this.landed && this.altitude > HOVER_CLEAR;

    if (thrust) {
      const power = (thrust === 2 ? THRUST_FULL * t : THRUST_HOVER) * lift;
      // "Up" in ship space is -y, since y points down.
      const up = matApply(this.matrix, 0, -1, 0);
      this.vx = (this.vx + up[0] * power) | 0;
      this.vz = (this.vz + up[2] * power) | 0;
      // A hovering craft spends the sky-facing share of its thrust standing
      // still rather than climbing; that is dealt with below, where gravity
      // is. Everything else pushes with all of it.
      if (!holding) this.vy = (this.vy + up[1] * power) | 0;

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
    this.vy = (this.vy + (holding ? Math.round(gravity * (1 - lift)) : gravity)) | 0;
    // Staying put: the lean stick centred on an assisted control, in the
    // air, with power to do it. A craft falling with its engine off, or a
    // flat pack, gets no help.
    const staying = stay && !this.landed && thrust > 0 && mag === 0;
    this.vx = (this.vx * DRAG) | 0;
    this.vy = (this.vy * DRAG) | 0;
    this.vz = (this.vz * DRAG) | 0;

    // ... and whatever vertical speed it still had is bled away, so it comes
    // to rest at the height it was given rather than drifting off it.
    if (holding) this.vy = (this.vy * HOVER_SETTLE) | 0;
    // ... and the same across the ground, when it has been told to stay.
    if (staying) {
      this.vx = (this.vx * STAY_SETTLE) | 0;
      this.vz = (this.vz * STAY_SETTLE) | 0;
    }
    // The sidestep, eased towards what the stick asks for. See `slide`.
    const slideWant = !this.landed && thrust > 0 ? clamp(slide, -1, 1) * SLIDE_SPEED : 0;
    this.slideV += (slideWant - this.slideV) * SLIDE_EASE;
    if (Math.abs(this.slideV) < 1) this.slideV = 0;

    // Autorotation. A flat pack is not a dead machine: the rotors are still
    // turning, and holding hover feathers them into the airflow so they brake
    // the fall rather than drive it. It buys no lift and no authority the
    // craft did not already have -- the descent is capped, nothing more --
    // but a capped descent is a survivable one, which is the difference
    // between running the battery down being a mistake and being fatal. It
    // is hover specifically: full thrust on an empty pack is still nothing,
    // because asking for everything is not how you ask for a glide.
    this.autorotating = this.flat && asked === 1 && !this.landed;
    if (this.autorotating && this.vy > AUTO_DESCENT) this.vy = AUTO_DESCENT;

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
    this.z = (this.z + this.vz) | 0;

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

    const ground = landAltitude(this.x, this.z);
    const feet = (this.y + UNDERCARRIAGE_Y) | 0;

    if (feet < ground) {
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
    spawnExplosion(this.x, this.y, this.z, 60, TILE * 0.045, null);
    spawnSparks(this.x, this.y, this.z, 20);
    game.onDeath(how);
  }

  // -- drawing --------------------------------------------------------------

  draw(rd, camX, camY, camZ) {
    if (this.dead) return;

    if (AIRFRAME === 'origami') {
      drawOrigami(rd, this, camX, camY, camZ);
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
