// main.js -- boot, the frame loop, and the title overlay.

import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { startMusic, musicWanted, setMusicVolume } from './music.js';
import { settings, saveSettings, PICTURES } from './settings.js';
import { ACHIEVEMENTS, progress, isDone, earnedCount, clearAchievements } from './achievements.js';
import { Game, STEP_MS } from './game.js';
import { perf, perfInit, perfFrame, perfDescribe } from './perf.js';
import { DebugPanel } from './debugpanel.js';
import { prof } from './profile.js';
import { BUILD } from './build.js';

const canvas = document.getElementById('screen');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start');
const touchPad = document.getElementById('touch');

// Which build this is, on the title card.
{
  const el = document.getElementById('build');
  if (el) el.textContent = 'build ' + BUILD.hash + (BUILD.date ? ' \u00b7 ' + BUILD.date : '');
}

// Trouble, where it can be seen. A console browser on a television has no
// developer tools anyone can open, so a script error there was invisible --
// the game simply stopped, or went white. Errors are shown in a line at the
// foot of the screen instead, and kept for the debug panel's report (B).
window.__trouble = [];
let troubleBox = null;
function trouble(msg) {
  window.__trouble.push(msg);
  if (window.__trouble.length > 10) window.__trouble.shift();
  if (!troubleBox) {
    troubleBox = document.createElement('div');
    troubleBox.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:70;' +
      'font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#ffd7c9;' +
      'background:rgba(60,12,8,0.82);padding:4px 8px;border-radius:4px;pointer-events:none';
    document.body.appendChild(troubleBox);
  }
  troubleBox.textContent = msg;
}
addEventListener('error', (e) => {
  const where = (e.filename || '').split('/').pop();
  trouble((e.message || 'error') + (where ? ' @ ' + where + ':' + e.lineno : ''));
});
addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  trouble('promise: ' + ((r && r.message) || r));
});

// The GPU can take the drawing surface away -- a driver reset, the system
// reclaiming memory -- and a canvas whose context is lost shows nothing at
// all. Say so, and start again once it comes back (or after a few seconds
// if it does not): a restart is a better answer than a blank screen.
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  trouble('the graphics were reset by the browser -- restarting');
  setTimeout(() => location.reload(), 4000);
});
canvas.addEventListener('webglcontextrestored', () => location.reload());

let renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  overlay.innerHTML = '<div id="panel"><h1>TWILIGHT HOVER</h1><p>' + err.message + '</p></div>';
  throw err;
}

const input = new Input(canvas);
const audio = new Audio();
const game = new Game(renderer, input, audio);
// B on the pad: the frame's figures as a QR code, and switches. See debugpanel.js.
const debug = new DebugPanel({ renderer, game, canvas });

// Show the right control help for this device, and redo it if a pad turns up
// later: on a console the pad exists before the page does, but the browser
// may not admit to it until the first button press.
function showControlHelp() {
  const touch = input.touchUi;
  document.body.classList.toggle('touch', touch);
  document.getElementById('controls-desktop').hidden = touch;
  document.getElementById('controls-pad').hidden = touch;
  document.getElementById('controls-touch').hidden = !touch;
  labelStart();
  // Focused, so a console's A button activates it natively. That native
  // press carries user activation; a click synthesised from a gamepad poll
  // does not, which is why fullscreen needed cursor mode to work.
  if (!overlay.hidden && !overlay.contains(document.activeElement)) startBtn.focus();
}
input.onPadChange = () => showControlHelp();

// --- the card: title, and pause -------------------------------------------
//
// One card for both. Before a flight it is the title; during one, the pause
// screen, with resume and a new flight, over the frozen world. Either way it
// has the same three pages -- about, how to play, settings -- so they are in
// the same place whenever you look for them.
const restartBtn = document.getElementById('restart');
const subtitle = document.getElementById('subtitle');
const SUBTITLE = subtitle.textContent;
const pauseBtn = document.getElementById('pausebtn');
let cardMode = 'title';          // 'title' | 'pause' | 'none'

