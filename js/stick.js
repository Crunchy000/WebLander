// stick.js -- a joystick that appears wherever you put your thumb.
//
// The touch fallback here used to map the screen straight onto the stick:
// touch the top right corner and the craft leaned hard up and to the right,
// touch the middle and it levelled. That is the worst arrangement there is.
// It has no neutral you can feel, so you have to look at the screen to find
// out where the middle is -- on a game about looking at the horizon -- and
// every touch begins with a jump, because wherever your thumb lands is
// immediately a full command.
//
// What everything settled on instead, over about a decade of phone games, is
// the floating stick: the middle is wherever you put your thumb down, and the
// command is how far you have moved it since. You never look for it, it is
// never anywhere awkward, and putting your thumb down commands nothing at
// all, which is what makes it safe to grab in a hurry.
//
// Three details separate one that feels right from one that does not.
//
//   The origin trails. Push past the edge of the circle and the middle comes
//   with you rather than the stick simply pegging. Without this, a thumb that
//   has run to the edge has to travel the whole diameter before the craft
//   answers the other way, which is the single most common complaint about
//   home-made ones. With it, the answer comes the moment you change direction.
//
//   The circle is drawn where it is. A stick you cannot see is a stick you do
//   not trust; a stick drawn somewhere other than your thumb is worse.
//
//   The middle is a real deadzone. A thumb resting on glass is never quite
//   still, and a control that answers a tenth of a millimetre is a control
//   that never sits level.

import { SCREEN_W, SCREEN_H } from './renderer.js';
import { HOLD_THROTTLE } from './player.js';

// How far the thumb travels for full deflection, in buffer pixels. The buffer
// is always 256 tall whatever the handset is, so this is the same fraction of
// the screen everywhere: about a sixth of its height, which on a phone held
// sideways is a comfortable thumb's reach without moving the hand.
const RADIUS = 42;

// ... and how much of that is nothing at all.
const DEADZONE = 0.10;

// The same expo the tilt steering uses, so the two feel like the same game.
// out = k*u^3 + (1-k)*u: forgiving in the middle where the corrections are,
// steepening towards the edge.
const EXPO = 0.45;

// How quickly the drawn ring arrives and leaves, in seconds.
const FADE_IN = 0.06;
const FADE_OUT = 0.22;

function expo(u) {
  return EXPO * u * u * u + (1 - EXPO) * u;
}

export class TouchStick {
  constructor() {
    this.reset();
  }

  reset() {
    this.id = null;          // the pointer that owns the stick
    this.ox = 0; this.oy = 0;  // where the middle is, in buffer pixels
    this.px = 0; this.py = 0;  // where the thumb is
    this.x = 0; this.y = 0;    // the command, each axis in [-1, 1]
    this.show = 0;             // 0..1, for drawing
  }

  get active() {
    return this.id !== null;
  }

  // The stick is up and running and the thumb has said something.
  get stick() {
    return this.active ? { x: this.x, y: this.y } : null;
  }

  // A thumb has arrived. Wherever it is, that is the middle -- so this
  // commands nothing, which is what lets you grab it without thinking.
  down(id, bx, by) {
    if (this.id !== null) return false;
    this.id = id;
    this.ox = this.px = bx;
    this.oy = this.py = by;
    this.x = this.y = 0;
    return true;
  }

  move(id, bx, by) {
    if (id !== this.id) return;
    this.px = bx;
    this.py = by;

    let dx = bx - this.ox;
    let dy = by - this.oy;
    const len = Math.hypot(dx, dy);

    // The origin trails the thumb once it is past the edge, so the circle is
    // always centred within reach of where the thumb actually is.
    if (len > RADIUS) {
      const pull = (len - RADIUS) / len;
      this.ox += dx * pull;
      this.oy += dy * pull;
      dx = bx - this.ox;
      dy = by - this.oy;
    }

    let m = Math.hypot(dx, dy) / RADIUS;
    if (m > 1) m = 1;
    if (m <= DEADZONE) { this.x = this.y = 0; return; }

    const shaped = expo((m - DEADZONE) / (1 - DEADZONE));
    const k = shaped / (m * RADIUS);
    this.x = dx * k;
    // Screen y grows downwards and the stick's y grows away from the viewer,
    // so up the screen is forwards.
    this.y = -dy * k;
  }

  up(id) {
    if (id !== this.id) return;
    // The command stops at once; the ring does not. Where it was is kept so
    // it can fade from there rather than blinking out from under the thumb
    // that just left it.
    this.id = null;
    this.x = this.y = 0;
  }

  // Fade the ring in and out. Called once a frame whatever is happening.
  tick(dt) {
    const tau = this.active ? FADE_IN : FADE_OUT;
    const k = 1 - Math.exp(-dt / tau);
    this.show += ((this.active ? 1 : 0) - this.show) * k;
    if (this.show < 0.002) this.show = 0;
  }

