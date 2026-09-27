// origami.js -- the paper phoenix, and how it flies.
//
// Folded rather than modelled: every piece is a flat facet of paper, all of
// it in the oranges of a fire -- ember at the roots, flame, amber, gold at
// the tips. A hooked beak and a crest of three swept-back feathers; a neck
// that rises to the head; wings raised in a V, each an arm folded once and
// a hand cut into six long flight feathers with three shorter ones behind;
// legs hanging with their talons; and a tail of five tongues of flame, each
// drooping and then curling up at its tip -- and the tips burning, lit from
// within, so they glow when the evening has dimmed everything else.
//
// Paper, twice over. Every facet's tone is nudged a little lighter or darker
// than its neighbours, the way a folded sheet catches the light unevenly,
// which is most of what makes a low-poly figure read as paper. And on the
// GPU each facet also carries a faint grain, fixed to the paper rather than
// to the screen (`grain` on the model; see modelpass.js).
//
// Three pieces, because three things move independently: the body, and a
// wing either side, each built about its own shoulder so it can be turned
// there. Axes are the engine's: +x right, +y DOWN, +z forward (the beak).

import { TILE, matMul, matRotY, matRotZ, matApply, hash2 } from './maths.js';
import { Model, LIGHT, shade, drawModel } from './model.js';
import { UNDERCARRIAGE_Y } from './landscape.js';

// --- the paper -------------------------------------------------------------

const EMBER = [178, 52, 14];
const RUST = [206, 76, 18];
const FLAME = [232, 108, 28];
const AMBER = [244, 142, 48];
const GOLD = [250, 180, 80];
const PALE = [252, 208, 126];
const INK = [40, 18, 12];
// The burning tips of the tail, which make their own light.
const EMBERGLOW_A = [255, 196, 84];
const EMBERGLOW_B = [255, 150, 46];

// Paper has no inside, so a facet is lit by how it is inclined, not which
// way it faces: both sides of a sheet take the same light.
const SHADE_FLOOR = 0.72;
const SHADE_RANGE = 0.38;
// ... and each facet a little off its neighbours, as folded paper is.
const MOTTLE = 0.07;
// The paper's grain, as a share of the colour. See modelpass.js.
const GRAIN = 0.11;

// A piece is written as named points and triangles between them, which is
// easier to fold on paper than a table of numbers. A name ending in R has a
// twin ending in L, the same point mirrored across the bird's middle, so each
// side is only written once.
function build(points, tris, dy, seed) {
  const m = new Model();
  const at = {};
  for (const [name, [x, y, z]] of Object.entries(points)) {
    at[name] = m.vert(x, y - dy, z);
    if (name.endsWith('R')) at[name.slice(0, -1) + 'L'] = m.vert(-x, y - dy, z);
  }
  const v = m.verts;
  const add = (names, col, glow) => {
    const [a, b, c] = names.map((n) => at[n]);
    const ax = v[a * 3], ay = v[a * 3 + 1], az = v[a * 3 + 2];
    const e1 = [v[b * 3] - ax, v[b * 3 + 1] - ay, v[b * 3 + 2] - az];
    const e2 = [v[c * 3] - ax, v[c * 3 + 1] - ay, v[c * 3 + 2] - az];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const lit = Math.abs((n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]) / len);
    const k = ((hash2(m.faces.length, seed) & 255) / 255 - 0.5) * 2 * MOTTLE;
    // A facet that makes its own light keeps its colour: it is not shaded
    // here, and the renderer does not dim it for the evening either.
    if (glow) m.faces.push({ idx: [a, b, c], col, glow: true });
    else m.face([a, b, c], shade(col, (SHADE_FLOOR + SHADE_RANGE * lit) * (1 + k)));
  };
  for (const [names, col, both, glow] of tris) {
    add(names, col, glow);
    // ... and its twin on the other side, if it has one.
    if (both) add(names.map((n) => (n.endsWith('R') ? n.slice(0, -1) + 'L' : n)), col, glow);
  }
  m.grain = GRAIN;
  return m;
}

