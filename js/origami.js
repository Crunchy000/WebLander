// origami.js -- the folded-paper bird, and how it flies.
//
// Folded rather than modelled: every piece is a flat facet of paper in one
// flat colour, the way a real one is -- a yellow beak, a red crown and crest,
// orange flanks and a yellow breast, a tail of three feathers, thin legs to
// stand on, and two green wings, each a folded arm and a hand cut into three
// flight feathers. Seventy-six triangles in all.
//
// It replaced a bird decoded from a downloaded model: 546 triangles, whose
// colours had been sampled off a texture, and whose wings had no joints and
// had to be found by where their triangles sat. This one is written here, so
// its shoulders are simply where they were put.
//
// Three pieces, because three things move independently: the body, and a
// wing either side, each built about its own shoulder so it can be turned
// there. Axes are the engine's: +x right, +y DOWN, +z forward (the beak).

import { TILE, matMul, matRotY, matRotZ, matApply } from './maths.js';
import { Model, LIGHT, shade, drawModel } from './model.js';
import { UNDERCARRIAGE_Y } from './landscape.js';

// --- the paper -------------------------------------------------------------

const YELLOW = [250, 212, 24];
const RED = [214, 26, 18];
const SCARLET = [206, 58, 10];
const OCHRE = [202, 124, 4];
const MAROON = [148, 22, 12];
const LEAF = [22, 122, 34];
const PINE = [4, 100, 22];
const LIME = [112, 164, 28];
const INK = [34, 22, 26];
const TWIG = [92, 56, 30];

// Paper has no inside, so a facet is lit by how it is inclined, not which
// way it faces: both sides of a sheet take the same light. Enough of it that
// the folds read as folds, not so much that the colours stop being the
// paper's.
const SHADE_FLOOR = 0.74;
const SHADE_RANGE = 0.36;

// A piece is written as named points and triangles between them, which is
// easier to fold on paper than a table of numbers. A name ending in R has a
// twin ending in L, the same point mirrored across the bird's middle, so each
// side is only written once.
function build(points, tris, dy) {
  const m = new Model();
  const at = {};
  for (const [name, [x, y, z]] of Object.entries(points)) {
    at[name] = m.vert(x, y - dy, z);
    if (name.endsWith('R')) at[name.slice(0, -1) + 'L'] = m.vert(-x, y - dy, z);
  }
  const v = m.verts;
  const add = (names, col) => {
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
    m.face([a, b, c], shade(col, SHADE_FLOOR + SHADE_RANGE * lit));
  };
  for (const [names, col, both] of tris) {
    add(names, col);
    // ... and its twin on the other side, if it has one.
    if (both) add(names.map((n) => (n.endsWith('R') ? n.slice(0, -1) + 'L' : n)), col);
  }
  return m;
}

// --- the body --------------------------------------------------------------
//
// Rings of points from beak to tail -- the base of the beak, the head, the
// neck, the shoulders, the hips -- joined by folds and closed at the rump.
// On top of that: a folded crest, an eye either side, a tail of three
// feathers fanned and raised so it shows from behind, and two thin legs with
// toes, which are what it stands on.
const BODY_P = {
  beak: [0, -0.21, 0.66],
  billTop: [0, -0.30, 0.42], billR: [0.055, -0.22, 0.42], billUnder: [0, -0.15, 0.42],
  crown: [0, -0.41, 0.28], cheekR: [0.115, -0.26, 0.27], chin: [0, -0.10, 0.30],
  crestTip: [0, -0.55, 0.12], crestR: [0.028, -0.43, 0.18],
  eyeAR: [0.113, -0.30, 0.30], eyeBR: [0.118, -0.275, 0.26], eyeCR: [0.110, -0.25, 0.30],
  nape: [0, -0.31, 0.10], neckR: [0.14, -0.14, 0.13], throat: [0, 0.03, 0.22],
  back: [0, -0.21, -0.04], shoulderR: [0.175, -0.05, -0.04], keel: [0, 0.17, 0.04],
  rump: [0, -0.13, -0.28], hipR: [0.10, 0.0, -0.26], belly: [0, 0.13, -0.17],
  vent: [0, -0.03, -0.37],
  fanR: [0.21, -0.35, -0.74], notchR: [0.08, -0.22, -0.64], fan: [0, -0.24, -0.84],
  thighR: [0.05, 0.10, -0.13], kneeR: [0.05, 0.11, -0.03], ankleR: [0.055, 0.27, -0.07],
  toeAR: [0.02, 0.28, 0.05], toeBR: [0.10, 0.28, 0.04],
};
const BODY_T = [
  // The beak, folded along its top and bottom.
  [['beak', 'billTop', 'billR'], YELLOW, true],
  [['beak', 'billR', 'billUnder'], OCHRE, true],
  // The base of the beak to the head.
  [['billTop', 'crown', 'cheekR'], RED, true],
  [['billTop', 'cheekR', 'billR'], SCARLET, true],
  [['billR', 'cheekR', 'chin'], YELLOW, true],
  [['billR', 'chin', 'billUnder'], OCHRE, true],
  // The crest, a single strip of paper folded down its length.
  [['crown', 'crestTip', 'crestR'], RED, true],
  [['crestR', 'crestTip', 'nape'], MAROON, true],
  // The eyes, standing just proud of the cheeks.
  [['eyeAR', 'eyeBR', 'eyeCR'], INK, true],
  // Head to neck.
  [['crown', 'nape', 'neckR'], RED, true],
  [['crown', 'neckR', 'cheekR'], SCARLET, true],
  [['cheekR', 'neckR', 'throat'], OCHRE, true],
  [['cheekR', 'throat', 'chin'], YELLOW, true],
  // Neck to shoulders.
  [['nape', 'back', 'shoulderR'], RED, true],
  [['nape', 'shoulderR', 'neckR'], SCARLET, true],
  [['neckR', 'shoulderR', 'keel'], OCHRE, true],
  [['neckR', 'keel', 'throat'], YELLOW, true],
  // Shoulders to hips.
  [['back', 'rump', 'hipR'], RED, true],
  [['back', 'hipR', 'shoulderR'], SCARLET, true],
  [['shoulderR', 'hipR', 'belly'], OCHRE, true],
  [['shoulderR', 'belly', 'keel'], MAROON, true],
  // The rump, closed.
  [['rump', 'vent', 'hipR'], MAROON, true],
  [['hipR', 'vent', 'belly'], MAROON, true],
  // The tail: three feathers fanned from the rump.
  [['rump', 'fanR', 'notchR'], SCARLET, true],
  [['rump', 'notchR', 'fan'], RED, true],
  // The legs, and the toes they stand on.
  [['thighR', 'kneeR', 'ankleR'], TWIG, true],
  [['ankleR', 'toeAR', 'toeBR'], TWIG, true],
];

