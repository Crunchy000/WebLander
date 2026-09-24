// main.js -- boot, the frame loop, and the title overlay.

import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { startMusic, musicWanted } from './music.js';
import { Game, STEP_MS } from './game.js';
import { perf, perfInit, perfFrame, perfFrameStat, perfDescribe } from './perf.js';

const canvas = document.getElementById('screen');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start');
const touchPad = document.getElementById('touch');

let renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  overlay.innerHTML = '<div id="panel"><h1>WEBLANDER</h1><p>' + err.message + '</p></div>';
  throw err;
}

const input = new Input(canvas);
const audio = new Audio();
const game = new Game(renderer, input, audio);

// Show the right control help for this device, and redo it if a pad turns up
// later: on a console the pad exists before the page does, but the browser
// may not admit to it until the first button press.
function showControlHelp() {
  const touch = input.touchUi;
  document.getElementById('controls-desktop').hidden = touch;
  document.getElementById('controls-touch').hidden = !touch;
  // The tilt options live outside the help text now, so that the buttons can
  // be laid out together on a short screen. They still belong to touch.
  document.getElementById('tiltopts').hidden = !touch;
  // Say which button, when we know there is one. On a television across the
  // room "start flying" is a label, not an instruction; "press A" is the
  // thing to do.
  startBtn.textContent = input.padConnected ? 'press A to fly' : 'start flying';

  // Focused, so a console's A button activates it natively. That native
  // press carries user activation; a click synthesised from a gamepad poll
  // does not, which is why fullscreen needed cursor mode to work.
  if (!overlay.hidden) startBtn.focus();
}
showControlHelp();
input.onPadChange = () => showControlHelp();

// Tilt or a thumb stick. Remembered, because it is a preference about hands
// rather than about the game, and nobody wants to state it twice.
const STEER_KEY = 'weblander.steer';
const segTilt = document.getElementById('steer-tilt');
const segTouch = document.getElementById('steer-touch');

function setSteer(mode, save = true) {
  input.steerMode = mode === 'touch' ? 'touch' : 'tilt';
  if (segTilt) segTilt.setAttribute('aria-pressed', String(input.steerMode === 'tilt'));
  if (segTouch) segTouch.setAttribute('aria-pressed', String(input.steerMode === 'touch'));
  if (save) { try { localStorage.setItem(STEER_KEY, input.steerMode); } catch { /* private mode */ } }
}
// The thumb stick is the default: it needs no sensor, no permission and no
// getting used to, and tilt is one tap away for anyone who prefers it.
try { setSteer(localStorage.getItem(STEER_KEY) || 'touch', false); } catch { setSteer('touch', false); }
if (segTilt) segTilt.addEventListener('click', () => setSteer('tilt'));
if (segTouch) segTouch.addEventListener('click', () => setSteer('touch'));

// Live readout, so a misbehaving sensor is diagnosable rather than a mystery.
const readout = document.getElementById('tiltread');
setInterval(() => {
  if (!readout || overlay.hidden) return;
  input.sample();
  const d = input.tiltDebug;
  readout.textContent = d
    ? `tilt  ${d.tiltX}\u00b0 ${d.tiltY}\u00b0  ->  x ${d.x}  y ${d.y}  (${d.mode})`
    : 'tilt: waiting for sensor\u2026';
}, 150);

startBtn.addEventListener('click', async () => {
  audio.start();
  // Same gesture, same context, same master -- so one mute covers both and
  // there is never a second volume control to find.
  if (musicWanted()) startMusic(audio.ctx, audio.master);

  // Fullscreen first, and synchronously. It spends the gesture that got us
  // here, and everything below this line may await -- by which point the
  // activation can be gone and the request refused. This is why fullscreen
  // only worked from cursor mode.
  fullscreenOn();

  // The A press that activated this button is also what reveals the pad to
  // the browser, so padConnected is still a stale "no" at this instant unless
  // we ask again.
  input.refreshPads();

  if (input.touchUi) {
    // A thumb stick needs no sensor and no permission, so it is not asked for.
    const ok = input.steerMode === 'touch' ? false : await input.enableTilt();
    if (!ok && input.steerMode !== 'touch') {
      // No motion sensor, or permission refused. The thumb stick steers
      // instead -- it always can -- so say so rather than leaving the player
      // to find out.
      document.getElementById('tiltnote').hidden = false;
      // ... unless the sensor was only slow. enableTilt waits a third of a
      // second for the first sample, which is plenty for a handset that is
      // already running and not always enough for one starting its sensors
      // from cold. The listener is attached either way, so if a reading turns
      // up in the next few seconds the furniture is taken away again rather
      // than left standing over a control that now works.
      watchForLateTilt();
    }
    // Either way one finger flies it: the engine comes on where it lands and
    // the stick is how far it has moved since. Nothing to press, so the
    // thrust pad stays away.
    touchPad.hidden = true;
  }

  beginPlay();
});