// --- the body --------------------------------------------------------------
//
// Rings of points from beak to tail -- the base of the beak, the head, the
// neck, the shoulders, the hips -- joined by folds and closed at the vent.
const BODY_P = {
  beak: [0, -0.33, 0.64],
  billTop: [0, -0.47, 0.46], billR: [0.045, -0.39, 0.46], billUnder: [0, -0.33, 0.47],
  crown: [0, -0.55, 0.34], cheekR: [0.115, -0.43, 0.32], chin: [0, -0.30, 0.36],
  crestR: [0.05, -0.51, 0.25],
  nape: [0, -0.44, 0.17], neckR: [0.11, -0.26, 0.18], throat: [0, -0.10, 0.26],
  back: [0, -0.20, -0.02], shoulderR: [0.17, -0.05, -0.02], keel: [0, 0.17, 0.06],
  rump: [0, -0.12, -0.28], hipR: [0.10, 0.02, -0.26], belly: [0, 0.14, -0.16],
  vent: [0, -0.02, -0.36],
  thighR: [0.06, 0.12, -0.12], kneeR: [0.06, 0.13, -0.02], ankleR: [0.07, 0.30, -0.03],
  talonAR: [0.03, 0.37, 0.06], talonBR: [0.11, 0.37, 0.05], talonCR: [0.07, 0.36, -0.09],
};
const BODY_T = [
  // The beak, folded along its top and bottom, hooked at the tip.
  [['beak', 'billTop', 'billR'], PALE, true],
  [['beak', 'billR', 'billUnder'], GOLD, true],
  // The base of the beak to the head.
  [['billTop', 'crown', 'cheekR'], FLAME, true],
  [['billTop', 'cheekR', 'billR'], AMBER, true],
  [['billR', 'cheekR', 'chin'], AMBER, true],
  [['billR', 'chin', 'billUnder'], GOLD, true],
  [['crown', 'crestR', 'cheekR'], FLAME, true],
  [['crestR', 'nape', 'cheekR'], RUST, true],
  // Head to neck.
  [['cheekR', 'nape', 'neckR'], FLAME, true],
  [['cheekR', 'neckR', 'throat'], AMBER, true],
  [['cheekR', 'throat', 'chin'], GOLD, true],
  // Neck to shoulders.
  [['nape', 'back', 'shoulderR'], RUST, true],
  [['nape', 'shoulderR', 'neckR'], FLAME, true],
  [['neckR', 'shoulderR', 'keel'], AMBER, true],
  [['neckR', 'keel', 'throat'], GOLD, true],
  // Shoulders to hips.
  [['back', 'rump', 'hipR'], RUST, true],
  [['back', 'hipR', 'shoulderR'], FLAME, true],
  [['shoulderR', 'hipR', 'belly'], AMBER, true],
  [['shoulderR', 'belly', 'keel'], FLAME, true],
  // Closed at the vent.
  [['rump', 'vent', 'hipR'], EMBER, true],
  [['hipR', 'vent', 'belly'], RUST, true],
  // The legs, hanging, and their talons.
  [['thighR', 'kneeR', 'ankleR'], EMBER, true],
  [['ankleR', 'talonAR', 'talonBR'], RUST, true],
  [['ankleR', 'talonBR', 'talonCR'], EMBER, true],
];

// The tail: five tongues of flame from the vent, fanned, each drooping and
// then curling up at its tip, and each folded down its length so the two
// halves take the light differently. Written out point by point, as the rest
// is, by a function rather than by hand.
function tongue(name, spread, reach, side) {
  const R = side ? 'R' : '';
  const line = [
    [spread * 0.06, -0.06, -0.32, 0.06],
    [spread * 0.28, 0.08, -0.32 - 0.30 * reach, 0.09],
    [spread * 0.50, 0.16, -0.32 - 0.62 * reach, 0.07],
    [spread * 0.66, 0.02, -0.32 - 0.90 * reach, 0],
  ];
  const cols = [RUST, FLAME, AMBER];
  line.forEach(([x, y, z, w], j) => {
    BODY_P[`${name}c${j}${R}`] = [x, y - 0.03, z];                 // the fold, raised
    if (w) {
      BODY_P[`${name}a${j}${R}`] = [x - w, y + 0.01, z];
      BODY_P[`${name}b${j}${R}`] = [x + w, y + 0.01, z];
    }
  });
  const both = !!side;
  for (let j = 0; j < 2; j++) {
    const n = (k, e) => `${name}${k}${e}${R}`;
    BODY_T.push([[n('a', j), n('a', j + 1), n('c', j)], cols[j], both]);
    BODY_T.push([[n('c', j), n('a', j + 1), n('c', j + 1)], cols[j + 1], both]);
    BODY_T.push([[n('c', j), n('c', j + 1), n('b', j + 1)], cols[j], both]);
    BODY_T.push([[n('c', j), n('b', j + 1), n('b', j)], cols[j + 1], both]);
  }
  const n = (k, e) => `${name}${k}${e}${R}`;
  // The tip burns: lit from within, so it glows after dark.
  BODY_T.push([[n('a', 2), n('c', 3), n('c', 2)], EMBERGLOW_A, both, true]);
  BODY_T.push([[n('c', 2), n('c', 3), n('b', 2)], EMBERGLOW_B, both, true]);
}
// The eyes, laid flat on the face just behind the beak -- in the plane of
// that facet and a hair proud of it, so they are there from the side and
// the front and gone from behind, as a bird's are. (Standing out from the
// head, they read from the chase camera as a crawfish's, on stalks.)
{
  const [A, B, C] = [BODY_P.billTop, BODY_P.cheekR, BODY_P.crown];
  const e1 = A.map((v, i) => B[i] - v), e2 = A.map((v, i) => C[i] - v);
  let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const l = Math.hypot(...n);
  n = n.map((v) => v / l);
  if (n[0] < 0) n = n.map((v) => -v);                          // outward, to the right
  const on = (a, b, c) => A.map((v, i) => v * a + B[i] * b + C[i] * c + n[i] * 0.004);
  BODY_P.eyeAR = on(0.30, 0.46, 0.24);
  BODY_P.eyeBR = on(0.18, 0.44, 0.38);
  BODY_P.eyeCR = on(0.20, 0.60, 0.20);
  BODY_T.push([['eyeAR', 'eyeBR', 'eyeCR'], INK, true]);
}

