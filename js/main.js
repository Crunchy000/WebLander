// main.js -- boot, the frame loop, and the title overlay.

import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Game, STEP_MS } from './game.js';

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

startBtn.addEventListener('click', async () => {
  audio.start();

  if (input.hasTouch) {
    const ok = await input.enableTilt();
    if (!ok) {
      // No motion sensor, or permission refused: fall back to dragging.
      document.getElementById('tiltnote').hidden = false;
      document.getElementById('controls-touch').innerHTML =
        '<p><b>Drag</b> on the screen to steer.</p>' +
        '<p>Hold <b>THRUST</b> to burn, <b>FIRE</b> to shoot.</p>';
    } else {
      input.calibrateTilt();
    }
    touchPad.hidden = false;
  }

  overlay.hidden = true;
  game.newGame();

  if (canvas.requestFullscreen && input.hasTouch) {
    canvas.requestFullscreen?.().catch(() => {});
  }
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
window.lander = { game, input, audio, renderer };