function labelStart() {
  const pad = input.padConnected;
  startBtn.textContent = cardMode === 'pause'
    ? (pad ? 'press A to resume' : 'resume')
    : (pad ? 'press A to fly' : 'start flying');
}

function pad6(n) {
  const s = String(Math.max(0, Math.floor(n)));
  return '0'.repeat(Math.max(0, 6 - s.length)) + s;
}

function showBest() {
  const el = document.getElementById('best');
  el.textContent = game.highScore > 0 ? 'best score ' + pad6(game.highScore) : '';
}

function showCard(mode) {
  cardMode = mode;
  restartBtn.hidden = mode !== 'pause';
  subtitle.textContent = mode === 'pause'
    ? 'paused · score ' + pad6(game.score) + ' · flames ' + (game.flames | 0) + ' of 5'
    : SUBTITLE;
  labelStart();
  showBest();
  if (!document.getElementById('page-awards').hidden) showAwards();
  overlay.hidden = false;
  pauseBtn.hidden = true;
  startBtn.focus();
}

function hideCard() {
  cardMode = 'none';
  overlay.hidden = true;
  pauseBtn.hidden = !input.touchUi;
}

// Pages.
const tabs = [...document.querySelectorAll('#tabs .tab')];
function showPage(name) {
  if (name === 'awards') showAwards();
  for (const t of tabs) {
    const on = t.dataset.page === name;
    t.setAttribute('aria-selected', String(on));
    document.getElementById('page-' + t.dataset.page).hidden = !on;
  }
}
for (const t of tabs) t.addEventListener('click', () => showPage(t.dataset.page));
for (const a of document.querySelectorAll('[data-goto]')) {
  a.addEventListener('click', (e) => { e.preventDefault(); showPage(a.dataset.goto); });
}

// The awards page: each one ticked or not, with how far along a count is.
function showAwards() {
  const list = document.getElementById('award-list');
  const done = earnedCount(), all = ACHIEVEMENTS.length;
  document.getElementById('award-count').textContent = done + ' of ' + all + ' earned';
  document.getElementById('award-bar').style.width = (100 * done / all).toFixed(1) + '%';
  list.textContent = '';
  // Earned first, then the rest in their order.
  const order = [...ACHIEVEMENTS.filter((a) => isDone(a.id)), ...ACHIEVEMENTS.filter((a) => !isDone(a.id))];
  for (const a of order) {
    const li = document.createElement('li');
    if (isDone(a.id)) li.className = 'done';
    const tick = document.createElement('span');
    tick.className = 'tick';
    const text = document.createElement('span');
    text.className = 'aname';
    text.textContent = a.name;
    const desc = document.createElement('span');
    desc.className = 'adesc';
    desc.textContent = a.desc;
    text.appendChild(desc);
    const prog = document.createElement('span');
    prog.className = 'aprog';
    if (a.stat && a.goal > 1) prog.textContent = progress(a) + '/' + a.goal;
    li.append(tick, text, prog);
    list.appendChild(li);
  }
}

// --- settings -------------------------------------------------------------

const muteBtn = document.getElementById('mute');
const soundSwitch = document.getElementById('set-sound');
const sliders = {
  volume: document.getElementById('set-volume'),
  music: document.getElementById('set-music'),
  effects: document.getElementById('set-effects'),
  mouse: document.getElementById('set-mouse'),
};