// The crest: three feathers swept back along the top of the head, each
// folded down its middle into a shallow V, so it has width from every side
// rather than being a blade that is a line from behind.
function plume(name, front, back, tip, col) {
  const mid = front.map((v, i) => (v + back[i]) / 2);
  const flare = mid.map((v, i) => v + (tip[i] - v) * 0.4);
  BODY_P[name + 'f'] = front;
  BODY_P[name + 'b'] = back;
  BODY_P[name + 't'] = tip;
  BODY_P[name + 'R'] = [flare[0] + 0.04, flare[1] + 0.015, flare[2]];
  BODY_T.push([[name + 'f', name + 't', name + 'R'], col, true]);
  BODY_T.push([[name + 'R', name + 't', name + 'b'], col === RUST ? EMBER : RUST, true]);
}
{
  const lerp = (p, q, t) => p.map((v, i) => v + (q[i] - v) * t);
  const top = lerp(BODY_P.crown, BODY_P.nape, 0.5);
  plume('plumeA', BODY_P.crown, top, [0, -0.76, 0.16], FLAME);
  plume('plumeB', top, BODY_P.nape, [0, -0.68, 0.01], RUST);
  plume('plumeC', BODY_P.nape, lerp(BODY_P.nape, BODY_P.back, 0.35), [0, -0.57, -0.12], FLAME);
}

tongue('t0', 0, 1.25, false);
tongue('t1', 0.55, 1.05, true);
tongue('t2', 1.15, 0.85, true);

// --- the wings -------------------------------------------------------------
//
// One sheet each, about its own shoulder, raised in a V -- the top of the
// stroke, which is what the beat below swings about. The arm is folded once
// across the middle. The hand is six flight feathers fanned from the
// wrist, from nearly straight up to straight out, each creased down its rib,
// with the paper between them cut back to a notch;
// three shorter ones run back along the trailing edge to the body. The back
// edge hangs lower than the front, as a bird holds a wing, which is also
// what gives it area seen from the chase camera behind.
const WING_P = {
  root: [0, 0, 0.12],
  rootBack: [0, 0.10, -0.18],
  fold: [0.15, -0.10, -0.04],
  wrist: [0.30, -0.30, 0.06],
  elbow: [0.32, 0.0, -0.20],
};
const WING_T = [
  [['root', 'wrist', 'fold'], FLAME],
  [['wrist', 'elbow', 'fold'], RUST],
  [['elbow', 'rootBack', 'fold'], FLAME],
  [['rootBack', 'root', 'fold'], RUST],
];
{
  const lerp = (p, q, t) => p.map((v, i) => v + (q[i] - v) * t);
  const W = WING_P.wrist;
  // The flight feathers, fanned from the wrist: from nearly straight up to
  // straight out, longest first.
  const N = 6;
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    const ang = 1.35 - 1.42 * t;
    const len = 0.52 - 0.16 * t;
    WING_P['tip' + k] = [W[0] + Math.cos(ang) * len, W[1] - Math.sin(ang) * len, W[2] - 0.10 - 0.12 * t];
  }
  // ... and the paper between each pair, cut back to a notch, so the hand is
  // one sheet with a feathered edge. Each feather is creased down its rib:
  // the two halves either side of a tip take the light differently.
  for (let k = 0; k + 1 < N; k++) {
    const edge = lerp(WING_P['tip' + k], WING_P['tip' + (k + 1)], 0.5);
    WING_P['notch' + k] = lerp(W, edge, 0.72);
    WING_T.push([['wrist', 'tip' + k, 'notch' + k], k % 2 ? AMBER : GOLD]);
    WING_T.push([['wrist', 'notch' + k, 'tip' + (k + 1)], k % 2 ? FLAME : AMBER]);
  }
  // Closed back to the elbow.
  WING_T.push([['wrist', 'tip' + (N - 1), 'elbow'], FLAME]);
  // Shorter feathers back along the trailing edge, from the elbow to the body.
  const M = 3;
  for (let k = 0; k <= M; k++) WING_P['back' + k] = lerp(WING_P.elbow, WING_P.rootBack, k / M);
  for (let k = 0; k < M; k++) {
    const mid = lerp(WING_P['back' + k], WING_P['back' + (k + 1)], 0.5);
    WING_P['aft' + k] = [mid[0] + 0.04, mid[1] + 0.12, mid[2] - 0.22];
    WING_T.push([['back' + k, 'aft' + k, 'back' + (k + 1)], k % 2 ? RUST : FLAME]);
  }
}
const mirror = (pts) => Object.fromEntries(
  Object.entries(pts).map(([k, [x, y, z]]) => [k, [-x, y, z]]));

