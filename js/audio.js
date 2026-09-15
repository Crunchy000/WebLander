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
    this.master.gain.value = 0.46;

    // Overlapping blasts used to sum past full scale and clip. A limiter
    // catches the peaks, which is what makes it safe to drive everything
    // harder without it turning to mush.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.22;

    this.master.connect(this.limiter).connect(ctx.destination);

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
    if (this.master) this.master.gain.value = m ? 0 : 0.46;
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

  // One detonation, sized by `scale`. Three layers, because a single noise
  // burst reads as a pop however loud it is: a sub-bass drop for the thump
  // you feel, a long filtered blast for the body of it, and quieter bursts
  // behind for debris coming back down.
  _boom(scale = 1) {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;

    // Sub-bass thump.
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(130 * (1 / scale), t);
    o.frequency.exponentialRampToValueAtTime(26, t + 0.5 * scale);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(1.7 * scale, t + 0.012);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.85 * scale);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.9 * scale);

    // A second, lower oscillator an octave down for weight.
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.setValueAtTime(64 * (1 / scale), t);
    o2.frequency.exponentialRampToValueAtTime(19, t + 0.6 * scale);
    const o2g = ctx.createGain();
    o2g.gain.setValueAtTime(0.0001, t);
    o2g.gain.exponentialRampToValueAtTime(1.2 * scale, t + 0.02);
    o2g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0 * scale);
    o2.connect(o2g).connect(this.master);
    o2.start(t);
    o2.stop(t + 1.05 * scale);

    // The blast itself.
    this._burst(1.1 * scale, 1800, 'lowpass', 1.9 * scale, 40);
    // Debris.
    setTimeout(() => this._burst(0.6 * scale, 2800, 'bandpass', 0.7 * scale, 260), 120);
    setTimeout(() => this._burst(0.5 * scale, 1000, 'lowpass', 0.5 * scale, 110), 300);
  }

  // A tank or a ship going up.
  bigBoom() { this._boom(1.25); }

  shot()      { this._burst(0.09, 2200, 'bandpass', 0.35, 600); }
  blast()     { this._boom(0.62); }
  explosion() { this._boom(0.95); }
  splash()    { this._burst(0.45, 3200, 'bandpass', 0.8, 700); }

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
  charge()    { this.tone(1100, 0.05, 'sine', 0.12); }

  // A tank's gun going off in the distance.
  tankGun()   { this._boom(0.34); }
  gameOver()  {
    [440, 370, 294, 220].forEach((f, i) => setTimeout(() => this.tone(f, 0.3, 'square', 0.2), i * 180));
  }
}