// Put every setting into effect, and every control in line with it.
function applySettings() {
  audio.setMuted(!settings.sound);
  audio.setLevels(settings.volume, settings.effects);
  setMusicVolume(settings.music);
  input.mouseSens = settings.mouse;
  renderer.want = PICTURES[settings.picture].scale;

  soundSwitch.setAttribute('aria-checked', String(settings.sound));
  muteBtn.setAttribute('aria-pressed', String(!settings.sound));
  muteBtn.setAttribute('aria-label', settings.sound ? 'sound on' : 'sound off');
  for (const k of ['volume', 'music', 'effects']) {
    sliders[k].value = String(Math.round(settings[k] * 100));
    document.getElementById('out-' + k).textContent = settings[k] > 0 ? Math.round(settings[k] * 100) + '%' : 'off';
  }
  sliders.mouse.value = String(Math.round(settings.mouse * 100));
  document.getElementById('out-mouse').textContent = settings.mouse.toFixed(1) + '×';
  for (const b of document.querySelectorAll('#picturepick .seg')) {
    b.setAttribute('aria-pressed', String(+b.dataset.picture === settings.picture));
  }
}

function change(fn) {
  fn();
  applySettings();
  saveSettings();
}

function toggleSound() {
  change(() => { settings.sound = !settings.sound; });
  // Said on the screen too, since M in the middle of a flight is otherwise
  // only confirmed by the silence.
  if (overlay.hidden) game.setMessage(settings.sound ? 'sound on' : 'sound off', 50);
}

soundSwitch.addEventListener('click', toggleSound);
muteBtn.addEventListener('click', toggleSound);
for (const k of ['volume', 'music', 'effects']) {
  sliders[k].addEventListener('input', () => change(() => {
    settings[k] = +sliders[k].value / 100;
    // Turning a level up means wanting to hear it.
    if (settings[k] > 0) settings.sound = true;
  }));
}
sliders.mouse.addEventListener('input', () => change(() => { settings.mouse = +sliders.mouse.value / 100; }));
for (const b of document.querySelectorAll('#picturepick .seg')) {
  b.addEventListener('click', () => change(() => { settings.picture = +b.dataset.picture; }));
}

// Clearing the best score asks twice.
const clearBtn = document.getElementById('set-clear');
let clearArmed = 0;
clearBtn.addEventListener('click', () => {
  if (performance.now() - clearArmed < 3000) {
    game.clearHighScore();
    clearBtn.textContent = 'cleared';
    clearArmed = 0;
    showBest();
  } else {
    clearArmed = performance.now();
    clearBtn.textContent = 'sure?';
    setTimeout(() => { if (clearBtn.textContent === 'sure?') clearBtn.textContent = 'clear'; }, 3000);
  }
});

// Clearing the awards asks twice too.
const clearAwardsBtn = document.getElementById('set-clear-awards');
let clearAwardsArmed = 0;
clearAwardsBtn.addEventListener('click', () => {
  if (performance.now() - clearAwardsArmed < 3000) {
    clearAchievements();
    clearAwardsBtn.textContent = 'cleared';
    clearAwardsArmed = 0;
  } else {
    clearAwardsArmed = performance.now();
    clearAwardsBtn.textContent = 'sure?';
    setTimeout(() => { if (clearAwardsBtn.textContent === 'sure?') clearAwardsBtn.textContent = 'clear'; }, 3000);
  }
});

applySettings();
showControlHelp();
showBest();
startBtn.focus();

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
if (segTilt) segTilt.addEventListener('click', async () => {
  setSteer('tilt');
  // Chosen mid-flight, from the pause card: ask for the sensor now, while
  // there is a tap to ask with.
  if (cardMode === 'pause' && !input.tiltEnabled) {
    if (!(await input.enableTilt())) setSteer('touch');
  }
});
if (segTouch) segTouch.addEventListener('click', () => setSteer('touch'));

// Live readout, so a misbehaving sensor is diagnosable rather than a mystery.
const readout = document.getElementById('tiltread');
setInterval(() => {
  if (!readout || overlay.hidden || !input.touchUi) return;
  const d = input.tiltDebug;
  readout.textContent = d
    ? `tilt  ${d.tiltX}° ${d.tiltY}°  ->  x ${d.x}  y ${d.y}  (${d.mode})`
    : 'tilt: waiting for sensor…';
}, 150);