// Its lowest point is set on exactly the height the flight model lands on:
// otherwise the bird stands buried to the belly or hovering over the ground.
const LOWEST = Math.max(...Object.values(BODY_P).map((p) => p[1]));
const LIFT = LOWEST - UNDERCARRIAGE_Y / TILE;

// The shoulders, on the back either side, already lifted.
const SHOULDER_A = [-0.10, -0.14 - LIFT, 0.04];
const SHOULDER_B = [0.10, -0.14 - LIFT, 0.04];

export const ORIGAMI_BODY = build(BODY_P, BODY_T, LIFT, 1);
const WING_A = build(mirror(WING_P), WING_T, 0, 2);
const WING_B = build(WING_P, WING_T, 0, 3);

// The two wings, each with the shoulder it turns about and the sign that
// makes a rotation about the craft's forward axis take it downwards.
export const WINGS = [
  { model: WING_A, at: SHOULDER_A, side: Math.sign(SHOULDER_A[0]) || 1 },
  { model: WING_B, at: SHOULDER_B, side: Math.sign(SHOULDER_B[0]) || -1 },
];

// --- the beat --------------------------------------------------------------
//
// A bird's wings are the reason it can hold station, so they run off
// the same phase the rotors did and the stroke deepens with the power. The
// model's own pose already has them raised in a V, so this swings about that
// rather than about level: the top of the stroke is where the paper was
// folded, and the bottom is a right angle below it.
const BEAT_IDLE = 0.14;
const BEAT_POWER = 0.70;
const BEAT_EASE = 0.08;

// Folded away on the ground, because a bird standing about with its wings
// out has just been startled. Up over the back and swept back along it.
const FOLD_RISE = -0.30;
const FOLD_SWEEP = 0.95;
const FOLD_EASE = 0.06;

let beat = BEAT_IDLE;
let fold = 0;

const flapMat = new Float64Array(9);
const sweepMat = new Float64Array(9);
const poseMat = new Float64Array(9);
const wingMat = new Float64Array(9);

export function drawOrigami(rd, p, camX, camY, camZ) {
  const want = p.thrusting === 2 ? BEAT_POWER
             : p.thrusting === 1 ? (BEAT_IDLE + BEAT_POWER) / 2
             : BEAT_IDLE;
  beat += (want - beat) * BEAT_EASE;
  fold += ((p.landed ? 1 : 0) - fold) * FOLD_EASE;

  // On the GPU where the scenery goes there (see ModelPass.drawTurned): the
  // body clears the depth and the wings are tested against it, so the bird
  // sorts its own faces without anything being sorted by hand. Otherwise,
  // and for WebGL 1 or ?cpumodels, drawModel as before.
  const gpu = rd.instancer;
  // Whether the depth still needs clearing before the next GPU piece.
  let fresh = true;
  if (gpu && gpu.drawTurned(ORIGAMI_BODY, p.matrix,
        (p.x - camX) | 0, (p.y - camY) | 0, (p.z - camZ) | 0, fresh)) {
    fresh = false;
  } else {
    drawModel(rd, ORIGAMI_BODY, p.matrix, p.x, p.y, p.z, camX, camY, camZ);
  }

  const angle = Math.sin(p.rotorSpin || 0) * beat * (1 - fold) + FOLD_RISE * fold;
  const sweep = FOLD_SWEEP * fold;

  for (const wing of WINGS) {
    const off = matApply(p.matrix,
      wing.at[0] * TILE, wing.at[1] * TILE, wing.at[2] * TILE);
    const wx = (p.x + off[0]) | 0;
    const wy = (p.y + off[1]) | 0;
    const wz = (p.z + off[2]) | 0;

    matRotY(sweep * wing.side, sweepMat);
    matRotZ(angle * wing.side, flapMat);
    matMul(flapMat, sweepMat, poseMat);
    matMul(p.matrix, poseMat, wingMat);
    if (gpu && gpu.drawTurned(wing.model, wingMat,
          (wx - camX) | 0, (wy - camY) | 0, (wz - camZ) | 0, fresh)) {
      fresh = false;
    } else {
      drawModel(rd, wing.model, wingMat, wx, wy, wz, camX, camY, camZ);
    }
  }
}
