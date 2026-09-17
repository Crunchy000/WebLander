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
// The sideways direction at each sample, not at each segment. Working per
// segment gives every quad its own two normals, and where the path bends --
// which on a loop is everywhere -- consecutive quads no longer share an edge:
// they leave a wedge of gap on the outside and overlap on the inside. Under
// ordinary blending that is a ragged edge; under additive it is a row of
// bright seams and dark notches, and the halo comes out looking like a saw
// blade. Averaging the two directions either side of a sample makes the strip
// continuous, because both quads that meet there use the same edge.
const nrm = new Float32Array(LENGTH * 2);
const ok = new Uint8Array(LENGTH);
const colA = [0, 0, 0, 0];
const colB = [0, 0, 0, 0];

// After dark the ribbon stops being a ribbon and becomes a light. Nothing
// else in the game emits -- every surface here is lit by the sun or the moon
// and nothing generates its own -- so this is the one thing on screen that a
// long exposure would catch, and it is drawn the way a long exposure catches
// it: bright at the head where the craft is now, cooling and spreading behind
// it, adding to whatever it passes over rather than covering it.
//
// The head is a hot white with the faintest warmth in it, the tail a deep
// blue. That gradient is not decoration: it is what makes the trail read as
// something that happened over time rather than a shape drawn in one go.
const NIGHT_HEAD = [255, 244, 214];
const NIGHT_TAIL = [96, 130, 230];

// A bloom is cheap to fake when the thing blooming is already a strip: the
// same strip again, wider and dimmer, underneath. Two of them, at different
// widths, because one hard-edged halo reads as a mistake where two stacked
// give something that falls off.
//
// The wide passes are drawn at half resolution -- every second sample, joined
// across the gap. A halo has no detail to lose, and it halves what is the
// most expensive part of this: big translucent quads are fill rate, not
// vertices.
const GLOW = [
  { wide: 7.0, gain: 0.13, step: 2 },
  { wide: 3.4, gain: 0.30, step: 2 },
];

// One pass along the strip. `gain` scales opacity, `wide` scales width,
// `night` picks the light-trail colours over the daytime ribbon, `fade` is
// the exponent the tail dies off with, and `step` draws every nth sample.
//
// The exponent matters more than it sounds. Squared is right for a ribbon --
// it wants to be a short mark behind the craft. A light trail wants to hang
// about, so at night the fade is gentler and the whole loop stays lit long
// enough to close the circle.
// The colour of one end of one quad, written in place. Both ends of every
// quad of every pass go through here, several hundred times a frame, so it
// allocates nothing.
function shade(col, t, gain, fade, night, dayR, dayG, dayB) {
  if (night) {
    // Hot at the head, cool at the tail: the craft is where the light is
    // being made, and everything behind it is that light cooling off.
    const h = t * t;
    col[0] = Math.round(NIGHT_TAIL[0] + (NIGHT_HEAD[0] - NIGHT_TAIL[0]) * h);
    col[1] = Math.round(NIGHT_TAIL[1] + (NIGHT_HEAD[1] - NIGHT_TAIL[1]) * h);
    col[2] = Math.round(NIGHT_TAIL[2] + (NIGHT_HEAD[2] - NIGHT_TAIL[2]) * h);
  } else {
    col[0] = dayR; col[1] = dayG; col[2] = dayB;
  }
  col[3] = Math.min(255, Math.round(255 * gain * Math.pow(t, fade)));
}

function strip(rd, gain, wide, night, fade, step) {
  if (gain <= 0.004) return;
  const warm = sky.sunStrength;
  const dayR = Math.round(210 + 40 * warm);
  const dayG = Math.round(214 + 26 * warm);
  const dayB = Math.round(228 - 18 * warm);

  for (let i = 0; i + step < filled; i += step) {
    const k = i + step;
    if (!ok[i] || !ok[k]) continue;
    const x0 = pts[i * 2], y0 = pts[i * 2 + 1];
    const x1 = pts[k * 2], y1 = pts[k * 2 + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    // A stationary craft would otherwise pile ninety quads on one pixel and
    // turn the trail into a blob.
    if (len < 0.35 * step || len > 90 * step) continue;

    // How far along the strip, tail at 0 and head at 1.
    const tA = i / (filled - 1);
    const tB = k / (filled - 1);
    const wA = WIDTH * wide * (TAIL + (1 - TAIL) * tA);
    const wB = WIDTH * wide * (TAIL + (1 - TAIL) * tB);
    const ax = nrm[i * 2], ay = nrm[i * 2 + 1];
    const bx = nrm[k * 2], by = nrm[k * 2 + 1];

    shade(colA, tA, gain, fade, night, dayR, dayG, dayB);
    shade(colB, tB, gain, fade, night, dayR, dayG, dayB);

    rd.quadShaded(
      x0 + ax * wA, y0 + ay * wA, colA,
      x1 + bx * wB, y1 + by * wB, colB,
      x1 - bx * wB, y1 - by * wB, colB,
      x0 - ax * wA, y0 - ay * wA, colA);
  }
}

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

  // The sideways direction at each sample: perpendicular to the path through
  // it, taken from the sample before to the sample after so a bend is shared
  // evenly between the two quads that meet there. The ends have only one
  // neighbour and use it.
  for (let i = 0; i < filled; i++) {
    const a = i > 0 ? i - 1 : i;
    const b = i + 1 < filled ? i + 1 : i;
    const dx = pts[b * 2] - pts[a * 2];
    const dy = pts[b * 2 + 1] - pts[a * 2 + 1];
    const len = Math.hypot(dx, dy) || 1;
    nrm[i * 2] = -dy / len;
    nrm[i * 2 + 1] = dx / len;
  }

  // `lamp` is the game's own measure of how strongly a light reads: zero in
  // daylight, full after dark, and a ramp through dusk. Using it means the
  // ribbon crosses over at the same moment the landing lamps and the beacons
  // do, rather than at a threshold of its own that would disagree with them.
  const night = sky.lamp;

  // Pale by day, and always a little brighter than the sky it is drawn over
  // so it reads on either. It fades out as the light does, because a flat
  // grey ribbon over a night scene is the one thing that would spoil this.
  strip(rd, 0.82 * (1 - 0.88 * night), 1, false, 2, 1);

  if (night > 0.02) {
    rd.blend('add');
    for (const g of GLOW) strip(rd, g.gain * night, g.wide, true, 1.1, g.step);
    // The core last, so the brightest part of it is on top of its own halo.
    strip(rd, 0.95 * night, 1.15, true, 1.4, 1);
    rd.blend('over');
  }
}
