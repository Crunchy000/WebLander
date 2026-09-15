// tilt.js -- learning the handset's tilt mapping instead of deriving it.
//
// Working out which way a phone is tilted from `deviceorientation` is a
// thicket: beta and gamma are reported in the handset's own frame, the screen
// orientation angle is defined differently across platforms, and none of it
// accounts for how the player actually holds the thing. Every fixed formula is
// a guess, and a guess that is wrong on some devices.
//
// So we do not guess. The player demonstrates two directions -- "away from me"
// and "to my right" -- and those two vectors become the basis we solve
// against. Whatever the sensor reports, whatever way up the phone is, whatever
// angle it is held at, the mapping comes out right, because it was measured
// rather than assumed.

const STORE_KEY = 'weblander.tilt';

// Demonstrated tilts are rescaled into this range, so someone who calibrates
// with a tiny flick does not end up with hair-trigger steering, and someone
// who heaves the phone over does not need to do that in play.
const MIN_THROW = 10;   // degrees for full deflection
const MAX_THROW = 30;

// The two demonstrated directions have to be meaningfully different, or the
// basis is near-singular and the mapping blows up. sin(20 degrees).
const MIN_SEPARATION = 0.34;

export const wrapDeg = (d) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);

// Difference between two orientation readings, as (gamma, beta).
export function delta(raw, zero) {
  return {
    g: wrapDeg(raw.gamma - zero.gamma),
    b: wrapDeg(raw.beta - zero.beta),
  };
}

export function magnitude(d) {
  return Math.hypot(d.g, d.b);
}

// Rescale a demonstrated direction to a given throw, keeping its heading.
function scaleTo(d, target) {
  const len = magnitude(d);
  if (len < 1e-3) return null;
  const k = target / len;
  return { g: d.g * k, b: d.b * k };
}

export class TiltMapper {
  constructor() {
    this.zero = null;
    this.inv = null;    // 2x2 inverse basis, as [a, b, c, d]
    this.load();
  }

  get calibrated() {
    return !!(this.zero && this.inv);
  }

  setZero(raw) {
    this.zero = { beta: raw.beta, gamma: raw.gamma };
  }

  // Build the mapping from the two demonstrated tilts. Returns null on
  // success, or a message explaining why it could not be used.
  build(awayDelta, rightDelta) {
    // Both axes share one throw, taken from the average of what was
    // demonstrated. Scaling each to its own length would make the craft
    // answer sooner to one axis than the other, which reads as the compass
    // being skewed rather than as a sensitivity difference.
    const la = magnitude(awayDelta), lr = magnitude(rightDelta);
    if (la < 1e-3 || lr < 1e-3) return 'That tilt was too small to read.';

    const throwDeg = Math.min(MAX_THROW, Math.max(MIN_THROW, (la + lr) / 2));
    const A = scaleTo(awayDelta, throwDeg);
    const R = scaleTo(rightDelta, throwDeg);
    if (!A || !R) return 'That tilt was too small to read.';

    // Reject two directions that are too close to tell apart.
    const cross = R.g * A.b - A.g * R.b;
    const sep = Math.abs(cross) / (magnitude(R) * magnitude(A));
    if (sep < MIN_SEPARATION) {
      return 'Those two tilts were too alike. Try again, making them clearly different.';
    }

    // Columns of the basis are R and A, so solving against it gives the
    // stick directly: a tilt equal to R reads as x = 1, one equal to A as
    // y = 1. Store the inverse so mapping is a couple of multiplies.
    //
    //   B = [ R.g  A.g ]        B^-1 = 1/det [  A.b  -A.g ]
    //       [ R.b  A.b ]                     [ -R.b   R.g ]
    const det = cross;
    this.inv = [A.b / det, -A.g / det, -R.b / det, R.g / det];
    return null;
  }

  // Map a raw orientation reading to a stick position, or null if we have no
  // calibration yet.
  map(raw) {
    if (!this.calibrated || !raw) return null;
    const d = delta(raw, this.zero);
    const [a, b, c, e] = this.inv;

    let x = a * d.g + b * d.b;
    let y = c * d.g + e * d.b;

    // Clamp the length, keeping the bearing. Clamping each axis separately
    // would confine the stick to a square: lean hard in any direction and
    // both axes peg, collapsing every heading onto the nearest diagonal.
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }

    return { x, y };
  }

  save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ zero: this.zero, inv: this.inv }));
    } catch { /* private mode */ }
  }

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const v = JSON.parse(raw);
      if (v && v.zero && Array.isArray(v.inv) && v.inv.length === 4 &&
          v.inv.every((n) => Number.isFinite(n))) {
        this.zero = v.zero;
        this.inv = v.inv;
      }
    } catch { /* corrupt or unavailable; stay uncalibrated */ }
  }

  clear() {
    this.zero = null;
    this.inv = null;
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  }
}

// --- steady-hold detection -------------------------------------------------
//
// The player cannot comfortably tap the screen while holding the phone at an
// angle -- they would have to look away from it at the moment it matters. So
// instead we watch for a tilt that is held still, and capture that.

export class SteadyHold {
  constructor({ minTilt = 9, tolerance = 4, frames = 26 } = {}) {
    this.minTilt = minTilt;      // degrees away from neutral to count
    this.tolerance = tolerance;  // how much wobble is still "still"
    this.frames = frames;        // how long it must be held
    this.reset();
  }

  reset() {
    this.samples = [];
    this.armed = false;
  }

  // Feed a delta each frame. Returns progress 0..1, and the captured reading
  // once it reaches 1.
  //
  // Nothing is captured until the handset has first come back near centre.
  // Each step starts with the phone still held at the previous step's angle,
  // and without this the leftover tilt is read straight back as the answer to
  // the next question.
  push(d) {
    const m = magnitude(d);

    if (!this.armed) {
      if (m < this.minTilt * 0.5) this.armed = true;
      return { progress: 0, captured: null, needsCentre: true };
    }

    if (m < this.minTilt) {
      this.samples.length = 0;
      return { progress: 0, captured: null };
    }

    this.samples.push(d);
    if (this.samples.length > this.frames) this.samples.shift();

    // Steady means every recent sample sits near the mean.
    let sg = 0, sb = 0;
    for (const s of this.samples) { sg += s.g; sb += s.b; }
    const mg = sg / this.samples.length, mb = sb / this.samples.length;

    for (const s of this.samples) {
      if (Math.hypot(s.g - mg, s.b - mb) > this.tolerance) {
        // Wobbled: keep the latest reading but restart the clock.
        this.samples = [d];
        return { progress: 0, captured: null };
      }
    }

    const progress = this.samples.length / this.frames;
    if (progress >= 1) {
      this.samples.length = 0;
      return { progress: 1, captured: { g: mg, b: mb } };
    }
    return { progress, captured: null };
  }
}