// --- the wings -------------------------------------------------------------
//
// One sheet each, about its own shoulder. The inner half -- the arm -- is
// folded once across the middle, light in front and dark behind; the outer
// half -- the hand -- is cut into three flight feathers fanned from the
// wrist, with a lighter one between each. The back edge hangs lower than the
// front, as a bird holds a wing, which is also what gives it some area seen
// from the chase camera behind rather than a sheet seen edge on. The pose is
// the top of the stroke, raised in a V, which is what the beat below swings
// about.
const WING_P = {
  root: [0, 0, 0.14],
  rootBack: [0, 0.10, -0.16],
  fold: [0.15, -0.07, -0.02],
  wrist: [0.30, -0.21, 0.05],
  elbow: [0.25, 0.03, -0.27],
  tip1: [0.62, -0.40, -0.08],
  notch1: [0.47, -0.28, -0.14],
  tip2: [0.56, -0.30, -0.24],
  notch2: [0.41, -0.17, -0.23],
  tip3: [0.45, -0.16, -0.34],
};
const WING_T = [
  [['root', 'wrist', 'fold'], LEAF],
  [['wrist', 'elbow', 'fold'], PINE],
  [['elbow', 'rootBack', 'fold'], LEAF],
  [['rootBack', 'root', 'fold'], PINE],
  [['wrist', 'tip1', 'notch1'], PINE],
  [['wrist', 'notch1', 'tip2'], LIME],
  [['wrist', 'tip2', 'notch2'], PINE],
  [['wrist', 'notch2', 'tip3'], LIME],
  [['wrist', 'tip3', 'elbow'], PINE],
];
const mirror = (pts) => Object.fromEntries(
  Object.entries(pts).map(([k, [x, y, z]]) => [k, [-x, y, z]]));

// Its lowest point is set on exactly the height the flight model lands on:
// otherwise the bird stands buried to the belly or hovering over the ground.
const LOWEST = Math.max(...Object.values(BODY_P).map((p) => p[1]));
const LIFT = LOWEST - UNDERCARRIAGE_Y / TILE;

// The shoulders, on the back either side, already lifted.
const SHOULDER_A = [-0.10, -0.12 - LIFT, 0.04];
const SHOULDER_B = [0.10, -0.12 - LIFT, 0.04];

export const ORIGAMI_BODY = build(BODY_P, BODY_T, LIFT);
const WING_A = build(mirror(WING_P), WING_T, 0);
const WING_B = build(WING_P, WING_T, 0);

// The two wings, each with the shoulder it turns about and the sign that
// makes a rotation about the craft's forward axis take it downwards.
export const WINGS = [
  { model: WING_A, at: SHOULDER_A, side: Math.sign(SHOULDER_A[0]) || 1 },
  { model: WING_B, at: SHOULDER_B, side: Math.sign(SHOULDER_B[0]) || -1 },
];

// --- the beat --------------------------------------------------------------
//
// A hummingbird's wings are the reason it can hold station, so they run off
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
