// input.js -- mouse, keyboard, touch and tilt, all funnelled into one stick.
//
// The original flies from the absolute mouse position: the pointer's distance
// from the centre of its range sets how hard the craft leans, and its bearing
// sets which way. That is a position-based control scheme, not a rate-based
// one, which is exactly what a phone's tilt sensor gives you -- so tilt is not
// a compromise here, it is arguably the more natural fit of the two.

import { clamp } from './maths.js';
import { TiltMapper } from './tilt.js';

// Degrees of tilt for full stick deflection, used only by the rough fallback
// mapping below. Once the player has calibrated, their own demonstrated throw
// sets this instead.
const TILT_RANGE = 22;

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

    // Tilt mapping. If the player has calibrated, this holds the basis
    // measured from the directions they demonstrated; otherwise steering
    // falls back to a derived guess, which is right on some handsets and
    // wrong on others -- hence the calibration.
    this.tilt = new TiltMapper();
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
    this.tiltZero = null;         // neutral orientation, set on start
    this.tiltRaw = null;

    // Gamepad. Nothing to bind: the API is polled, not evented, so the whole
    // of it lives in _pollPad below.
    this.padStick = { x: 0, y: 0 };
    this.padActive = false;
    this.padThrust = 0;
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

    this.dragStick = null;
    this.tapThrust = false;

    for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      this.canvas.addEventListener(ev, (e) => this._canvasTouch(e), { passive: false });
    }
  }

  // With tilt steering the screen is free for anything else, so touching it
  // anywhere fires the engine -- no need to find a button while concentrating
  // on flying -- and a second finger down works the gun. Without a motion
  // sensor we fall back to dragging to steer, and the thrust pad earns its
  // place again.
  _canvasTouch(e) {
    e.preventDefault();
    const n = e.touches.length;

    if (this.tiltEnabled) {
      this.tapThrust = n >= 1;
      this.touchFire = n >= 2;
      this.dragStick = null;
      return;
    }

    if (n === 0) { this.dragStick = null; return; }
    this.touchFire = n >= 2;
    const t = e.touches[0];
    const r = this.canvas.getBoundingClientRect();
    this.dragStick = {
      x: clamp(((t.clientX - r.left) / r.width) * 2 - 1, -1, 1),
      y: clamp(((t.clientY - r.top) / r.height) * 2 - 1, -1, 1),
    };
  }

  // -- tilt -----------------------------------------------------------------

  // Must be called from a user gesture on iOS, which gates motion data behind
  // an explicit permission prompt.
  async enableTilt() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return false;

    if (typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') return false;
      } catch {
        return false;
      }
    }

    // The constructor existing proves nothing. Edge on a console has
    // DeviceOrientationEvent and no sensor whatsoever, and returning true on
    // that basis is what put a tilt calibration screen on a television. Only
    // an actual reading counts as a sensor.
    //
    // The listener stays attached either way: a handset that is slow to
    // report still gets tilt once it starts, it just will not have been
    // waited for.
    return await new Promise((resolve) => {
      let settled = false;
      const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };

      addEventListener('deviceorientation', (e) => {
        if (e.beta === null && e.gamma === null) return;
        this.tiltRaw = { beta: e.beta || 0, gamma: e.gamma || 0 };
        if (!this.tiltZero) this.calibrateTilt();
        this.tiltEnabled = true;
        settle(true);
      });

      // Long enough for a real sensor to speak up, short enough not to be a
      // pause on the way into the game.
      setTimeout(() => settle(false), 350);
    });
  }

  // Take the current orientation as "stick centred", so the game is playable
  // however the player happens to be holding the phone.
  // Re-centre on the current hold. Leaves a completed calibration alone: its
  // neutral was captured as part of the basis and must stay consistent with
  // it, or the mapping shears.
  calibrateTilt() {
    if (!this.tiltRaw) return;
    this.tiltZero = { ...this.tiltRaw };
    if (!this.tilt.calibrated) this.tilt.setZero(this.tiltRaw);
  }

  // How far the picture is turned from the handset's natural orientation.
  screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
    return window.orientation || 0;   // older iOS
  }

  _tiltStick() {
    if (!this.tiltEnabled || !this.tiltRaw) return null;

    // Calibrated: solve against the basis the player demonstrated. This is
    // the path that actually works across devices.
    const mapped = this.tilt.map(this.tiltRaw);
    if (mapped) {
      this.tiltDebug = {
        beta: Math.round(this.tiltRaw.beta), gamma: Math.round(this.tiltRaw.gamma),
        x: +mapped.x.toFixed(2), y: +mapped.y.toFixed(2), mode: 'calibrated',
      };
      return mapped;
    }

    // Uncalibrated fallback: assume the common convention and rotate by the
    // screen angle. Good enough to fly with until calibration is done.
    if (!this.tiltZero) return null;

    const wrap = (d) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);
    const dBeta = wrap(this.tiltRaw.beta - this.tiltZero.beta);
    const dGamma = wrap(this.tiltRaw.gamma - this.tiltZero.gamma);

    const right = dGamma;
    const away = -dBeta;

    const rad = (this.screenAngle() * Math.PI) / 180;
    const c = Math.cos(rad), sn = Math.sin(rad);
    let sx = (right * c + away * sn) / TILT_RANGE;
    let sy = (-right * sn + away * c) / TILT_RANGE;

    // Clamp the length rather than each axis, so leaning hard keeps its
    // bearing instead of snapping to the nearest diagonal.
    const len = Math.hypot(sx, sy);
    if (len > 1) { sx /= len; sy /= len; }

    this.tiltDebug = {
      beta: Math.round(dBeta), gamma: Math.round(dGamma),
      x: +sx.toFixed(2), y: +sy.toFixed(2), mode: 'uncalibrated',
    };

    return { x: sx, y: sy };
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
    // The right trigger drops as well as thrusts. It is the finger already
    // doing the work on a bombing run -- you are holding power to get over
    // the target anyway -- and the bay reloads on its own timer, so holding
    // it down cannot dump the whole load at once.
    this.padFire = btn(5) || btn(1) || btn(4) || btn(7);

    let any = false;
    for (const b of pad.buttons) if (b && (b.pressed || b.value > 0.5)) { any = true; break; }
    this.padAnyButton = any;

    // Menu starts a game, on the press rather than while it is held.
    const startNow = btn(9) || btn(8);
    if (startNow && !this._padStartWas) this.startPressed = true;
    this._padStartWas = startNow;

    this.padActive = x !== 0 || y !== 0 || this.padThrust > 0 || any;
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

    if (this.padOwns) {
      this.stick = this.padStick;
    } else if (tilt) {
      this.stick = tilt;
    } else if (this.dragStick) {
      this.stick = this.dragStick;
    } else if (keyActive) {
      this.stick = this.keyStick;
    } else {
      this.stick = this.mouseStick;
    }

    // Thrust and fire, from whichever source is active.
    let thrust = this.mouseThrust;
    if (this.touchThrust || this.tapThrust) thrust = 2;
    if (k.has('KeyZ') || k.has('Space')) thrust = 2;
    else if (k.has('KeyX')) thrust = thrust || 1;
    if (this.padThrust) thrust = this.padThrust;
    this.thrust = thrust;

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
