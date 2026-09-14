// input.js -- mouse, keyboard, touch and tilt, all funnelled into one stick.
//
// The original flies from the absolute mouse position: the pointer's distance
// from the centre of its range sets how hard the craft leans, and its bearing
// sets which way. That is a position-based control scheme, not a rate-based
// one, which is exactly what a phone's tilt sensor gives you -- so tilt is not
// a compromise here, it is arguably the more natural fit of the two.

import { clamp } from './maths.js';

// Degrees of tilt for full stick deflection -- enough travel to be
// controllable without having to wave the handset around.
const TILT_RANGE = 22;

function loadFlag(key, dflt) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === '1';
  } catch { return dflt; }
}

function saveFlag(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* private mode */ }
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

    // Per-axis tilt inversion, remembered between sessions. Which way a
    // handset reports its tilt depends on the device and on how the screen
    // orientation angle is defined, so these are exposed rather than guessed.
    this.invertX = loadFlag('weblander.invertX', false);
    this.invertY = loadFlag('weblander.invertY', false);
    this.thrust = 0;      // 0 none, 1 hover, 2 full
    this.fire = false;
    this.startPressed = false;

    // Keyboard steering integrates towards a target rather than snapping.
    this.keys = new Set();
    this.keyStick = { x: 0, y: 0 };

    this.hasTouch = matchMedia('(pointer: coarse)').matches && (navigator.maxTouchPoints || 0) > 0;
    this.tiltEnabled = false;
    this.tiltZero = null;         // neutral orientation, set on start
    this.tiltRaw = null;

    this._bindKeyboard();
    this._bindMouse();
    this._bindTouch();
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

    c.addEventListener('mousemove', (e) => {
      if (this.hasTouch && this.tiltEnabled) return;
      const r = c.getBoundingClientRect();
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

    addEventListener('deviceorientation', (e) => {
      if (e.beta === null && e.gamma === null) return;
      this.tiltRaw = { beta: e.beta || 0, gamma: e.gamma || 0 };
      if (!this.tiltZero) this.calibrateTilt();
      this.tiltEnabled = true;
    });

    return true;
  }

  // Take the current orientation as "stick centred", so the game is playable
  // however the player happens to be holding the phone.
  calibrateTilt() {
    if (this.tiltRaw) this.tiltZero = { ...this.tiltRaw };
  }

  // How far the picture is turned from the handset's natural orientation.
  screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
    return window.orientation || 0;   // older iOS
  }

  _tiltStick() {
    if (!this.tiltEnabled || !this.tiltRaw || !this.tiltZero) return null;

    // Wrap, so crossing +/-180 does not send the craft flying.
    const wrap = (d) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);
    const dBeta = wrap(this.tiltRaw.beta - this.tiltZero.beta);
    const dGamma = wrap(this.tiltRaw.gamma - this.tiltZero.gamma);

    // Tilt in the handset's own frame, in its natural orientation:
    //   right -- the right-hand edge dipping down       (+gamma)
    //   away  -- the top edge tipping away from you     (-beta)
    const right = dGamma;
    const away = -dBeta;

    // Turn that into screen space. The sensor reports in the handset's frame
    // regardless of which way up the picture is, so playing in landscape
    // swaps the two axes unless they are rotated to match -- which is why
    // left/right and forwards/backwards can end up wired to each other.
    const rad = (this.screenAngle() * Math.PI) / 180;
    const c = Math.cos(rad), sn = Math.sin(rad);
    let sx = (right * c + away * sn) / TILT_RANGE;
    let sy = (-right * sn + away * c) / TILT_RANGE;

    // User overrides last, in screen space, so flipping one axis can never
    // disturb the other.
    if (this.invertX) sx = -sx;
    if (this.invertY) sy = -sy;

    this.tiltDebug = {
      beta: Math.round(dBeta), gamma: Math.round(dGamma),
      x: +sx.toFixed(2), y: +sy.toFixed(2), angle: this.screenAngle(),
    };

    return { x: clamp(sx, -1, 1), y: clamp(sy, -1, 1) };
  }

  setInvert(axis, on) {
    if (axis === 'x') this.invertX = on; else this.invertY = on;
    saveFlag('weblander.invert' + axis.toUpperCase(), on);
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

    const tilt = this._tiltStick();

    if (tilt) {
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
    this.thrust = thrust;

    this.fire = this.mouseFire || this.touchFire || k.has('KeyC') || k.has('ShiftLeft');

    return this;
  }

  consumeStart() {
    const v = this.startPressed;
    this.startPressed = false;
    return v;
  }
}
