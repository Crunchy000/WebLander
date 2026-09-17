// ribbon.js -- a streamer trailing off the craft.
//
// Flying has no marks on it. You can roll a craft right over and, with the
// camera fixed and the ground a long way down, the only evidence is the model
// changing shape for a moment. A ribbon leaves the path itself on the screen:
// a loop draws a loop, a hard turn draws the turn, and drifting sideways draws
// a line that is not where the nose is pointing.
//
// It is a ring of past positions, drawn as a strip of quads whose width and
// opacity fall away towards the tail. No physics, no simulation -- the craft
// has already done the work, and this only has to remember it.

import { TILE, matApply } from './maths.js';
import { sky } from './daylight.js';
import { project, SCREEN_W, SCREEN_H } from './renderer.js';

// A second and a bit of trail at 50Hz. Long enough to hold a whole loop --
// a loop takes about 1.7 seconds at full stick, so the head catches the tail
// and the ribbon closes the circle, which is the shot worth having.
const LENGTH = 90;

// Where it is anchored on the craft: off the tail, a little below the spine.
const ANCHOR = [0, 0.10, -0.62];

const WIDTH = 2.6;         // pixels at the head
const TAIL = 0.15;         // and the fraction of that left at the tail

const x = new Int32Array(LENGTH);
const y = new Int32Array(LENGTH);
const z = new Int32Array(LENGTH);
let head = 0;
let filled = 0;

export function resetRibbon() {
  head = 0;
  filled = 0;
}

// Called once a frame with the craft, after it has moved.
export function sampleRibbon(p) {
  if (p.dead) return;
  const o = matApply(p.matrix, ANCHOR[0] * TILE, ANCHOR[1] * TILE, ANCHOR[2] * TILE);
  x[head] = (p.x + o[0]) | 0;
  y[head] = (p.y + o[1]) | 0;
  z[head] = (p.z + o[2]) | 0;
  head = (head + 1) % LENGTH;
  if (filled < LENGTH) filled++;
}

const pt = { x: 0, y: 0 };
const pts = new Float32Array(LENGTH * 2);
const ok = new Uint8Array(LENGTH);
const colA = [0, 0, 0, 0];
const colB = [0, 0, 0, 0];

export function drawRibbon(rd, camX, camY, camZ) {
  if (filled < 4) return;

  // Oldest first, so the strip runs tail to head and the quads are emitted in
  // the order they stack.
  for (let i = 0; i < filled; i++) {
    const j = (head - filled + i + LENGTH * 2) % LENGTH;
    const good = project((x[j] - camX) | 0, (y[j] - camY) | 0, (z[j] - camZ) | 0, pt);
    ok[i] = good && pt.x > -60 && pt.x < SCREEN_W + 60 && pt.y > -60 && pt.y < SCREEN_H + 60 ? 1 : 0;
    pts[i * 2] = pt.x;
    pts[i * 2 + 1] = pt.y;
  }

  // Pale by day, cooler after dark, and always a little brighter than the sky
  // it is drawn over so it reads on either.
  const warm = sky.sunStrength;
  const r = Math.round(210 + 40 * warm);
  const g = Math.round(214 + 26 * warm);
  const b = Math.round(228 - 18 * warm);

  for (let i = 0; i + 1 < filled; i++) {
    if (!ok[i] || !ok[i + 1]) continue;
    const x0 = pts[i * 2], y0 = pts[i * 2 + 1];
    const x1 = pts[i * 2 + 2], y1 = pts[i * 2 + 3];
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    // A stationary craft would otherwise pile ninety quads on one pixel and
    // turn the trail into a blob.
    if (len < 0.35 || len > 90) continue;

    // How far along the strip, tail at 0 and head at 1.
    const tA = i / (filled - 1);
    const tB = (i + 1) / (filled - 1);
    const wA = WIDTH * (TAIL + (1 - TAIL) * tA);
    const wB = WIDTH * (TAIL + (1 - TAIL) * tB);
    const nx = -dy / len, ny = dx / len;

    colA[0] = r; colA[1] = g; colA[2] = b; colA[3] = Math.round(210 * tA * tA);
    colB[0] = r; colB[1] = g; colB[2] = b; colB[3] = Math.round(210 * tB * tB);

    rd.quadShaded(
      x0 + nx * wA, y0 + ny * wA, colA,
      x1 + nx * wB, y1 + ny * wB, colB,
      x1 - nx * wB, y1 - ny * wB, colB,
      x0 - nx * wA, y0 - ny * wA, colA);
  }
}
