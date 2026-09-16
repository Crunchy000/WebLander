// main.js -- boot, the frame loop, and the title overlay.

import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Game, STEP_MS } from './game.js';
import { Calibration } from './calibrate.js';

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
  // Say which button, when we know there is one. On a television across the
  // room "START" is a word, not an instruction; "PRESS A" is the thing to do.
  startBtn.textContent = input.padConnected ? 'PRESS  A' : 'START';

  // Focused, so a console's A button activates it natively. That native
  // press carries user activation; a click synthesised from a gamepad poll
  // does not, which is why fullscreen needed cursor mode to work.
  if (!overlay.hidden) startBtn.focus();
}
showControlHelp();
input.onPadChange = () => showControlHelp();

const calibration = new Calibration(input, input.tilt);

// Recalibrate on demand from the title card.
const calOpen = document.getElementById('cal-open');
if (calOpen) {
  calOpen.addEventListener('click', async () => {
    if (!input.tiltEnabled) {
      const ok = await input.enableTilt();
      if (!ok) { document.getElementById('tiltnote').hidden = false; return; }
    }
    input.tilt.clear();
    calibration.start(() => {});
  });
}

// Live readout, so a misbehaving sensor is diagnosable rather than a mystery.
const readout = document.getElementById('tiltread');
setInterval(() => {
  if (!readout || overlay.hidden) return;
  input.sample();
  const d = input.tiltDebug;
  readout.textContent = d
    ? `tilt  b ${d.beta}  g ${d.gamma}  ->  x ${d.x}  y ${d.y}  (${d.mode})`
    : 'tilt: waiting for sensor…';
}, 150);

startBtn.addEventListener('click', async () => {
  audio.start();

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
    const ok = await input.enableTilt();
    if (!ok) {
      // No motion sensor, or permission refused: drag to steer instead, which
      // occupies the screen, so the thrust pad is needed after all.
      document.getElementById('tiltnote').hidden = false;
      touchPad.hidden = false;
    } else {
      input.calibrateTilt();
      // Tilt steers and touching anywhere thrusts, so no buttons are needed.
      touchPad.hidden = true;

      if (!input.tilt.calibrated) {
        // First run on this handset: measure the tilt mapping rather than
        // hand the player controls that may well be wired up backwards.
        overlay.hidden = true;
        calibration.start(() => beginPlay());
        return;
      }
    }
  }

  beginPlay();
});

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

  let steps = 0;
  while (acc >= STEP_MS && steps < 5) {
    game.step();
    acc -= STEP_MS;
    steps++;
  }
  if (steps === 5) acc = 0;

  game.draw();
}

requestAnimationFrame(frame);

// Offline play, and an end to the stale-module problem: the worker is
// network first, so online you get whatever was last deployed and the cache
// only answers when the network will not. Registered after the game is
// running so it never delays the first frame, and quietly ignored where the
// browser or the origin will not have it -- a service worker needs https or
// localhost, and the game is perfectly happy without one.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Expose for debugging from the console.
window.lander = { game, input, audio, renderer, calibration };