// See above: the thrust pad and the note go once tilt starts answering.
function watchForLateTilt() {
  const until = performance.now() + 6000;
  const check = setInterval(() => {
    if (input.tiltEnabled && input.tilt.ready) {
      document.getElementById('tiltnote').hidden = true;
      clearInterval(check);
    } else if (performance.now() > until) {
      clearInterval(check);
    }
  }, 250);
}

// Fullscreen the whole document rather than the canvas alone, so the stage
// keeps centring the picture and the overlay still has somewhere to sit. A
// bare canvas element goes fullscreen as a raw bitmap and loses both.
function fullscreenOn() {
  const el = document.documentElement;
  if (document.fullscreenElement) return;
  (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else fullscreenOn();
}

addEventListener('keydown', (e) => {
  if (e.code === 'KeyF' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    toggleFullscreen();
  }
});

function beginPlay() {
  overlay.hidden = true;
  game.newGame();

  // Both of these need the gesture that got us here. The pointer goes first:
  // asking for it after the fullscreen transition has begun is the case
  // browsers most often refuse. Either one failing is survivable -- a click
  // on the canvas grabs the pointer, F toggles fullscreen -- so neither is
  // worth an error.
  input.grabPointer();
  fullscreenOn();   // no-op if the click already got it
}

// Leaving fullscreen drops the pointer as well, so offer it back on the next
// click rather than leaving the player wondering why steering went odd.
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) input.grabPointer();
});

// Pause when the tab is hidden, so the ship is not quietly falling out of the
// sky while you read your email.
let paused = false;
document.addEventListener('visibilitychange', () => {
  paused = document.hidden;
  if (paused) audio.engine(0);
});

let last = performance.now();
let acc = 0;
let adaptTick = 0;

function frame(now) {
  requestAnimationFrame(frame);

  let dt = now - last;
  last = now;
  if (paused) return;

  // On a console the title screen has to be dismissable from the pad. Edge on
  // Xbox does give you a cursor you can drive to the button, but nobody picks
  // up a controller expecting to point at things, so any button starts the
  // game. Going through the button's own handler rather than beginPlay keeps
  // the audio unlock and the touch branches on one path.
  if (!overlay.hidden) {
    input.sample();
    if (input.padAnyButton) { startBtn.click(); return; }
  }

  // Never try to catch up more than a few frames; if the tab was in the
  // background for a minute, just carry on from here.
  if (dt > 250) dt = STEP_MS;
  acc += dt;

  const t0 = performance.now();
  let steps = 0;
  while (acc >= STEP_MS && steps < 5) {
    game.step();
    acc -= STEP_MS;
    steps++;
  }
  const t1 = performance.now();
  game.draw();
  const t2 = performance.now();

  // What the frame cost, kept and reported. The interval between callbacks is
  // measured inside perfFrame, so it takes in everything the browser does
  // with the frame after this function returns -- which is where the time
  // goes on a machine that is compositing in software.
  perfFrame(t1 - t0, t2 - t1, renderer.triangleCount, canvas, renderer.gl);

  // Four times a second, let the renderer decide whether the machine is
  // keeping up with the number of pixels it is being asked for.
  if ((adaptTick = (adaptTick + 1) % 15) === 0) renderer.adapt(perfFrameStat());
}


// Expose for debugging from the console -- and before the first perf line,
// which reads the renderer's state off it.
window.lander = { game, input, audio, renderer, perf };

perfInit();
perfDescribe(canvas, renderer.gl);
requestAnimationFrame(frame);

// The game used to install a service worker. Anyone who ran it then still
// has one registered, and it would go on intercepting every request for this
// origin indefinitely -- including after this code stopped shipping one. So
// it is explicitly unregistered rather than merely no longer installed.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations?.()
    .then((rs) => rs.forEach((r) => r.unregister()))
    .catch(() => {});
  // globalThis, not a bare `caches`: the binding only exists in a secure
  // context, and referring to it directly would throw over plain http.
  globalThis.caches?.keys?.()
    .then((keys) => keys.forEach((k) => caches.delete(k)))
    .catch(() => {});
}

