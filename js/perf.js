// perf.js -- what the frame costs, on whatever machine is running it.
//
// The measurements that shaped this renderer were taken on a container with
// no GPU, where a software rasteriser makes the pixel count look like the
// only thing that matters. It is not the machine anyone plays on, and the
// only way to know what a real one does is to ask it. So the game keeps its
// own figures and says them out loud.
//
// Two ways to read them. A line in the console every ten seconds, which is
// what you want from a phone plugged into a laptop; and an overlay in the
// corner, which is what you want while you are flying. The overlay is off
// until you ask for it, with ?perf in the address or by pressing P, because a
// permanent readout is a thing you stop seeing.
//
// The overlay is DOM rather than drawn with the game's own font, deliberately.
// The HUD is a quad per lit pixel of a glyph and comes to something like two
// thousand triangles -- a sixth of the frame -- so a readout drawn that way
// would be changing the number it was reporting.

const WINDOW = 120;             // frames kept for the percentiles
const LOG_EVERY = 10000;        // ... and how often a line goes to the console

const interval = new Float32Array(WINDOW);
const stepMs = new Float32Array(WINDOW);
const drawMs = new Float32Array(WINDOW);
const trisAt = new Float32Array(WINDOW);
let n = 0, at = 0;
let lastFrame = 0;
let lastLog = 0;
let lastPaint = 0;
let box = null;

export const perf = {
  overlay: false,
  logging: true,
};

// A percentile out of one of the ring buffers, without disturbing it.
const sortBuf = new Float32Array(WINDOW);
function pct(buf, p) {
  const count = Math.min(n, WINDOW);
  if (!count) return 0;
  sortBuf.set(buf.subarray(0, count));
  const slice = sortBuf.subarray(0, count);
  slice.sort();
  const i = Math.min(count - 1, Math.max(0, Math.round((count - 1) * p)));
  return slice[i];
}

// What is doing the drawing, which is the other half of any number here. The
// unmasked strings need an extension that some browsers withhold; the masked
// ones are always there and are usually enough to tell a phone from a laptop.
function describe(canvas, gl, short = false) {
  const bits = [];
  if (canvas) bits.push(canvas.width + 'x' + canvas.height);
  if (typeof window !== 'undefined') {
    bits.push('dpr ' + (window.devicePixelRatio || 1).toFixed(1));
    if (window.innerWidth) bits.push('css ' + window.innerWidth + 'x' + window.innerHeight);
  }
  if (gl) {
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const who = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
                      : gl.getParameter(gl.RENDERER);
      if (who) bits.push(short ? trim(String(who)) : String(who));
    } catch (err) { /* the extension is allowed to be missing */ }
  }
  if (typeof navigator !== 'undefined') {
    if (navigator.hardwareConcurrency) bits.push(navigator.hardwareConcurrency + ' cores');
    if (navigator.deviceMemory) bits.push(navigator.deviceMemory + 'GB');
  }
  return bits.join('  ');
}

// A renderer string is a sentence: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader
// Device (Subzero) (0x0000C0DE)), SwiftShader driver)". The console gets all
// of it; the corner of the screen gets the part that says which chip.
function trim(who) {
  const inner = /^ANGLE \(([^,]+),\s*([^,(]+)/.exec(who);
  const text = inner ? inner[1] + ' ' + inner[2].trim() : who;
  return text.length > 44 ? text.slice(0, 43) + '…' : text;
}

let described = false;
export function perfDescribe(canvas, gl) {
  if (described) return;
  described = true;
  console.log('weblander: ' + describe(canvas, gl));
}

// One frame's worth. The interval is measured callback to callback, so it
// includes everything the browser does with the frame after the game has
// finished with it -- which on a machine without a GPU is most of it.
export function perfFrame(step, draw, tris, canvas, gl) {
  const now = performance.now();
  if (lastFrame) {
    interval[at] = now - lastFrame;
    stepMs[at] = step;
    drawMs[at] = draw;
    trisAt[at] = tris;
    at = (at + 1) % WINDOW;
    n++;
  }
  lastFrame = now;

  if (perf.logging && now - lastLog > LOG_EVERY && n > WINDOW / 2) {
    lastLog = now;
    console.log('weblander: ' + line(canvas, gl));
  }
  if (perf.overlay && now - lastPaint > 250) {
    lastPaint = now;
    paint(canvas, gl);
  } else if (!perf.overlay && box) {
    box.remove();
    box = null;
  }
}

function fps() {
  const ms = pct(interval, 0.5);
  return ms > 0 ? 1000 / ms : 0;
}

function line(canvas, gl) {
  return fps().toFixed(0) + ' fps' +
         '  frame ' + pct(interval, 0.5).toFixed(1) + '/' + pct(interval, 0.95).toFixed(1) + 'ms' +
         '  draw ' + pct(drawMs, 0.5).toFixed(2) + '/' + pct(drawMs, 0.95).toFixed(2) + 'ms' +
         '  step ' + pct(stepMs, 0.5).toFixed(2) + 'ms' +
         '  ' + Math.round(pct(trisAt, 0.5)) + ' tris' +
         '  ' + describe(canvas, gl);
}

function paint(canvas, gl) {
  if (!box) {
    box = document.createElement('div');
    box.id = 'perf';
    box.style.cssText = 'position:fixed;left:8px;top:30px;z-index:50;' +
      'font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;' +
      'white-space:pre-wrap;max-width:min(52ch,calc(100vw - 32px));' +
      'color:#cfe6ff;background:rgba(6,10,20,0.62);padding:6px 8px;' +
      'border-radius:4px;pointer-events:none;text-shadow:0 1px 0 #000';
    document.body.appendChild(box);
  }
  box.textContent =
    fps().toFixed(0) + ' fps   frame ' + pct(interval, 0.5).toFixed(1) +
      ' / ' + pct(interval, 0.95).toFixed(1) + ' ms\n' +
    'draw  ' + pct(drawMs, 0.5).toFixed(2) + ' / ' + pct(drawMs, 0.95).toFixed(2) +
      ' ms    step ' + pct(stepMs, 0.5).toFixed(2) + ' ms\n' +
    Math.round(pct(trisAt, 0.5)) + ' tris   ' + describe(canvas, gl, true);
}

// ?perf turns the overlay on for this load; P toggles it at any time, and
// sticks, so a device you had to plug in once will still be showing it the
// next time you open the game on it.
export function perfInit() {
  if (typeof window === 'undefined') return;
  let want = false;
  try {
    want = /[?&]perf\b/.test(window.location.search) ||
           window.localStorage.getItem('weblander.perf') === '1';
  } catch (err) { /* storage can be refused; the query string still works */ }
  perf.overlay = want;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'p' && e.key !== 'P') return;
    perf.overlay = !perf.overlay;
    try {
      window.localStorage.setItem('weblander.perf', perf.overlay ? '1' : '0');
    } catch (err) { /* ... and if it cannot be remembered, it still toggles */ }
  });
}
