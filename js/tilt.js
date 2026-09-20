// tilt.js -- steering by how the handset is being turned, not by where it is.
//
// The old way asked the player to demonstrate two directions and solved a
// basis against them. It worked, and it was a calibration screen standing
// between someone and a game about pottering about in the sky. It also only
// ever knew one posture: the one you were in when you calibrated. Lie back on
// the sofa afterwards and the craft flew into the ground.
//
// Nothing is demonstrated now and nothing is stored. The handset is read as a
// rate of turn against a neutral that follows you about, which means there is
// no such thing as holding it wrong -- only turning it, which is the only
// thing the game ever wanted to know.
//
// Seven pieces, in the order the numbers flow through them:
//
//   1. Sensor fusion. Gravity from the accelerometer is steady but slow and
//      full of hand shake; the gyroscope is fast and precise and drifts. A
//      complementary filter carries the gravity vector forward with the
//      gyroscope and nudges it back towards the accelerometer a few per cent
//      a frame, which gives a gravity direction that is both quick and stable.
//
//   2. Gyroscope sign detection. Platforms disagree about which way round
//      rotationRate is, and a filter fed a sign-flipped gyroscope fights
//      itself. Rather than keep a table of which handset does what, the two
//      sensors are correlated against each other over a couple of seconds and
//      the sign that agrees is the one used.
//
//   3. Vector projection. The fused gravity vector is projected onto the two
//      axes of the screen -- the screen's, not the handset's, so it survives
//      the page being rotated -- which is what makes a tilt to the right mean
//      the same thing whether the thing is held flat or upright.
//
//   4. A neutral that tracks. An exponential moving average of where the
//      handset has been sitting is the zero, so wherever you have settled is
//      straight ahead. It follows quickly near the middle and slowly out at
//      the edges, because near the middle it is correcting your posture and
//      out at the edges it would be stealing your turn.
//
//   5. Leaky integration. That same average is the leak: hold a lean and it
//      washes out over several seconds, so shifting in your seat mid-flight
//      comes right on its own rather than leaving the craft banked.
//
//   6. Stationary capture. When the gyroscope goes quiet and the stick is
//      near the middle anyway, the neutral is pulled to where the handset
//      actually is, which takes out sensor drift in a fraction of a second
//      instead of a few seconds.
//
//   7. An expo curve. A cubic blend: forgiving in the middle where you are
//      making small corrections, and steepening towards the edge so a big
//      lean is a big turn. Exact at nothing and at everything, so the ends
//      still mean what they say.

// --- the shape of the control ----------------------------------------------

// Degrees of tilt away from neutral for full deflection. Small, because the
// neutral follows you: you are never tilting away from the table, only away
// from wherever you were a moment ago.
const THROW_DEG = 17;

// ... measured as a direction cosine rather than as an angle.
//
// The obvious thing is to take the arcsine of each of the two projections and
// call them roll and pitch. It works while the screen is flattish and falls
// apart as it comes up towards vertical: arcsine flattens out near one, so one
// axis stops answering, and worse, a pure roll shows up as several degrees of
// pitch because both arcsines are moving. Measured at eighty-five degrees of
// recline, a fifteen degree roll put 0.58 on the pitch axis.
//
// The projections themselves have no such problem -- they are the components
// of a unit vector, they move smoothly everywhere, and near flat they are the
// angle anyway. So the throw is a sine as well.
const THROW = Math.sin((THROW_DEG * Math.PI) / 180);
// Pitch is measured as an angle rather than as a cosine, so its throw has to
// be converted back into the same units the roll axis works in.
const THROW_RAD_PER_SIN = ((THROW_DEG * Math.PI) / 180) / THROW;

// How much of the stick is curve and how much is straight. out = k*u^3 +
// (1-k)*u, which is the expo every RC transmitter has had since the seventies:
// monotonic, zero at zero, one at one, and a middle you can breathe in.
const EXPO = 0.45;

// Anything smaller than this is the handset sitting still being held by a
// human, and is not a control input.
const DEADZONE = 0.035;


// --- fusion ----------------------------------------------------------------

// How much of the accelerometer goes into the gravity estimate each sample.
// At 60 Hz this is a time constant of about a third of a second: long enough
// that a shaken hand does not reach the stick, short enough that the gyro
// cannot drift anywhere in it.
const ACCEL_TRUST = 0.05;

