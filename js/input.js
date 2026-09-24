// input.js -- mouse, keyboard, touch and tilt, all funnelled into one stick.
//
// The original flies from the absolute mouse position: the pointer's distance
// from the centre of its range sets how hard the craft leans, and its bearing
// sets which way. That is a position-based control scheme, not a rate-based
// one, which is exactly what a phone's tilt sensor gives you -- so tilt is not
// a compromise here, it is arguably the more natural fit of the two.

import { clamp } from './maths.js';
import { TiltSteering } from './tilt.js';
import { TouchStick, throttleCurve, expo } from './stick.js';
import { SCREEN_W, SCREEN_H } from './renderer.js';

// A deadzone on one axis of a stick, with the travel beyond it rescaled so
// the rim still reads 1. The thumb sticks on the glass are round, but the
// left one is two controls on one thumb -- height and strafe -- and a thumb
// pushing one of them is never quite square to the other. Without this every
// strafe was also a gentle climb or sink, and every climb a slow slide.
const AXIS_DEAD = 0.15;
function axisDead(v) {
  const a = Math.abs(v);
  return a <= AXIS_DEAD ? 0 : Math.sign(v) * (a - AXIS_DEAD) / (1 - AXIS_DEAD);
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas;

    // The virtual stick, each axis in [-1, 1]. One convention, and every
    // input below must produce it:
    //
    //   x > 0  lean right      y > 0  lean away from the viewer
    //   x < 0  lean left       y < 0  lean towards the viewer
    //
    // "Away" is up the screen, towards the horizon.
    this.stick = { x: 0, y: 0 };

    // Tilt steering. Nothing to calibrate and nothing stored: it reads the
    // handset as a rate of turn against a neutral that follows the player
    // about. See tilt.js.
    this.tilt = new TiltSteering();

    // ... and the other way of steering a handset: a stick that appears under
    // whichever thumb arrives. Which of the two is in charge is `steerMode`,
    // and a device with no motion sensor gets the stick whatever it says.
    // Two of them, one under each thumb, laid out as the pad's two sticks
    // are: see _canvasTouch. The left carries two different controls and is
    // shaped per axis in sample(), so it is linear; the right is the lean,
    // and is the steering stick it always was.
    this.leftThumb = new TouchStick({ linear: true });
    this.rightThumb = new TouchStick();
    // How much power is being asked for, 0 to 1. Whatever is steering, some
    // sources say only yes or no and some say how much; this is how much, and
    // it is 1 for the ones that only say yes.
    this.throttle = 1;
    this.steerMode = 'touch';
    this.thrust = 0;      // 0 none, 1 hover, 2 full
    this.hold = false;    // the second stick centred: stay at this height
    this.fire = false;
    this.startPressed = false;

    // Keyboard steering integrates towards a target rather than snapping.
    this.keys = new Set();
    this.keyStick = { x: 0, y: 0 };
    this.thumbStick = { x: 0, y: 0 };

    // A console is not a phone, but it looks like one to feature detection: a
    // gamepad counts as a coarse pointer and Edge on Xbox reports touch points
    // it has no way to deliver. That is why the tilt calibration turned up on
    // a television. A connected gamepad settles it -- nothing with a pad
    // wants a tilt sensor -- so the touch interface is gated on both.
    this.hasTouch = matchMedia('(pointer: coarse)').matches && (navigator.maxTouchPoints || 0) > 0;
    this.padConnected = this._anyPad();
    this.padUsed = false;
    this.onPadChange = null;

    // A real mouse, as opposed to a gamepad or a remote pretending to be one.
    // A console has no fine pointer, which is how we know a pad there should
    // be trusted from the moment it is seen rather than once it is waggled.
    this.finePointer = matchMedia('(pointer: fine)').matches;

    addEventListener('gamepadconnected', () => this._padChanged(true));
    addEventListener('gamepaddisconnected', () => this._padChanged(this._anyPad()));
    this.tiltEnabled = false;
    this.tiltRaw = null;          // last raw reading, for the readout
    this._lastMotionAt = 0;
    this._haveMotion = false;
    this._listening = false;

    // Gamepad. Nothing to bind: the API is polled, not evented, so the whole
    // of it lives in _pollPad below.
    this.padStick = { x: 0, y: 0 };
    this.padActive = false;
    this.padThrust = 0;
    this.padLift = 0;
    this.padFire = false;
    this.padAnyButton = false;
    this._padStartWas = false;

    this._bindKeyboard();
    this._bindMouse();
    this._bindTouch();
  }

  // Is a pad plugged in right now? Asked at startup as well as listened for:
  // gamepadconnected only fires on a change, and on a console the pad was
  // already there before the page existed.
  _anyPad() {
    if (!navigator.getGamepads) return false;
    for (const p of navigator.getGamepads()) if (p && p.connected) return true;
    return false;
  }

  _padChanged(now) {
    if (now === this.padConnected) return;
    this.padConnected = now;
    if (!now) this.padUsed = false;
    this.onPadChange?.(now);
  }

  // Ask the browser again whether a pad is there. Worth doing at the moment
  // a button is pressed: on a console the first press is what reveals the pad
  // in the first place, so anything deciding on the strength of padConnected
  // during that same press would otherwise be reading a stale no.
  refreshPads() {
    this._padChanged(this._anyPad());
    return this.padConnected;
  }

  // Should the pad be steering, including while it sits perfectly still?
  //
  // Taking it only when the stick is deflected looked reasonable and flies
  // horribly: a centred pad hands control straight back to the mouse, and on
  // a console the cursor is parked wherever it was last left, so the craft
  // leans towards it between every nudge. A plugged-in pad owns the stick.
  //
  // On a desktop, where someone may have a pad connected and still want the
  // mouse, it only takes over once it has actually been touched.
  get padOwns() {
    return this.padConnected && (this.padUsed || !this.finePointer);
  }

  // Which control help and which on-screen furniture this device should get.
  // Touch only wins when there is no pad to prefer.
  get touchUi() {
    return this.hasTouch && !this.padConnected;
  }

  // -- keyboard -------------------------------------------------------------

  _bindKeyboard() {
    const down = (e) => {
      // Don't swallow browser shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      if (e.code === 'Enter' || e.code === 'Space') this.startPressed = true;
    };
    const up = (e) => this.keys.delete(e.code);
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('blur', () => this.keys.clear());
  }

  // -- mouse ----------------------------------------------------------------

  _bindMouse() {
    const c = this.canvas;
    const stage = c.parentElement;

    // Steering reads the pointer's position, not its movement, so the cursor
    // leaving the canvas or the window losing focus used to strand the stick
    // wherever it was last seen. Pointer lock fixes that at the source: the
    // cursor cannot leave, because there is no longer a cursor.
    //
    // Locked, the browser reports movement rather than position, so the
    // position is kept here instead and the same mapping applied to it, so
    // locking and unlocking change nothing about how it flies.
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === c;
      this._spiked = false;
      this._lastMove = 0;
    });
    document.addEventListener('pointerlockerror', () => { this.locked = false; });

    // The same scale on both axes, and a round rim.
    //
    // It was half the canvas width across and half its height up and down,
    // clamped per axis. On a canvas twice as wide as it is tall that made
    // up-and-down twice as sensitive as side-to-side, so the craft leaned at
    // 28 degrees when the hand went at 45 -- the lean never quite went where
    // the mouse did. And the square clamp let the stick sit at 1.41 in a
    // corner: a loop starts at 0.96 and only lets go below 0.80, so after
    // pulling a fifth of the way back out of a corner it still read 1.13 and
    // the craft went on looping. A stick has a round rim, and now so does this
    // one: full deflection is half the canvas height in any direction, and
    // the first movement back off the rim is answered at once.
    const radius = () => {
      const h = c.getBoundingClientRect().height;
      return h > 0 ? h / 2 : 0;
    };
    const rim = (x, y) => {
      const m = Math.hypot(x, y);
      return m > 1 ? { x: x / m, y: y / m } : { x, y };
    };

    // On the window rather than the canvas: when the window is a different
    // shape from the game there are bars at the sides, and a pointer over
    // them is still steering.
    addEventListener('mousemove', (e) => {
      this._buttons(this._held &= e.buttons);
      if (this.touchUi && this.tiltEnabled) return;
      const R = radius();
      if (!R) return;

      if (this.locked) {
        // Some browsers now and then report a single movement far larger
        // than any hand made -- Chrome with pointer lock is the one people
        // meet -- and with the position kept here, a spike does not flick
        // the stick and come back: it moves it to the rim and leaves it
        // there. So a movement of more than the stick's whole radius in one
        // event, out of nowhere, is held back. If the next one is large too,
        // it was a real flick, and it goes through -- a hand that fast was
        // at the rim either way.
        const d = Math.hypot(e.movementX, e.movementY);
        if (d > R && d > this._lastMove * 4 && !this._spiked) {
          this._spiked = true;
          return;
        }
        this._spiked = false;
        this._lastMove = d;
        this.mouseStick = rim(
          this.mouseStick.x + e.movementX / R,
          // Negated: screen y grows downwards, but moving up the screen,
          // towards the horizon, has to fly away from the viewer.
          this.mouseStick.y - e.movementY / R);
        return;
      }

      // Unlocked, where the pointer is, measured from the middle of the
      // canvas, is the stick -- the way the original maps the mouse's
      // range onto -512..+511.
      const r = c.getBoundingClientRect();
      this.mouseStick = rim(
        (e.clientX - (r.left + r.width / 2)) / R,
        ((r.top + r.height / 2) - e.clientY) / R);
    });

    // The buttons, read from the mask the browser keeps rather than tracked
    // press by press. Tracked, letting go of the middle button cut the power
    // while the left was still held, and a press whose release never arrived
    // -- the window losing focus with a button down -- left the engine on
    // until the next click.
    //
    // Anywhere in the play area, not only on the canvas: a click on the bars
    // at the sides used to do nothing. The title card covers the whole stage
    // while it is up, so this cannot reach under it. Only a press that began
    // here counts: the click on the start button may still be held as the
    // flight begins, and that is not a request for power.
    stage.addEventListener('mousedown', (e) => {
      if (e.target !== c && e.target !== stage) return;
      e.preventDefault();
      // Any click takes the pointer back, so wandering out of the window or
      // pressing Escape costs one click rather than the rest of the flight.
      this.grabPointer();
      this._buttons(this._held = e.buttons);
    });
    addEventListener('mouseup', (e) => this._buttons(this._held &= e.buttons));
    addEventListener('blur', () => this._buttons(this._held = 0));
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    this.mouseStick = { x: 0, y: 0 };
    this.mouseThrust = 0;
    this.mouseFire = false;
    this.locked = false;
    this._held = 0;
    this._spiked = false;
    this._lastMove = 0;
  }

  // Left is full power, middle is hover, right is the gun.
  _buttons(mask) {
    this.mouseThrust = mask & 1 ? 2 : mask & 4 ? 1 : 0;
    this.mouseFire = !!(mask & 2);
  }

  // Ask for the pointer. Needs a user gesture, and throws if it is called too
  // soon after the last exit, so every failure here is one to shrug at: the
  // absolute mapping is still underneath and still flies.
  grabPointer() {
    // Nothing to capture on a console or a handset, and asking would only
    // fail noisily.
    if (this.hasTouch || this.padConnected || this.locked) return;
    try {
      // Newer browsers return a promise here, so the rejection has to be
      // caught as well as the throw. Without both, a refusal -- which is
      // routine, it needs a fresh user gesture -- surfaces as an unhandled
      // error in the console.
      const r = this.canvas.requestPointerLock?.();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* not now, then */ }
  }

  // -- touch ----------------------------------------------------------------

  _bindTouch() {
    const bind = (id, set) => {
      const el = document.getElementById(id);
      if (!el) return;
      const on = (e) => { e.preventDefault(); set(true); el.dataset.on = '1'; };
      const off = (e) => { e.preventDefault(); set(false); delete el.dataset.on; };
      el.addEventListener('touchstart', on, { passive: false });
      el.addEventListener('touchend', off, { passive: false });
      el.addEventListener('touchcancel', off, { passive: false });
      el.addEventListener('mousedown', on);
      el.addEventListener('mouseup', off);
      el.addEventListener('mouseleave', off);
    };
    bind('btn-thrust', (v) => { this.touchThrust = v; });

    this.touchThrust = false;
    this.touchFire = false;

    this.fingers = 0;     // on the game itself
    this.touchSteers = true;

    for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      this.canvas.addEventListener(ev, (e) => this._canvasTouch(e), { passive: false });
    }
  }

  // What a finger means depends on what is steering.
  //
  // Steering by stick, there are two, laid out as the pad's are, and the
  // side of the screen a thumb lands on says which it gets:
  //
  //   left thumb    up/down     height: left alone it holds, up climbs,
  //                             down sinks
  //                 left/right  strafe
  //   right thumb               the lean, on the screen: up is away, down
  //                             towards, left and right tilt that way
  //
  // By side rather than by arrival, because first-come was tried and it
  // swaps the controls over whenever the right thumb happens to land first.
  // A thumb on a side whose stick is already taken does nothing.
  //
  // Steering by tilt, the handset is the stick, so there is nothing for a
  // finger to steer: any finger on the glass is full power, and no ring is
  // drawn under it.
  //
  // Both sticks are fed whatever the mode, so switching between tilt and
  // touch mid-flight does not need them warming up first.
  _canvasTouch(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // Client pixels into the buffer the game is drawn in, so the ring can be
    // drawn where the thumb actually is at any screen size.
    const toBuffer = (t) => [
      ((t.clientX - r.left) / r.width) * SCREEN_W,
      ((t.clientY - r.top) / r.height) * SCREEN_H,
    ];

    const sticks = [this.leftThumb, this.rightThumb];
    for (const t of e.changedTouches) {
      const [bx, by] = toBuffer(t);
      if (e.type === 'touchstart') {
        (bx < SCREEN_W / 2 ? this.leftThumb : this.rightThumb).down(t.identifier, bx, by);
      } else {
        for (const s of sticks) {
          if (e.type === 'touchmove') s.move(t.identifier, bx, by);
          else s.up(t.identifier);
        }
      }
    }
    // A finger lifted elsewhere can leave a stick owned by one that is no
    // longer down, so the owners are checked against the live list as well.
    for (const s of sticks) {
      if (!s.active) continue;
      let stillDown = false;
      for (const t of e.touches) if (t.identifier === s.id) stillDown = true;
      if (!stillDown) s.up(s.id);
    }

    // Fingers on the game itself, not on anything laid over it.
    this.fingers = e.targetTouches.length;
  }

  // -- tilt -----------------------------------------------------------------

  // Must be called from a user gesture on iOS, which gates motion data behind
  // an explicit permission prompt.
  //
  // Motion is what is wanted -- it carries the gyroscope as well as the
  // accelerometer -- and orientation is the fallback for a handset that will
  // not give it. Both are asked for, because iOS gates them separately and a
  // device may answer one and not the other.
  async enableTilt() {
    const DME = window.DeviceMotionEvent;
    const DOE = window.DeviceOrientationEvent;
    if (!DME && !DOE) return false;

    const ask = async (ctor) => {
      if (!ctor || typeof ctor.requestPermission !== 'function') return !!ctor;
      try {
        return (await ctor.requestPermission()) === 'granted';
      } catch {
        return false;
      }
    };
    const motionOk = await ask(DME);
    const orientOk = await ask(DOE);
    if (!motionOk && !orientOk) return false;

    // Once only. This is reached from the start button, and the start button
    // is also how a flight begins again after the last drone is gone -- so
    // without this, every restart hung another devicemotion listener on the
    // window. Two listeners is every sample fed to the filter twice, which
    // halves every time constant in it; three is a third. Whatever was
    // already attached is still attached and still working, so the answer is
    // simply whether a sensor has ever spoken.
    if (this._listening) return this.tiltEnabled;
    this._listening = true;

    // The constructor existing proves nothing. Edge on a console has
    // DeviceOrientationEvent and no sensor whatsoever, and returning true on
    // that basis is what put a tilt calibration screen on a television. Only
    // an actual reading counts as a sensor.
    //
    // The listeners stay attached either way: a handset that is slow to
    // report still gets tilt once it starts, it just will not have been
    // waited for.
    return await new Promise((resolve) => {
      let settled = false;
      const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };

      if (motionOk) {
        addEventListener('devicemotion', (e) => {
          const acc = e.accelerationIncludingGravity;
          if (!acc || (acc.x === null && acc.y === null && acc.z === null)) return;
          const now = performance.now();
          // Prefer the event's own interval, which is what the sensor is
          // actually running at; fall back to the clock.
          let dt = e.interval > 0 ? e.interval / 1000 : 0;
          if (!dt) dt = this._lastMotionAt ? (now - this._lastMotionAt) / 1000 : 0;
          this._lastMotionAt = now;
          this._haveMotion = true;
          this.tiltRaw = {
            ax: acc.x || 0, ay: acc.y || 0, az: acc.z || 0,
            rate: e.rotationRate || null,
          };
          this.tilt.motion(acc, e.rotationRate, dt, this.screenAngle(), e.acceleration);
          this.tiltEnabled = true;
          settle(true);
        });
      }

      if (orientOk) {
        addEventListener('deviceorientation', (e) => {
          if (e.beta === null && e.gamma === null) return;
          // Motion carries a gyroscope and this does not, so once motion is
          // arriving this is only in the way.
          if (this._haveMotion) return;
          this.tiltRaw = { beta: e.beta || 0, gamma: e.gamma || 0, rate: null };
          this.tilt.orientation(e.beta, e.gamma, 0, this.screenAngle());
          this.tiltEnabled = true;
          settle(true);
        });
      }

      // Long enough for a real sensor to speak up, short enough not to be a
      // pause on the way into the game.
      setTimeout(() => settle(false), 350);
    });
  }

  // How far the picture is turned from the handset's natural orientation.
  //
  // The two ways of asking do not agree. screen.orientation.angle is the
  // standard and is what the projection is written against; window.orientation
  // is the old iOS one and runs the other way round, so ninety on one is two
  // hundred and seventy on the other. Reporting either as if it were the
  // other puts a handset held sideways a hundred and eighty degrees out,
  // which reverses both steering axes at once.
  screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
    const legacy = window.orientation || 0;
    return ((-legacy % 360) + 360) % 360;
  }

  _tiltStick() {
    if (!this.tiltEnabled) return null;
    const stick = this.tilt.stick;
    if (!stick) return null;
    this.tiltDebug = this.tilt.debug;
    return stick;
  }

  // -- gamepad --------------------------------------------------------------
  //
  // The standard mapping, which is what an Xbox pad reports in every browser
  // that supports the API: A 0, B 1, X 2, Y 3, LB 4, RB 5, LT 6, RT 7,
  // View 8, Menu 9, and the d-pad 12-15.
  //
  // Nothing is bound or registered. getGamepads is a poll, and a pad that is
  // unplugged mid-flight simply stops answering, which is the behaviour we
  // want anyway.
  _pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) {
      if (p && p.connected) { pad = p; break; }
    }
    // Some browsers keep getGamepads empty until the first button press, so
    // the poll doubles as detection rather than trusting the event alone.
    this._padChanged(!!pad);

    if (!pad) {
      this.padActive = false;
      this.padAnyButton = false;
      this.padThrust = 0;
      this.padLift = 0;
        this.padFire = false;
      return;
    }

    const btn = (i) => (pad.buttons[i] ? pad.buttons[i].value > 0.25 || pad.buttons[i].pressed : false);
    const axis = (i) => (pad.axes.length > i ? pad.axes[i] : 0);

    // Two sticks, laid out as the player asked for them:
    //
    //   left stick    up/down     height: centred holds it, up climbs,
    //                             down sinks (see Input.sample)
    //                 left/right  strafe
    //   right stick               the lean itself, on the screen: up flies
    //                             away, down towards, left and right tilt
    //                             that way
    //
    // Nothing turns the craft. Directions are the screen's, as they are for
    // the mouse and the tilt, and the bird faces whichever way it leans --
    // side on when it is going sideways.
    //
    // Screen y runs down and the sticks report up as negative, so the signs
    // flip to meet the one convention every input here has to produce:
    // y > 0 is away.
    //
    // The left stick is two unrelated controls, so its deadzones are per
    // axis: a thumb pushing one of them is never quite square to the other,
    // and a round deadzone let every climb strafe a little.
    const DEAD = 0.14;
    const dz = (v) => {
      const a = Math.abs(v);
      return a <= DEAD ? 0 : Math.sign(v) * Math.min(1, (a - DEAD) / (0.95 - DEAD));
    };
    this.padLift = dz(-axis(1));
    // Strafe gets the steering expo: gentle in the middle, where the
    // corrections are.
    const strafe = Math.sign(axis(0)) * expo(Math.abs(dz(axis(0))));

    // The right stick is one control -- a direction -- so its deadzone is on
    // the magnitude. Squaring it off would make the corners reachable and the
    // cardinals sticky, which is the same mistake the tilt mapper made and
    // the same fix.
    let x = axis(2), y = -axis(3);
    const LEAN_DEAD = 0.16;
    let m = Math.hypot(x, y);
    if (m < LEAN_DEAD) {
      x = y = 0;
    } else {
      // Rescale so the stick still reaches full deflection after the deadzone
      // is taken out of the bottom of its travel.
      const k = Math.min(1, (m - LEAN_DEAD) / (0.95 - LEAN_DEAD)) / m;
      x *= k; y *= k;
    }
    // The d-pad, for whoever prefers it, is the same lean.
    if (btn(14)) x = -1; else if (btn(15)) x = 1;
    if (btn(12)) y = 1; else if (btn(13)) y = -1;
    // Strafe adds to the lean across; together they are still one stick.
    x += strafe;
    m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    this.padStick.x = x;
    this.padStick.y = y;

    // Right trigger or A for full power, left trigger or X to hover. They win
    // over the height stick while they are held.
    this.padThrust = (btn(7) || btn(0)) ? 2 : (btn(6) || btn(2)) ? 1 : 0;
    this.padFire = btn(5) || btn(1) || btn(4);

    let any = false;
    for (const b of pad.buttons) if (b && (b.pressed || b.value > 0.5)) { any = true; break; }
    this.padAnyButton = any;

    // Menu starts a game, on the press rather than while it is held.
    const startNow = btn(9) || btn(8);
    if (startNow && !this._padStartWas) this.startPressed = true;
    this._padStartWas = startNow;

    this.padActive = x !== 0 || y !== 0 || this.padThrust > 0 || this.padLift !== 0 || any;
    if (this.padActive) this.padUsed = true;
  }

  // -- per-frame ------------------------------------------------------------

  sample() {
    // Keyboard steering eases towards the corner being held.
    const k = this.keys;
    const kx = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    const ky = (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0) - (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0);
    const RATE = 0.09;
    this.keyStick.x += (kx - this.keyStick.x) * RATE;
    this.keyStick.y += (ky - this.keyStick.y) * RATE;
    const keyActive = kx !== 0 || ky !== 0 || Math.hypot(this.keyStick.x, this.keyStick.y) > 0.01;

    this._pollPad();

    const tilt = this._tiltStick();
    // The rings fade in and out whether or not they are steering.
    this.leftThumb.tick(1 / 50);
    this.rightThumb.tick(1 / 50);
    // The thumbs win when they have been chosen, or when there is no tilt to
    // be had -- on a handset. A desktop has neither.
    this.touchSteers = this.steerMode === 'touch' || !tilt;
    const thumbs = this.touchUi && this.touchSteers;
    // Each thumb's two axes, deadzoned one at a time (see axisDead) and zero
    // when the thumb is not there.
    const L = this.leftThumb, Rt = this.rightThumb;
    const lx = L.active ? axisDead(L.x) : 0, ly = L.active ? axisDead(L.y) : 0;

    if (this.padOwns) {
      this.stick = this.padStick;
    } else if (thumbs) {
      // The lean from the right thumb, with the strafe from the left added
      // across it.
      let sx = (Rt.active ? Rt.x : 0) + Math.sign(lx) * expo(Math.abs(lx));
      let sy = Rt.active ? Rt.y : 0;
      const m = Math.hypot(sx, sy);
      if (m > 1) { sx /= m; sy /= m; }
      this.thumbStick.x = sx;
      this.thumbStick.y = sy;
      this.stick = this.thumbStick;
    } else if (tilt) {
      this.stick = tilt;
    } else if (keyActive) {
      this.stick = this.keyStick;
    } else {
      this.stick = this.mouseStick;
    }

    // Thrust, from whichever source is active, and how much of it.
    //
    // Most sources only say on or off, or hover or full. The height stick --
    // the pad's left stick, or the left thumb on the glass -- says how much,
    // around a middle that holds the height you are at.
    let thrust = this.mouseThrust;
    let throttle = 1;
    let hold = false;
    if (this.touchThrust) thrust = 2;
    // Under tilt, any finger is the engine.
    if (!thumbs && this.fingers > 0) thrust = 2;
    if (k.has('KeyZ') || k.has('Space')) thrust = 2;
    else if (k.has('KeyX')) thrust = thrust || 1;
    if (this.padThrust) thrust = this.padThrust;

    // The height stick, when one is in charge: -1 (all the way down) to 1.
    // Centred -- or let go of, which is the same thing -- holds the height.
    // Either side of that the travel runs through throttleCurve from its
    // middle, which is the power that carries the craft's weight: up to all
    // of it at the top, down to none at the bottom. So the stick is
    // continuous through the middle, and a little either side of it is a
    // gentle climb or a gentle sink. A pad button held wins.
    const lift = this.padOwns ? this.padLift
      : thumbs ? ly
      : null;
    if (lift !== null && !this.padThrust) {
      if (lift === 0) {
        hold = true;
      } else {
        const power = throttleCurve(0.5 + lift / 2);
        if (power > 0) { thrust = 2; throttle = power; }
      }
    }
    this.thrust = thrust;
    this.throttle = throttle;
    this.hold = hold;

    this.fire = this.mouseFire || this.touchFire || this.padFire
      || k.has('KeyC') || k.has('ShiftLeft');

    return this;
  }

  consumeStart() {
    const v = this.startPressed;
    this.startPressed = false;
    return v;
  }
}