  // Where to draw the ring and the knob, in buffer pixels, or null when there
  // is nothing to draw. The knob is kept inside the ring -- the thumb may be
  // outside it for a frame while the origin catches up.
  get furniture() {
    if (this.show <= 0) return null;
    let dx = this.px - this.ox, dy = this.py - this.oy;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) { dx *= RADIUS / len; dy *= RADIUS / len; }
    return {
      x: this.ox, y: this.oy, r: RADIUS,
      knobX: this.ox + dx, knobY: this.oy + dy,
      alpha: this.show,
    };
  }
}

// --- the throttle ----------------------------------------------------------
//
// A second thumb, and all it does is say how hard. Up is more.
//
// It is one axis on purpose. A throttle that also steered would be two
// controls fighting over one thumb, and the thing a second thumb is good for
// is exactly the thing a first thumb is bad at: holding a steady amount while
// the other hand is busy doing something else.
//
// It was straight, with no curve on it, on the argument that half power
// ought to mean half power and a curve is a throttle that lies about where
// it is. That argument was about the wrong axis.
//
// What a pilot is choosing is not a number of watts, it is a rate of climb,
// and in this machine those two are nothing like each other: a fifth of full
// power holds the craft level and everything above it climbs. Measured on a
// phone held sideways, with the travel at fifty-two buffer pixels: the whole
// of the descent -- free fall at 1.56 tiles a second, through a gentle sink,
// to holding height -- lived in the first thirteen of them, twenty pixels of
// glass, and the remaining fifty-nine were all climb. That is why it read as
// having no control in it. Nothing was overriding the throttle; there was
// simply nothing useful spread across most of its length.
//
// So the travel is laid out around the one landmark it has. Half way up
// holds your height, the bottom half is every rate of descent from hovering
// to letting go, and the top half is every rate of climb. Power is still
// what comes out of it -- it is where the thumb positions are that has
// changed -- and that is the honest way round, because the thing being
// promised is what the craft does, not what the battery is doing.
//
// Longer, too. A landing is the part that wants the fine control, and the
// bottom half of sixty-eight pixels is fifty-two pixels of glass for it
// where there were twenty.
const THROTTLE_TRAVEL = 68;     // buffer pixels from nothing to everything

// Where it lives. A floating stick is a gesture and belongs under whichever
// thumb turns up; a throttle is a setting and belongs in one place, because
// the whole point of a setting is that it is still there when you come back
// to it. Low on the right, where a right thumb rests with the handset held
// sideways, and clear of the drone count in the corner.
const THROTTLE_X = 30;          // in from the right edge
const THROTTLE_Y = 0.80;        // zero, as a fraction of the screen height

// Power back to travel, for the one moment it is needed: the first grab.
export function throttleTravelFor(p) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return p < HOLD_THROTTLE
    ? p / (2 * HOLD_THROTTLE)
    : 0.5 + (p - HOLD_THROTTLE) / (2 * (1 - HOLD_THROTTLE));
}

// Travel to power. Half of the travel maps onto the fifth of the power that
// holds height; the other half onto the four fifths above it.
export function throttleCurve(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u < 0.5
    ? u * 2 * HOLD_THROTTLE
    : HOLD_THROTTLE + (u - 0.5) * 2 * (1 - HOLD_THROTTLE);
}

export class ThrottleStick {
  constructor() {
    this.reset();
  }

  reset() {
    this.id = null;
    this.value = 0;          // how far up the travel it is set, 0..1
    this.grabY = 0;          // where the thumb landed ...
    this.grabValue = 0;      // ... and what it was set to then
    this.armed = false;      // has it ever been touched this flight
    this.show = 0;
  }

  get active() {
    return this.id !== null;
  }

  // ... and what the setting asks the engines for. The two are different
  // numbers on purpose: the knob is drawn at the setting, and the craft flies
  // on the power.
  get power() {
    return throttleCurve(this.value);
  }

  get x() { return SCREEN_W - THROTTLE_X; }
  get zeroY() { return Math.round(SCREEN_H * THROTTLE_Y); }

  // Is this where the thumb went? The zone is generous -- the whole of the
  // right-hand side -- because a control you have to hit is a control you
  // have to look at.
  static claims(bx) {
    return bx >= SCREEN_W * 0.66;
  }

  // Putting a thumb on it changes nothing by itself. What moves the setting
  // is how far the thumb travels from where it landed, added to where the
  // setting already was.
  //
  // That is what makes it grabbable. An absolute throttle -- where the thumb
  // is, is what it is set to -- jumps to wherever you touch, so picking it up
  // to make a small change slams the engines first. A relative one can be
  // grabbed anywhere in the zone, which is what lets the zone be the whole
  // side of the screen rather than a thin strip you have to aim at.
  //
  // The very first grab takes over from whatever was already being asked
  // for, rather than from nothing. Before the throttle is used, a finger on
  // the glass means full power; if reaching for the throttle dropped it to
  // zero, the engine would cut at the exact moment the pilot went to set it,
  // which is the worst possible time. Seeded, the power does not change at
  // all until the thumb moves.
  down(id, bx, by, seed = 0) {
    if (this.id !== null) return false;
    if (!this.armed) this.value = seed < 0 ? 0 : seed > 1 ? 1 : seed;
    this.id = id;
    this.grabY = by;
    this.grabValue = this.value;
    this.armed = true;
    return true;
  }

