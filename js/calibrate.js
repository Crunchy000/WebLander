// calibrate.js -- the interactive tilt calibration.
//
// Three steps: set the neutral hold, then demonstrate "away from me" and "to
// my right". The two demonstrated tilts become the basis the mapper solves
// against, so the result is measured rather than guessed at.
//
// The demonstration steps capture themselves once a tilt is held still for
// about half a second. Asking the player to tap while holding the phone at an
// angle would mean looking away from the screen at the moment it matters, and
// fumbling the tap would spoil the reading.

import { TiltMapper, SteadyHold, delta, magnitude } from './tilt.js';

const STEPS = [
  {
    key: 'zero',
    title: 'hold it still',
    body: 'Hold the phone however you want to fly — however is comfortable.',
    hint: 'This becomes the centre position.',
    manual: true,
    button: 'set centre',
  },
  {
    key: 'away',
    title: 'tilt away',
    body: 'Now tip it as if flying <b>away</b> from you, towards the horizon.',
    hint: 'Hold it there — it captures itself.',
  },
  {
    key: 'right',
    title: 'tilt right',
    body: 'Now tip it as if flying to your <b>right</b>.',
    hint: 'Hold it there — it captures itself.',
  },
];

export class Calibration {
  constructor(input, mapper) {
    this.input = input;
    this.mapper = mapper;
    this.el = document.getElementById('calibrate');
    this.titleEl = document.getElementById('cal-title');
    this.bodyEl = document.getElementById('cal-body');
    this.hintEl = document.getElementById('cal-hint');
    this.barEl = document.getElementById('cal-bar');
    this.btnEl = document.getElementById('cal-btn');
    this.skipEl = document.getElementById('cal-skip');
    this.padEl = document.getElementById('cal-pad');
    this.dotEl = document.getElementById('cal-dot');
    this.errEl = document.getElementById('cal-err');

    this.hold = new SteadyHold();
    this.onFinish = null;
    this.running = false;

    this.btnEl.addEventListener('click', () => this.onButton());
    this.skipEl.addEventListener('click', () => this.finish(false));
  }

  start(onFinish) {
    this.onFinish = onFinish;
    this.running = true;
    this.stepIndex = 0;
    this.captured = {};
    this.previewing = false;
    this.el.hidden = false;
    this.errEl.textContent = '';
    this.renderStep();
    this.tick();
  }

  get step() {
    return STEPS[this.stepIndex] || null;
  }

  // The button means different things at different points, so it has exactly
  // one handler and that handler decides.
  onButton() {
    if (this.previewing) { this.finish(true); return; }
    if (this.step && this.step.manual) this.advance();
  }

  renderStep() {
    const s = this.step;
    if (!s) return;
    this.titleEl.textContent = s.title;
    this.bodyEl.innerHTML = s.body;
    this.hintEl.textContent = s.hint;
    this.btnEl.hidden = !s.manual;
    this.btnEl.textContent = s.button || '';
    this.padEl.hidden = true;
    this.setProgress(0);
    this.hold.reset();
  }

  setProgress(p) {
    this.barEl.style.width = Math.round(p * 100) + '%';
    const s = this.step;
    this.barEl.parentElement.hidden = this.previewing || !s || s.manual;
  }

  // Manual advance, used only for the neutral step.
  advance() {
    if (this.previewing || !this.step || !this.step.manual) return;

    if (this.step.key === 'zero') {
      const raw = this.input.tiltRaw;
      if (!raw) {
        this.errEl.textContent = 'No motion readings yet — move the phone slightly.';
        return;
      }
      this.mapper.setZero(raw);
      this.captured.zero = { ...raw };
    }

    this.errEl.textContent = '';
    this.stepIndex++;
    this.renderStep();
  }

  capture(d) {
    this.captured[this.step.key] = d;

    if (this.step.key === 'away') {
      // Say so, then move on by itself once they recentre.
      this.errEl.textContent = '';
      this.stepIndex++;
      this.renderStep();
      return;
    }

    if (this.step.key === 'right') {
      const err = this.mapper.build(this.captured.away, this.captured.right);
      if (err) {
        // Send them back to the "away" step rather than losing everything.
        this.errEl.textContent = err;
        this.stepIndex = STEPS.findIndex((st) => st.key === 'away');
        this.renderStep();
        return;
      }
      this.mapper.save();
      this.showPreview();
      return;
    }

    this.stepIndex++;
    this.renderStep();
  }

  showPreview() {
    this.previewing = true;
    this.titleEl.textContent = 'try it';
    this.bodyEl.innerHTML = 'Tilt the phone — the dot should follow.';
    this.hintEl.textContent = 'Up is away from you, right is right.';
    this.btnEl.hidden = false;
    this.btnEl.textContent = 'looks right';
    this.padEl.hidden = false;
    this.barEl.parentElement.hidden = true;
    this.errEl.textContent = '';
  }

  finish(ok) {
    this.running = false;
    this.previewing = false;
    this.el.hidden = true;
    if (this.onFinish) this.onFinish(ok);
  }

  tick() {
    if (!this.running) return;
    requestAnimationFrame(() => this.tick());

    const raw = this.input.tiltRaw;
    if (!raw) return;

    if (this.previewing) {
      const s = this.mapper.map(raw);
      if (s) {
        // The pad is 120px across; keep the dot inside it.
        this.dotEl.style.transform =
          `translate(${(s.x * 46).toFixed(1)}px, ${(-s.y * 46).toFixed(1)}px)`;
      }
      return;
    }

    if (!this.step || this.step.manual || !this.mapper.zero) return;

    const d = delta(raw, this.mapper.zero);
    const { progress, captured, needsCentre } = this.hold.push(d);
    this.setProgress(progress);

    if (needsCentre) {
      this.hintEl.textContent = 'Good — now level the phone…';
    } else {
      this.hintEl.textContent = magnitude(d) < 9
        ? 'Tip it a little further…'
        : 'Hold it there…';
    }

    if (captured) this.capture(captured);
  }
}
