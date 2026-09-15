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

// Show the right control help, and the touch pad, for this device.
if (input.hasTouch) {
  document.getElementById('controls-desktop').hidden = true;
  document.getElementById('controls-touch').hidden = false;
}

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

  if (input.hasTouch) {
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

function beginPlay() {
  overlay.hidden = true;
  game.newGame();

  if (canvas.requestFullscreen && input.hasTouch) {
    canvas.requestFullscreen?.().catch(() => {});
  }
}

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

// Expose for debugging from the console.
window.lander = { game, input, audio, renderer, calibration };
