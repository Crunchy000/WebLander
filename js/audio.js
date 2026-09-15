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
  // `injected` lets a test render the same graph through an OfflineAudioContext
  // and measure what comes out, rather than taking the synthesis on trust.
  start(injected) {
    if (this.ctx && !injected) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC && !injected) return;

    const ctx = injected || new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.46;

    // Overlapping blasts used to sum past full scale and clip. A limiter
    // catches the peaks, which is what makes it safe to drive everything
    // harder without it turning to mush.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 6;
    this.limiter.attack.value = 0.010;   // slow enough to let the crack past
    this.limiter.release.value = 0.30;

    this.master.connect(this.limiter).connect(ctx.destination);

    // Three seconds of white noise, reused by every percussive effect. It is
    // long so that each burst can start at a random offset -- playing the same
    // samples every time makes repeated explosions sound cloned.
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Explosions run through a saturator. Real ones are loud enough to
    // distort, and tanh clipping adds both the grit and the perceived
    // loudness that a clean sine drop never has.
    this.boomBus = ctx.createGain();
    this.boomBus.gain.value = 1;
    this.shaper = ctx.createWaveShaper();
    const N = 2048, curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i * 2) / N - 1;
      curve[i] = Math.tanh(x * 2.4) / Math.tanh(2.4);
    }
    this.shaper.curve = curve;
    this.shaper.oversample = '2x';
    this.boomBus.connect(this.shaper).connect(this.master);

    // The transient bypasses the saturator. Sending it through tanh along
    // with the sub-bass rounds off the very edge that makes a boom read as a
    // crack rather than a thud.
    this.crackBus = ctx.createGain();
    this.crackBus.gain.value = 1;
    this.crackBus.connect(this.master);

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

  // Noise through a swept filter, from a random point in the bed.
  _noise({ dur, type = 'lowpass', f0, f1, gain, q = 1, dest, delay = 0 }) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;

    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);   // near-instant
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(f).connect(g).connect(dest || this.boomBus);
    src.start(t, Math.random() * 2);       // random offset into the bed
    src.stop(t + dur + 0.05);
  }

  // One detonation, sized by `scale`.
  //
  // The staging is what matters, and getting it wrong is what made earlier
  // attempts sound like a thud: an explosion opens with a bright broadband
  // CRACK, which is the part the ear reads as "explosion". Under that sits
  // the body, then a sub-bass thump you feel more than hear, and behind it
  // all a long dark rumble that supplies the sense of size. Leave out the
  // crack and no amount of low end will save it.
  _boom(scale = 1) {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const S = scale;

    // 1. Crack: very short, very bright, instant -- and routed clear of the
    // saturator so its edge survives.
    this._noise({ dur: 0.050 * S, type: 'highpass', f0: 1600, f1: 4200,
                  gain: 2.2 * S, q: 0.7, dest: this.crackBus });
    this._noise({ dur: 0.10 * S, type: 'bandpass', f0: 2600, f1: 900,
                  gain: 1.5 * S, q: 0.8, dest: this.crackBus });

    // 2. Body: the mid weight, decaying fast.
    this._noise({ dur: 0.42 * S, type: 'lowpass', f0: 1100, f1: 160,
                  gain: 1.7 * S, q: 1.2 });

    // 3. Sub thump: pitch dropping away under everything.
    for (const [type, f, fEnd, g, d] of [
      ['sine', 120, 24, 1.35 * S, 0.55 * S],
      ['triangle', 58, 17, 0.95 * S, 0.75 * S],
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(fEnd, t + d);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(g, t + 0.010);
      og.gain.exponentialRampToValueAtTime(0.0001, t + d * 1.4);
      o.connect(og).connect(this.boomBus);
      o.start(t);
      o.stop(t + d * 1.5);
    }

    // 4. Rumble: long, dark, and quiet enough to sit underneath. This is
    // what makes it sound big rather than merely loud.
    this._noise({ dur: 1.9 * S, type: 'lowpass', f0: 320, f1: 60,
                  gain: 0.85 * S, q: 0.6, delay: 0.04 });
    this._noise({ dur: 2.6 * S, type: 'lowpass', f0: 150, f1: 38,
                  gain: 0.55 * S, q: 0.5, delay: 0.14 });

    // 5. Debris, scattered behind it.
    this._noise({ dur: 0.7 * S, type: 'bandpass', f0: 2200, f1: 400,
                  gain: 0.45 * S, q: 1.4, delay: 0.13 });
  }

  // A tank or a ship going up.
  bigBoom() { this._boom(1.25); }

  // A secondary going off in a burning wreck -- ammunition cooking, a tank
  // letting go. Smaller than the hit that caused it, and deliberately varied
  // in size so a string of them does not sound like a metronome.
  secondary() { this._boom(0.42 + Math.random() * 0.34); }

  // A single bubble. The pitch RISES as it collapses -- that upward chirp is
  // what the ear hears as "bubble"; a falling tone sounds like a drip
  // instead. Short, resonant, and almost pure tone.
  _glug({ at = 0, f = 220, gain = 0.5, dur = 0.09 }) {
    const ctx = this.ctx, t = ctx.currentTime + at;

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * (1.7 + Math.random() * 0.8), t + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    o.connect(g).connect(this.boomBus);
    o.start(t);
    o.stop(t + dur + 0.02);

    // A tick of noise on the break, so it is not a bare sine.
    this._noise({ dur: 0.035, type: 'bandpass', f0: f * 5, f1: f * 2.5,
                  gain: gain * 0.5, q: 3, delay: at });
  }

  // Water. Nothing shocks the air, so there is no crack: an impact, the dull
  // weight of displaced water, and then a string of glugs as the air goes
  // down with it. The glugging is what makes it sound like a hull filling
  // rather than a wave breaking.
  _splash(scale = 1) {
    if (!this.enabled) return;
    const S = scale;

    // 1. Impact: broad, rounded, no edge.
    this._noise({ dur: 0.15 * S, type: 'bandpass', f0: 1300, f1: 340,
                  gain: 1.3 * S, q: 0.7, dest: this.crackBus });

    // 2. Displacement: the body of water shoved aside.
    this._noise({ dur: 0.50 * S, type: 'lowpass', f0: 620, f1: 120,
                  gain: 1.25 * S, q: 1.1 });

    // 3. Glugs: irregularly spaced and falling in pitch across the run, as
    // the air pocket empties and the remaining bubbles get bigger.
    const n = Math.round(4 + 5 * S);
    let at = 0.10;
    for (let i = 0; i < n; i++) {
      const through = i / Math.max(1, n - 1);
      this._glug({
        at,
        f: (300 - 150 * through) * (0.85 + Math.random() * 0.3),
        gain: (0.75 - 0.3 * through) * S,
        dur: (0.07 + 0.05 * through) * S,
      });
      at += (0.075 + Math.random() * 0.13) * S;
    }

    // 4. A thin wash of small bubbles underneath the glugs.
    this._noise({ dur: 1.1 * S, type: 'bandpass', f0: 2200, f1: 900,
                  gain: 0.22 * S, q: 2.5, delay: 0.08 });
  }

  // A ship going under.
  bigSplash() { this._splash(1.3); }

  shot()      { this._burst(0.09, 2200, 'bandpass', 0.35, 600); }
  blast()     { this._boom(0.62); }
  explosion() { this._boom(0.95); }
  splash()    { this._splash(0.5); }

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