startBtn.addEventListener('click', async () => {
  // A console can deliver the same press twice -- its own activation of the
  // focused button, and ours from the pad poll -- and the second must not
  // start a new flight over the one the first resumed.
  if (overlay.hidden) return;
  if (cardMode === 'pause') { resume(); return; }

  audio.start();
  audio.applyLevels();
  // Same gesture, same context, same output -- so one volume covers both.
  if (musicWanted()) startMusic(audio.ctx, audio.out);

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

restartBtn.addEventListener('click', () => {
  if (cardMode !== 'pause') return;
  game.newGame();
  resume();
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

function beginPlay() {
  hideCard();
  game.newGame();

  // Both of these need the gesture that got us here. The pointer goes first:
  // asking for it after the fullscreen transition has begun is the case
  // browsers most often refuse. Either one failing is survivable -- a click
  // on the canvas grabs the pointer, F toggles fullscreen -- so neither is
  // worth an error.
  input.grabPointer();
  fullscreenOn();   // no-op if the click already got it
}

// --- pause ----------------------------------------------------------------

function flying() {
  return cardMode === 'none';
}

function pause() {
  if (!flying()) return;
  audio.engine(0);
  showCard('pause');
  // Let the pointer go, so the card can be used.
  if (document.pointerLockElement) document.exitPointerLock?.();
}

function resume() {
  hideCard();
  input.newFlight();       // the sticks start from the middle again
  input.grabPointer();     // needs the gesture that brought us here
}

pauseBtn.addEventListener('click', pause);

// Escape lets go of the pointer before any key event reaches the page, so a
// pointer lost mid-flight is the pause. Only a loss, and only while flying:
// a browser that never gave the pointer at all is not a reason to stop.
let lockedBefore = false;
document.addEventListener('pointerlockchange', () => {
  const locked = !!document.pointerLockElement;
  if (lockedBefore && !locked && flying()) pause();
  lockedBefore = locked;
});

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'KeyF') { e.preventDefault(); toggleFullscreen(); }
  else if (e.code === 'KeyM') { e.preventDefault(); toggleSound(); }
  else if (e.code === 'KeyP' || e.code === 'Escape') {
    if (flying()) { e.preventDefault(); pause(); }
    else if (e.code === 'KeyP' && cardMode === 'pause') { e.preventDefault(); resume(); }
  }
});

// Leaving fullscreen drops the pointer as well, so offer it back on the next
// click rather than leaving the player wondering why steering went odd.
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement && flying()) input.grabPointer();
});

// Hidden, everything stops; and a flight comes back to the pause card rather
// than straight into the air, so there is a moment to find the controls.
let paused = false;
document.addEventListener('visibilitychange', () => {
  paused = document.hidden;
  if (paused) {
    audio.engine(0);
    pause();
  }
});

// --- the pad on the card ----------------------------------------------------
//
// A console has no mouse worth the name, so the card is worked from the pad:
// up and down (or left and right) move between the controls, left and right
// move a slider, the bumpers change page, A presses, and Menu -- or any other
// face button or trigger -- starts or resumes. During a flight Menu pauses.
// B stays the debug panel's.
const padWas = [];
function padEdge(pad, i) {
  const b = pad.buttons[i];
  const now = !!b && (b.pressed || b.value > 0.5);
  const was = padWas[i];
  padWas[i] = now;
  return now && !was;
}

function focusables() {
  return [...overlay.querySelectorAll('button, input, a[data-goto]')].filter((el) =>
    !el.hidden && el.offsetParent !== null && !el.disabled);
}

function moveFocus(dir) {
  const list = focusables();
  if (!list.length) return;
  const i = list.indexOf(document.activeElement);
  const next = list[(i < 0 ? 0 : i + dir + list.length) % list.length];
  next.focus();
  next.scrollIntoView?.({ block: 'nearest' });
}