// ... and all of it while we are still deciding which way round the gyro is.
const ACCEL_TRUST_UNSURE = 0.5;

// Samples of agreement needed before the gyroscope's sign is settled, and how
// clear the agreement has to be. Two seconds at 60 Hz.
const SIGN_SAMPLES = 120;
const SIGN_MARGIN = 1.4;

// --- the neutral -----------------------------------------------------------

// Seconds for the neutral to follow the handset, at the middle of the stick
// and at the edge of it. The slow one is the leak: a lean held dead still
// washes out over about this long, which is slow enough to fly a turn and
// quick enough that settling into a different posture comes right by itself.
const BASE_TAU_NEAR = 3.0;
const BASE_TAU_FAR = 30.0;

// Stationary capture: degrees per second that counts as not moving, how long
// it has to stay there, and how far off centre the stick may be and still
// have its neutral taken away. That last one matters -- without it, holding a
// perfectly steady turn is exactly the thing that cancels it.
const STILL_RATE = 6.0;
const STILL_SECONDS = 0.5;
const STILL_STICK = 0.12;
const STILL_TAU = 0.25;

// How fast the stick itself is allowed to move, in seconds. This is the last
// of the smoothing and the only one the player can feel as lag, so it is
// small: three frames or so.
const OUT_TAU = 0.05;

// A sample older than this means the page was in the background, and the
// integration should start again rather than take one enormous step.
const MAX_DT = 0.1;

const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

// Time constant to a per-sample blend factor. Frame rates vary, so every
// filter here is written in seconds and converted per sample.
function rate(tau, dt) {
  if (!(tau > 0)) return 1;
  return 1 - Math.exp(-dt / tau);
}

function expo(u) {
  return EXPO * u * u * u + (1 - EXPO) * u;
}

export class TiltSteering {
  constructor() {
    this.reset();
  }

  reset() {
    // Fused gravity, as a unit vector in the handset's own frame.
    this.gx = 0; this.gy = 0; this.gz = 1;
    this.haveGravity = false;

    // Which way round the gyroscope reads, and how sure we are.
    this.gyroSign = 0;          // 0 = undecided, then +1 or -1
    this.signScore = 0;
    this.signSeen = 0;

    // The neutral, in screen-space radians.
    this.baseRoll = 0;
    this.basePitch = 0;
    this.lastRoll = 0;
    this.lastPitch = 0;
    this.haveBase = false;

    this.stillFor = 0;
    this.live = false;
    this.x = 0;
    this.y = 0;
    this.lastAt = 0;
    this.rateMag = 0;
  }

  // Is there a usable reading? Until there is, the caller should fall back to
  // whatever else it has.
  get ready() {
    return this.live && this.haveBase;
  }

  get stick() {
    return this.ready ? { x: this.x, y: this.y } : null;
  }

  // What the sensors are doing, for the readout on the title card. Rounded,
  // because it is read by a person.
  get debug() {
    return {
      mode: this.gyroSign ? 'fused' : (this.haveGravity ? 'gravity' : 'waiting'),
      tiltX: Math.round(Math.asin(clamp1(this.lastRoll - this.baseRoll)) * 180 / Math.PI),
      tiltY: Math.round(Math.asin(clamp1(this.lastPitch - this.basePitch)) * 180 / Math.PI),
      rate: Math.round(this.rateMag),
      x: +this.x.toFixed(2),
      y: +this.y.toFixed(2),
    };
  }

  // --- input ---------------------------------------------------------------