  move(id, bx, by) {
    if (id !== this.id) return;
    let v = this.grabValue + (this.grabY - by) / THROTTLE_TRAVEL;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    this.value = v;
  }

  // Letting go leaves it where it is.
  //
  // It used to spring back to nothing, on the reasoning that letting go of a
  // throttle in a game about setting down gently should mean the engine
  // easing off. That is a trigger's reasoning, not a throttle's, and it made
  // the control useless for the thing it exists to do: you cannot set a rate
  // of climb and then put your thumb on the stick, because the moment you
  // lift, the power dies. A throttle stays where you leave it. That is the
  // whole difference between a throttle and a button.
  up(id) {
    if (id !== this.id) return;
    this.id = null;
  }

  tick(dt) {
    // Visible while it is being held, and half visible while it is set,
    // because a setting you cannot see is a setting you have to remember.
    const want = this.active ? 1 : (this.armed ? 0.55 : 0);
    const tau = want > this.show ? FADE_IN : FADE_OUT;
    const k = 1 - Math.exp(-dt / tau);
    this.show += (want - this.show) * k;
    if (this.show < 0.002) this.show = 0;
  }

  get furniture() {
    if (this.show <= 0) return null;
    const y0 = this.zeroY;
    const y1 = y0 - THROTTLE_TRAVEL;
    return {
      x: this.x, y0, y1, knobY: y0 - THROTTLE_TRAVEL * this.value,
      hold: y0 - THROTTLE_TRAVEL * 0.5,
      alpha: this.show, value: this.value,
    };
  }
}

// --- drawing ---------------------------------------------------------------
//
// A ring where the middle is and a knob where the thumb is. Quiet: this is a
// game about looking at the horizon, and a control that shouts is a control
// competing with the thing it is steering. It is drawn as segments because
// there is no circle in the renderer -- everything in this game is flat
// triangles, and a ring is a flat triangle sixteen times.
const RING = [232, 227, 214];
const KNOB = [224, 189, 138];
const SEGMENTS = 20;
const ringCol = [0, 0, 0, 255];
const knobCol = [0, 0, 0, 255];

export function drawTouchStick(rd, f) {
  if (!f) return;
  const a = f.alpha;

  ringCol[0] = RING[0]; ringCol[1] = RING[1]; ringCol[2] = RING[2];
  ringCol[3] = Math.round(70 * a);
  const w = 1;
  for (let i = 0; i < SEGMENTS; i++) {
    const t0 = (i / SEGMENTS) * Math.PI * 2;
    const t1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
    const c0 = Math.cos(t0), s0 = Math.sin(t0);
    const c1 = Math.cos(t1), s1 = Math.sin(t1);
    rd.quad(
      f.x + c0 * (f.r - w), f.y + s0 * (f.r - w),
      f.x + c1 * (f.r - w), f.y + s1 * (f.r - w),
      f.x + c1 * (f.r + w), f.y + s1 * (f.r + w),
      f.x + c0 * (f.r + w), f.y + s0 * (f.r + w),
      ringCol);
  }

  knobCol[0] = KNOB[0]; knobCol[1] = KNOB[1]; knobCol[2] = KNOB[2];
  knobCol[3] = Math.round(150 * a);
  const kr = 7;
  for (let i = 0; i < SEGMENTS; i++) {
    const t0 = (i / SEGMENTS) * Math.PI * 2;
    const t1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
    rd.tri(f.knobX, f.knobY,
           f.knobX + Math.cos(t0) * kr, f.knobY + Math.sin(t0) * kr,
           f.knobX + Math.cos(t1) * kr, f.knobY + Math.sin(t1) * kr,
           knobCol);
  }
}

// The throttle: a track with a filled part and a knob on it. Narrow, because
// it lives under a thumb and the thumb is already showing you where it is.
export function drawThrottle(rd, f) {
  if (!f) return;
  const a = f.alpha;
  const w = 2;
  ringCol[0] = RING[0]; ringCol[1] = RING[1]; ringCol[2] = RING[2];
  ringCol[3] = Math.round(55 * a);
  rd.rect(f.x - w, f.y1, w * 2, f.y0 - f.y1, ringCol);

  // How much of it is in use, filled from the bottom.
  knobCol[0] = KNOB[0]; knobCol[1] = KNOB[1]; knobCol[2] = KNOB[2];
  knobCol[3] = Math.round(120 * a);
  const filled = (f.y0 - f.y1) * f.value;
  if (filled > 0) rd.rect(f.x - w, f.y0 - filled, w * 2, filled, knobCol);

  // The one mark on it: half way, where the craft holds the height it has.
  // A throttle with a landmark is a throttle you can set without watching it,
  // which is the whole point of the thing being under a thumb rather than on
  // a dial.
  ringCol[3] = Math.round(130 * a);
  rd.rect(f.x - 8, f.hold, 16, 1, ringCol);

  knobCol[3] = Math.round(170 * a);
  const kr = 6;
  rd.rect(f.x - kr, f.knobY - 2, kr * 2, 4, knobCol);
}

export { RADIUS as STICK_RADIUS };