// A pad's A press on a focused button: some console browsers activate it
// themselves, with the user activation fullscreen needs, and some do not.
// So ours waits a moment and only clicks if theirs did not.
let lastTrusted = { el: null, at: 0 };
document.addEventListener('click', (e) => {
  if (e.isTrusted) lastTrusted = { el: e.target.closest('button, a'), at: performance.now() };
}, true);
function padClick(el) {
  const at = performance.now();
  setTimeout(() => {
    if (lastTrusted.el === el && lastTrusted.at >= at - 50) return;
    el.click();
  }, 120);
}

function padOnCard() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let pad = null;
  for (const p of pads) if (p && p.connected) { pad = p; break; }
  if (!pad) return;
  const up = padEdge(pad, 12), down = padEdge(pad, 13), left = padEdge(pad, 14), right = padEdge(pad, 15);
  const a = padEdge(pad, 0), lb = padEdge(pad, 4), rb = padEdge(pad, 5), menu = padEdge(pad, 9);
  let other = false;
  for (const i of [2, 3, 6, 7]) if (padEdge(pad, i)) other = true;
  padEdge(pad, 1); padEdge(pad, 8);

  if (flying()) {
    if (menu) pause();
    return;
  }
  if (overlay.hidden || debug.open) return;
  const el = document.activeElement;
  if (up) moveFocus(-1);
  if (down) moveFocus(1);
  if (left || right) {
    if (el && el.type === 'range') {
      const step = +el.step || 1;
      el.value = String(Math.max(+el.min, Math.min(+el.max, +el.value + (right ? step : -step))));
      el.dispatchEvent(new Event('input'));
    } else {
      moveFocus(right ? 1 : -1);
    }
  }
  if (lb || rb) {
    const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    const t = tabs[(i + (rb ? 1 : -1) + tabs.length) % tabs.length];
    showPage(t.dataset.page);
    t.focus();
  }
  if (a) {
    if (el && overlay.contains(el) && el.tagName !== 'INPUT') padClick(el);
    else padClick(startBtn);
  }
  if (menu || other) padClick(startBtn);
}

let last = performance.now();
let acc = 0;

function frame(now) {
  requestAnimationFrame(frame);

  let dt = now - last;
  last = now;
  if (paused) return;

  // The debug panel reads the pad itself, every frame, so that B opens it
  // from anywhere and its controls work while the flight is paused.
  debug.poll(now);

  // On a console the title screen has to be dismissable from the pad. Edge on
  // Xbox does give you a cursor you can drive to the button, but nobody picks
  // up a controller expecting to point at things, so any button starts the
  // game. Going through the button's own handler rather than beginPlay keeps
  // the audio unlock and the touch branches on one path.
  padOnCard();
  if (!overlay.hidden) {
    // Keep the pad detection and the tilt readout alive behind the card.
    input.sample();
  }
  // The world behind the card: no HUD over it, and the canvas's own title
  // lettering is the card's job now.
  game.cardUp = !overlay.hidden;

  // Never try to catch up more than a few frames; if the tab was in the
  // background for a minute, just carry on from here.
  if (dt > 250) dt = STEP_MS;
  acc += dt;

  // With the debug panel open the flight holds still, but every frame is
  // still drawn: the figures it shows are what drawing costs.
  if (debug.open || cardMode === 'pause') acc = 0;

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
  // Close the frame's GPU timer query, and the wait probe if it is on.
  renderer.endFrame();
  prof.add('step (simulation)', t1 - t0);
  prof.add('draw (all)', t2 - t1);
  prof.endFrame();

  // What the frame cost, kept and reported. The interval between callbacks is
  // measured inside perfFrame, so it takes in everything the browser does
  // with the frame after this function returns -- which is where the time
  // goes on a machine that is compositing in software.
  perfFrame(t1 - t0, t2 - t1, renderer.triangleCount, canvas, renderer.gl);

}


// Expose for debugging from the console -- and before the first perf line,
// which reads the renderer's state off it.
window.lander = { game, input, audio, renderer, perf, debug };

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