  // One devicemotion sample. `acc` is accelerationIncludingGravity and `rot`
  // is rotationRate; either may be missing bits, and the whole thing works
  // with only the accelerometer, just less smoothly.
  motion(acc, rot, dt, screenAngleDeg) {
    if (!acc) return;
    const ax = acc.x || 0, ay = acc.y || 0, az = acc.z || 0;
    const len = Math.hypot(ax, ay, az);
    // In free fall, or in a lift, or a sensor that has not warmed up: there
    // is no down to be had, so keep the last one.
    if (!(len > 1e-3)) return;

    const step = this._step(dt);

    // accelerationIncludingGravity points *away* from gravity: a handset flat
    // on a table reads about +9.8 on z, not -9.8. So this is the up vector,
    // and tilting an edge down is that edge's axis going negative.
    const ux = ax / len, uy = ay / len, uz = az / len;

    let trust = ACCEL_TRUST;
    if (this.haveGravity && rot) {
      // Rotation rates arrive in degrees per second, about the handset's own
      // three axes: beta about x, gamma about y, alpha about z.
      const wx = ((rot.beta || 0) * Math.PI) / 180;
      const wy = ((rot.gamma || 0) * Math.PI) / 180;
      const wz = ((rot.alpha || 0) * Math.PI) / 180;
      this.rateMag = Math.hypot(rot.beta || 0, rot.gamma || 0, rot.alpha || 0);

      if (this.rateMag > 1e-3) {
        // The handset turns one way, so everything fixed in the room -- the
        // up vector among them -- turns the other way in the handset's frame.
        // d(up)/dt = -w x up.
        const cx = wy * this.gz - wz * this.gy;
        const cy = wz * this.gx - wx * this.gz;
        const cz = wx * this.gy - wy * this.gx;

        if (!this.gyroSign) {
          trust = ACCEL_TRUST_UNSURE;
          this._judgeSign(cx, cy, cz, ux, uy, uz, dt);
        } else {
          const s = this.gyroSign * dt;
          this.gx -= cx * s;
          this.gy -= cy * s;
          this.gz -= cz * s;
        }
      }
    } else {
      this.rateMag = 0;
    }

    // Nudge back towards what the accelerometer says, and renormalise -- the
    // prediction above is a first-order step and does not preserve length.
    if (!this.haveGravity) {
      this.gx = ux; this.gy = uy; this.gz = uz;
      this.haveGravity = true;
    } else {
      const k = 1 - Math.pow(1 - trust, Math.max(0.2, dt * 60));
      this.gx += (ux - this.gx) * k;
      this.gy += (uy - this.gy) * k;
      this.gz += (uz - this.gz) * k;
    }
    const gl = Math.hypot(this.gx, this.gy, this.gz) || 1;
    this.gx /= gl; this.gy /= gl; this.gz /= gl;

    this._resolve(step, screenAngleDeg);
  }

  // The fallback: deviceorientation only, on a handset that will not give us
  // motion. beta is the front-to-back angle and gamma the side-to-side one,
  // both in degrees, and between them they say where up is.
  orientation(beta, gamma, dt, screenAngleDeg) {
    const step = this._step(dt);
    const b = ((beta || 0) * Math.PI) / 180;
    const g = ((gamma || 0) * Math.PI) / 180;
    const ux = -Math.sin(g);
    const uy = Math.sin(b) * Math.cos(g);
    const uz = Math.cos(b) * Math.cos(g);
    const l = Math.hypot(ux, uy, uz) || 1;
    if (!this.haveGravity) {
      this.gx = ux / l; this.gy = uy / l; this.gz = uz / l;
      this.haveGravity = true;
    } else {
      // No gyroscope to carry it, so this one leans harder on the sensor and
      // takes a little more smoothing to make up for it.
      const k = 1 - Math.pow(1 - 0.25, Math.max(0.2, dt * 60));
      this.gx += (ux / l - this.gx) * k;
      this.gy += (uy / l - this.gy) * k;
      this.gz += (uz / l - this.gz) * k;
    }
    this.rateMag = 0;
    this._resolve(step, screenAngleDeg);
  }

  // --- the works -----------------------------------------------------------

