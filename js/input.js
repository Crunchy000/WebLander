// input.js -- mouse, keyboard, touch and tilt, all funnelled into one stick.
//
// The original flies from the absolute mouse position: the pointer's distance
// from the centre of its range sets how hard the craft leans, and its bearing
// sets which way. That is a position-based control scheme, not a rate-based
// one, which is exactly what a phone's tilt sensor gives you -- so tilt is not
// a compromise here, it is arguably the more natural fit of the two.

import { clamp } from './maths.js';

export class Input {
  constructor(canvas) {
    this.canvas = canvas;

    // The virtual stick, each axis in [-1, 1].
    this.stick = { x: 0, y: 0 };
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
        y: clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1),
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
  // on flying. Without a motion sensor we fall back to dragging to steer, and
  // the on-screen thrust pad earns its place again.
  _canvasTouch(e) {
    e.preventDefault();
    const touching = e.touches.length > 0;

    if (this.tiltEnabled) {
      this.tapThrust = touching;
      this.dragStick = null;
      return;
    }

    if (!touching) { this.dragStick = null; return; }
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

  _tiltStick() {
    if (!this.tiltEnabled || !this.tiltRaw || !this.tiltZero) return null;

    let dBeta = this.tiltRaw.beta - this.tiltZero.beta;    // front-back lean
    let dGamma = this.tiltRaw.gamma - this.tiltZero.gamma; // left-right lean

    // Wrap, so crossing +/-180 does not send the craft flying.
    if (dBeta > 180) dBeta -= 360; else if (dBeta < -180) dBeta += 360;
    if (dGamma > 180) dGamma -= 360; else if (dGamma < -180) dGamma += 360;

    // About 22 degrees of lean gives full deflection -- enough travel to be
    // controllable without having to wave the phone around.
    const RANGE = 22;
    const orient = (screen.orientation && screen.orientation.angle) || 0;

    let sx = dGamma / RANGE;
    // Inverted: tipping the far edge of the handset down flies away from you,
    // which is the way round that matches what you see on screen.
    let sy = -dBeta / RANGE;

    // Compensate for the device being held sideways.
    if (orient === 90) { const t = sx; sx = sy; sy = -t; }
    else if (orient === 270 || orient === -90) { const t = sx; sx = -sy; sy = t; }
    else if (orient === 180) { sx = -sx; sy = -sy; }

    return { x: clamp(sx, -1, 1), y: clamp(sy, -1, 1) };
  }

  // -- per-frame ------------------------------------------------------------

  sample() {
    // Keyboard steering eases towards the corner being held.
    const k = this.keys;
    const kx = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    const ky = (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0) - (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0);
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
