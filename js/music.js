// music.js -- a soundtrack, if there is one.
//
// Everything else that makes a noise here is synthesised: audio.js opens with
// "no assets to load" and means it, and the whole game is still a handful of
// text files. Music is the one thing that cannot be, so this is deliberately
// the only part of the game that touches a file, and it is written so that
// its absence costs nothing -- no track present, nothing happens, no error,
// no delay to the first frame.
//
// Tracks stream through an <audio> element rather than being decoded into
// memory. A two-minute piece is several megabytes decoded, and decodeAudioData
// wants the whole thing before it will play a note; an element starts on the
// first buffer and holds one. On a page whose entire point is that it loads
// instantly, that is not a close call.

import { serene } from './style.js';

// The playlist. Files live in audio/ and are listed here, in the order they
// should be heard the first time round; after that the order is shuffled.
// Anything that will not load is dropped quietly, so a half-populated list
// still works.
export const TRACKS = [
  'audio/twilight-on-the-horizon.mp3',
  'audio/cooling-sands-at-dusk.mp3',
];

// Music sits a long way under the effects. It is a bed, not a feature: the
// engine, the warnings and the guns all have to be heard over it, and a
// warning you cannot hear is worse than no music at all.
const GAIN = 0.34;
const FADE = 2.5;          // seconds to bring a track up or take it down
const GAP = 1.2;           // seconds of quiet between tracks

let ctx = null;
let bus = null;
let playing = null;
let order = [];
let at = 0;
let enabled = false;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Hand it the game's audio context and master node, so music goes through the
// same limiter and the same mute as everything else and there is one volume
// control rather than two.
export function startMusic(audioCtx, master) {
  if (enabled || !audioCtx || !master) return;
  if (!TRACKS.length) return;
  if (typeof Audio === 'undefined') return;     // not in a browser

  ctx = audioCtx;
  bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(master);

  order = TRACKS.slice();
  enabled = true;
  next();
}

function next() {
  if (!enabled) return;
  if (at >= order.length) { at = 0; shuffle(order); }
  const src = order[at++];

  const el = new Audio();
  el.src = src;
  el.crossOrigin = 'anonymous';
  el.preload = 'auto';

  // A track that will not load takes its turn out of the list rather than
  // stopping the music: a missing file should cost that file and nothing else.
  el.addEventListener('error', () => {
    const i = order.indexOf(src);
    if (i >= 0) order.splice(i, 1);
    if (order.length) setTimeout(next, 200);
    else enabled = false;
  }, { once: true });

  let node;
  try {
    node = ctx.createMediaElementSource(el);
  } catch {
    return;                                     // context will not have it
  }
  node.connect(bus);

  playing = { el, node };
  el.play().catch(() => {});

  const t = ctx.currentTime;
  bus.gain.cancelScheduledValues(t);
  bus.gain.setValueAtTime(bus.gain.value, t);
  bus.gain.linearRampToValueAtTime(GAIN, t + FADE);

  // Fade out into the gap rather than stopping dead, and line the next one up
  // behind it. `timeupdate` rather than `ended` so the fade has somewhere to
  // happen.
  let fading = false;
  el.addEventListener('timeupdate', () => {
    if (fading || !el.duration || !isFinite(el.duration)) return;
    if (el.currentTime < el.duration - FADE) return;
    fading = true;
    const t2 = ctx.currentTime;
    bus.gain.cancelScheduledValues(t2);
    bus.gain.setValueAtTime(bus.gain.value, t2);
    bus.gain.linearRampToValueAtTime(0, t2 + FADE);
    setTimeout(next, (FADE + GAP) * 1000);
  });
}

// Whether a soundtrack is actually running, for anything that wants to know.
export function musicPlaying() {
  return !!(enabled && playing && !playing.el.paused);
}

// What it is playing and how far in. The element is detached -- it is never
// put in the document -- so there is no other way to look at it, and "is it
// paused" is not the same question as "is it moving".
export function musicStatus() {
  if (!playing) return null;
  const el = playing.el;
  return {
    src: el.src.split('/').pop(),
    at: +el.currentTime.toFixed(2),
    duration: isFinite(el.duration) ? +el.duration.toFixed(1) : null,
  };
}

// The serene style is the one the music was chosen for; the original is a
// 1987 machine with a beeper and nothing else, and a lush bed over it would
// be a costume rather than a style.
export function musicWanted() {
  return serene();
}
