// audio.js -- synthesised sound effects, no assets to load.
//
// Everything is generated with oscillators and a shared noise buffer, so the
// whole game stays a handful of text files. The engine is a continuous voice
// whose gain and filter track the throttle; everything else is one-shot.

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.muted = false;
  }

  // Browsers require a user gesture before audio will start.
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.32;
    this.master.connect(ctx.destination);

    // A second of white noise, reused by every percussive effect.
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // The engine: a sawtooth roar plus noise, through a low-pass filter.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 400;
    this.engineFilter.Q.value = 3;

    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 58;

    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noise;
    rumble.loop = true;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.55;

    this.engineOsc.connect(this.engineFilter);
    rumble.connect(rumbleGain).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);

    this.engineOsc.start();
    rumble.start();

    this.enabled = true;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.32;
  }

  // Follow the throttle: 0 off, 1 hover, 2 full.
  engine(level) {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const target = level === 2 ? 0.5 : level === 1 ? 0.27 : 0;
    this.engineGain.gain.setTargetAtTime(target, t, 0.04);
    this.engineFilter.frequency.setTargetAtTime(
      level === 2 ? 900 : level === 1 ? 520 : 300, t, 0.06);
  }

  _burst(dur, freq, type, gain, sweepTo) {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur);
  }

  // A tank going up: three layers, because a single noise burst reads as a
  // pop rather than a detonation. A low sine drop supplies the thump you feel,
  // a long filtered noise burst is the blast itself, and a second, quieter
  // burst a moment later is the debris coming back down.
  bigBoom() {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;

    // Thump: a low tone dropping fast.
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.45);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.95, t + 0.015);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.75);

    // Blast: broad noise, opening then closing.
    this._burst(0.9, 1400, 'lowpass', 1.0, 45);

    // Debris, a beat later and quieter.
    setTimeout(() => this._burst(0.55, 2600, 'bandpass', 0.30, 300), 130);
    setTimeout(() => this._burst(0.40, 900, 'lowpass', 0.22, 120), 300);
  }

  shot()      { this._burst(0.09, 2200, 'bandpass', 0.35, 600); }
  blast()     { this._burst(0.30, 900, 'lowpass', 0.55, 120); }
  explosion() { this._burst(0.75, 700, 'lowpass', 0.9, 60); }
  splash()    { this._burst(0.25, 3000, 'bandpass', 0.4, 900); }

  tone(freq, dur = 0.12, type = 'square', gain = 0.22) {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur);
  }

  touchdown() { this.tone(520, 0.14); setTimeout(() => this.tone(780, 0.2), 120); }
  refuel()    { this.tone(1100, 0.05, 'sine', 0.12); }
  gameOver()  {
    [440, 370, 294, 220].forEach((f, i) => setTimeout(() => this.tone(f, 0.3, 'square', 0.2), i * 180));
  }
}
