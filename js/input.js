// input.js -- mouse, keyboard, touch and tilt, all funnelled into one stick.
//
// The original flies from the absolute mouse position: the pointer's distance
// from the centre of its range sets how hard the craft leans, and its bearing
// sets which way. That is a position-based control scheme, not a rate-based
// one, which is exactly what a phone's tilt sensor gives you -- so tilt is not
// a compromise here, it is arguably the more natural fit of the two.

import { clamp } from './maths.js';
import { TiltSteering } from './tilt.js';
import { TouchStick, throttleCurve } from './stick.js';
import { SCREEN_W, SCREEN_H } from './renderer.js';

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
    this.touchStick = new TouchStick();
    // How much power is being asked for, 0 to 1. Whatever is steering, some
    // sources say only yes or no and some say how much; this is how much, and
    // it is 1 for the ones that only say yes.
    this.throttle = 1;
    this.steerMode = 'touch';
    this.thrust = 0;      // 0 none, 1 hover, 2 full
    this.fire = false;
    this.startPressed = false;

    // Keyboard steering integrates towards a target rather than snapping.
    this.keys = new Set();
    this.keyStick = { x: 0, y: 0 };

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
    this.padThrottle = 0;
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

    // Steering reads the pointer's position, not its movement, so the cursor
    // leaving the canvas or the window losing focus used to strand the stick
    // wherever it was last seen. Pointer lock fixes that at the source: the
    // cursor cannot leave, because there is no longer a cursor.
    //
    // Locked, the browser reports movement rather than position, so the
    // position is kept here instead and the same mapping applied to it. The
    // gain is deliberately identical -- a movement of half the canvas width
    // still means half deflection -- so locking changes nothing about how it
    // flies, only that it cannot be lost.
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === c;
    });
    document.addEventListener('pointerlockerror', () => { this.locked = false; });

    c.addEventListener('mousemove', (e) => {
      if (this.touchUi && this.tiltEnabled) return;
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height) return;

      if (this.locked) {
        this.mouseStick = {
          x: clamp(this.mouseStick.x + (e.movementX / (r.width / 2)), -1, 1),
          y: clamp(this.mouseStick.y - (e.movementY / (r.height / 2)), -1, 1),
        };
        return;
      }

      // Map the pointer's position within the canvas onto the stick, the same
      // way the original maps the mouse's 0-1023 range onto -512..+511.
      this.mouseStick = {
        x: clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1),
        // Negated: screen y grows downwards, but moving the pointer up the
        // screen, towards the horizon, has to fly away from the viewer.
        y: clamp(1 - ((e.clientY - r.top) / r.height) * 2, -1, 1),
      };
    });

    c.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // Any click takes the pointer back, so wandering out of the window or
      // pressing Escape costs one click rather than the rest of the flight.
      this.grabPointer();
      if (e.button === 0) this.mouseThrust = 2;
      else if (e.button === 1) this.mouseThrust = 1;
      else if (e.button === 2) this.mouseFire = true;
    });

    const clear = (e) => {
      if (e.button === 0 || e.button === 1) this.mouseThrust = 0;
      else if (e.button === 2) this.mouseFire = false;
    };
    addEventListener('mouseup', clear);
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    this.mouseStick = { x: 0, y: 0 };
    this.mouseThrust = 0;
    this.mouseFire = false;
    this.locked = false;
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
  // Steering by stick, the first finger is the stick and nothing else, and a
  // second finger, anywhere, is full power for as long as it stays down.
  // Steering by tilt, the handset is the stick, so there is nothing for a
  // finger to steer: any finger on the glass is full power, and no ring is
  // drawn under it.
  //
  // There used to be more. A throttle under the right thumb -- a relative
  // slider with a hold-height mark half way up -- which had to be found,
  // grabbed and remembered; and then one finger meaning hover. Both went:
  // on glass the power is on or off.
  //
  // The stick is fed whatever the mode, so switching between tilt and touch
  // mid-flight does not need it warming up first.
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

    for (const t of e.changedTouches) {
      const [bx, by] = toBuffer(t);
      // The first finger gets the stick; any others only count.
      if (e.type === 'touchstart') this.touchStick.down(t.identifier, bx, by);
      else if (e.type === 'touchmove') this.touchStick.move(t.identifier, bx, by);
      else this.touchStick.up(t.identifier);
    }
    // A finger lifted elsewhere can leave the stick owned by one that is no
    // longer down, so the owner is checked against the live list as well.
    const s = this.touchStick;
    if (s.active) {
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
      this.padThrottle = 0;
      this.padFire = false;
      return;
    }

    const btn = (i) => (pad.buttons[i] ? pad.buttons[i].value > 0.25 || pad.buttons[i].pressed : false);
    const axis = (i) => (pad.axes.length > i ? pad.axes[i] : 0);

    // Left stick, or the d-pad if that is what they are using. Screen y runs
    // down and the stick reports up as negative, so the sign flips to meet the
    // one convention every input here has to produce: y > 0 leans away.
    let x = axis(0), y = -axis(1);
    if (btn(14)) x = -1; else if (btn(15)) x = 1;
    if (btn(12)) y = 1; else if (btn(13)) y = -1;

    // Deadzone on the magnitude, not per axis. Squaring it off would make the
    // corners reachable and the cardinals sticky, which is the same mistake
    // the tilt mapper made and the same fix.
    const DEAD = 0.16;
    let m = Math.hypot(x, y);
    if (m < DEAD) {
      x = y = 0;
    } else {
      // Rescale so the stick still reaches full deflection after the deadzone
      // is taken out of the bottom of its travel.
      const k = Math.min(1, (m - DEAD) / (0.95 - DEAD)) / m;
      x *= k; y *= k;
      m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
    }
    this.padStick.x = x;
    this.padStick.y = y;

    // Right trigger or A for full power, left trigger or X to hover.
    this.padThrust = (btn(7) || btn(0)) ? 2 : (btn(6) || btn(2)) ? 1 : 0;

    // ... and the right-hand stick is the throttle. It is the one control on
    // the pad that can ask for part of the power rather than all of it, which
    // is what makes a gentle descent something you fly rather than something
    // you feather with a trigger. The buttons still work alongside it.
    //
    // Pushed down it reverses: the same rotors driven the other way, pushing
    // along the floor instead of the roof. Fixed props could not, reversible
    // ones can, and this machine has them.
    //
    // It is worth having for the same reason the lean goes past ninety.
    // Thrust acts along the craft's own axis wherever that axis is pointing,
    // so reverse is not simply "down": upright it drives you at the ground,
    // inverted it climbs, and banked over it pulls you back the way you came
    // without turning the machine round -- which is a brake you can use while
    // still looking where you were going.
    //
    // The deadzone is the same either way, so a thumb resting on the stick
    // flies nothing at all.
    // Up is laid out around the one landmark it has -- half way up holds
    // your height; see throttleCurve in stick.js. Down is straight: reverse has no
    // landmark in it to lay anything out around, and pushing the stick down
    // is a deliberate act rather than something you trim.
    const THROTTLE_DEAD = 0.12;
    const v = -axis(3);
    const av = Math.abs(v);
    const amount = av > THROTTLE_DEAD
      ? Math.min(1, (av - THROTTLE_DEAD) / (0.95 - THROTTLE_DEAD))
      : 0;
    this.padThrottle = amount === 0 ? 0 : (v < 0 ? -amount : throttleCurve(amount));
    this.padFire = btn(5) || btn(1) || btn(4);

    let any = false;
    for (const b of pad.buttons) if (b && (b.pressed || b.value > 0.5)) { any = true; break; }
    this.padAnyButton = any;

    // Menu starts a game, on the press rather than while it is held.
    const startNow = btn(9) || btn(8);
    if (startNow && !this._padStartWas) this.startPressed = true;
    this._padStartWas = startNow;

    this.padActive = x !== 0 || y !== 0 || this.padThrust > 0 || this.padThrottle !== 0 || any;
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
    this.touchStick.tick(1 / 50);
    // Touch wins when it has been chosen, or when there is no tilt to be had.
    this.touchSteers = this.steerMode === 'touch' || !tilt;
    const touch = this.touchSteers ? this.touchStick.stick : null;

    if (this.padOwns) {
      this.stick = this.padStick;
    } else if (touch) {
      this.stick = touch;
    } else if (tilt) {
      this.stick = tilt;
    } else if (keyActive) {
      this.stick = this.keyStick;
    } else {
      this.stick = this.mouseStick;
    }

    // Thrust, from whichever source is active, and how much of it.
    //
    // Most sources only say on or off, or hover or full. One says how much:
    // the right-hand stick on a pad, which can also ask for it the other way
    // round, and owns the power while it is being used.
    let thrust = this.mouseThrust;
    let throttle = 1;
    if (this.touchThrust) thrust = 2;
    // Under the stick it takes a second finger; under tilt, any finger.
    if (this.fingers >= (this.touchSteers ? 2 : 1)) thrust = 2;
    if (k.has('KeyZ') || k.has('Space')) thrust = 2;
    else if (k.has('KeyX')) thrust = thrust || 1;
    if (this.padThrust) thrust = this.padThrust;

    if (this.padThrottle !== 0) {
      // Negative is reverse: still full-power mode, still the rotors, just
      // turning the other way. The player decides how much and which way;
      // what that does to the craft depends on where its roof is pointing.
      throttle = this.padThrottle;
      thrust = 2;
    }
    this.thrust = thrust;
    this.throttle = throttle;

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
