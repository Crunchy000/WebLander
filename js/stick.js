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

export function expo(u) {
  return EXPO * u * u * u + (1 - EXPO) * u;
}

export class TouchStick {
  // `linear` leaves out the expo. The steering stick wants it -- fine
  // corrections in the middle -- but the thrust stick is laid out around its
  // hold point by throttleCurve, and a curve on top of a curve would put that
  // point somewhere a thumb cannot find.
  constructor({ linear = false } = {}) {
    this.linear = linear;
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

    const u = (m - DEADZONE) / (1 - DEADZONE);
    const shaped = this.linear ? u : expo(u);
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

// --- the throttle curve ------------------------------------------------------
//
// Up on the height stick -- the pad's right stick, or the right thumb on the
// glass -- is a throttle, and this is how its travel maps onto power.
//
// What a pilot is choosing is not a number of watts, it is a rate of climb,
// and in this machine those two are nothing like each other: a fifth of full
// power holds the craft level and everything above it climbs. Laid out
// straight, the whole of the descent -- free fall, through a gentle sink, to
// holding height -- lived in the first fifth of the travel, and the rest was
// all climb.
//
// So the travel is laid out around the one landmark it has. Half way up
// holds your height, the bottom half is every rate of descent from hovering
// to letting go, and the top half is every rate of climb. Travel to power:
export function throttleCurve(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u < 0.5
    ? u * 2 * HOLD_THROTTLE
    : HOLD_THROTTLE + (u - 0.5) * 2 * (1 - HOLD_THROTTLE);
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

export { RADIUS as STICK_RADIUS };