  _step(dt) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    let step = dt;
    if (!(step > 0)) step = this.lastAt ? now - this.lastAt : 1 / 60;
    this.lastAt = now;
    if (!(step > 0) || step > MAX_DT) step = 1 / 60;
    return step;
  }

  // Which sign of the gyroscope agrees with the accelerometer?
  //
  // The predicted change in the up vector and the measured one should point
  // the same way. Correlate them: a positive total means the gyroscope reads
  // as the specification says, a negative one means the platform has it the
  // other way round. Two seconds of hand movement settles it, and until it
  // does the accelerometer is driving on its own.
  _judgeSign(cx, cy, cz, ux, uy, uz, dt) {
    const mx = ux - this.gx, my = uy - this.gy, mz = uz - this.gz;
    // -c * dt is the predicted change for a sign of +1.
    const dot = -(cx * mx + cy * my + cz * mz) * dt;
    const scale = Math.hypot(cx, cy, cz) * dt * Math.hypot(mx, my, mz);
    if (scale > 1e-9) {
      this.signScore += dot / scale;
      this.signSeen++;
    }
    if (this.signSeen >= SIGN_SAMPLES) {
      if (Math.abs(this.signScore) >= SIGN_MARGIN) {
        this.gyroSign = this.signScore > 0 ? 1 : -1;
      } else {
        // Two seconds and no opinion means the handset barely moved, or the
        // gyroscope is noise. Take the specification's word for it and carry
        // on -- the accelerometer will still be correcting either way.
        this.gyroSign = 1;
      }
    }
  }

  _resolve(dt, screenAngleDeg) {
    // Project the up vector onto the screen's own axes. screen.orientation
    // says how far the page is turned from the handset's natural way up, so
    // undoing that rotation puts the handset's reading into the frame the
    // player is actually looking at.
    const a = ((screenAngleDeg || 0) * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    const sx = this.gx * ca + this.gy * sa;
    const sy = -this.gx * sa + this.gy * ca;


    // Tipping an edge down takes the up vector negative along that edge's
    // axis, so the sign turns over: right edge down is a turn to the right,
    // top edge away is a push forward.
    // Roll is the projection itself. The screen's left-right axis stays
    // horizontal however far back the thing is held, so tipping one end of it
    // down always moves gravity by the sine of the angle it was tipped --
    // which is why this reads the same at every posture without help.
    const roll = -clamp1(sx);

    // Pitch is the angle between gravity and the screen's normal, taken in
    // the plane that contains them both. Three formulations were measured:
    //
    //   the projection alone   correct flat, fades to a fifth of its gain by
    //                          seventy degrees of recline -- the screen's
    //                          up-down axis rises as you lean back, so
    //                          pitching it further barely moves gravity
    //   arcsine of it          correct gain everywhere, but a hard roll leaks
    //                          0.58 into pitch at eighty-five degrees
    //   this                   correct gain everywhere, and 0.00 of leak
    //
    // It comes out exact because a roll about the screen's normal does not
    // change how much of gravity points out of the screen at all, so the
    // denominator here is blind to it, while a pitch moves both terms
    // together and the arctangent gives the angle straight back.
    const pitch = -Math.atan2(sy, this.gz) / THROW_RAD_PER_SIN;
    this.lastRoll = roll;
    this.lastPitch = pitch;

    if (!this.haveBase) {
      this.baseRoll = roll;
      this.basePitch = pitch;
      this.haveBase = true;
      this.live = true;
      return;
    }

    // What the stick said last frame decides how eagerly the neutral follows
    // now: near the middle it is correcting your posture and should be quick,
    // out at the edge it would be taking away the turn you are flying.
    const off = Math.min(1, Math.hypot(this.x, this.y));
    let tau = BASE_TAU_NEAR + (BASE_TAU_FAR - BASE_TAU_NEAR) * off * off;

    // Stationary capture. A quiet gyroscope and a stick that is not doing
    // much means whatever drift has crept in can go now.
    if (this.rateMag < STILL_RATE && off < STILL_STICK) {
      this.stillFor += dt;
      if (this.stillFor >= STILL_SECONDS) tau = STILL_TAU;
    } else {
      this.stillFor = 0;
    }

    const k = rate(tau, dt);
    this.baseRoll += (roll - this.baseRoll) * k;
    this.basePitch += (pitch - this.basePitch) * k;

    // Delta from the neutral is the whole of the control.
    let ux = (roll - this.baseRoll) / THROW;
    let uy = (pitch - this.basePitch) / THROW;

    // Clamp the length rather than each axis: clamping separately confines
    // the stick to a square, so leaning hard in any direction pegs both and
    // every heading collapses onto the nearest diagonal.
    const mag = Math.hypot(ux, uy);
    if (mag > 1) { ux /= mag; uy /= mag; }

    // Expo, applied to the length so it cannot bend the heading.
    const m = Math.hypot(ux, uy);
    let tx = 0, ty = 0;
    if (m > DEADZONE) {
      const shaped = expo((m - DEADZONE) / (1 - DEADZONE));
      tx = (ux / m) * shaped;
      ty = (uy / m) * shaped;
    }

    const ok = rate(OUT_TAU, dt);
    this.x += (tx - this.x) * ok;
    this.y += (ty - this.y) * ok;
    this.live = true;
  }
}
