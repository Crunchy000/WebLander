// origami.js -- the folded-paper bird, and how it flies.
//
// Folded rather than modelled: every piece is a flat facet of paper in one
// flat colour, the way a real one is -- a yellow beak, a red crown, orange
// flanks and a yellow breast, a split paper tail, and two green wings, each
// a single sheet with one crease across it so it catches the light in two
// tones. Thirty-two triangles in all.
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

// Paper has no inside, so a facet is lit by how it is inclined, not which
// way it faces: both sides of a sheet take the same light. Enough of it that
// the folds read as folds, not so much that the colours stop being the
// paper's.
const SHADE_FLOOR = 0.74;
const SHADE_RANGE = 0.36;

function build(points, faces, dy) {
  const m = new Model();
  for (const [x, y, z] of points) m.vert(x, y - dy, z);
  const v = m.verts;
  for (const [a, b, c, col] of faces) {
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
  }
  return m;
}

// --- the body --------------------------------------------------------------
//
// Four rings of points from beak to tail -- the head, the shoulders, the
// hips -- joined by folds, closed at the back, with the tail as two loose
// flaps of paper off the rump, raised in a V so it shows from behind.
const BODY_P = [
  [0, -0.20, 0.62],       // 0  beak tip
  [0, -0.38, 0.30],       // 1  crown
  [0.09, -0.22, 0.30],    // 2  right cheek
  [0, -0.08, 0.34],       // 3  throat
  [-0.09, -0.22, 0.30],   // 4  left cheek
  [0, -0.18, 0.02],       // 5  back
  [0.16, -0.02, 0.0],     // 6  right flank
  [0, 0.14, 0.10],        // 7  breast
  [-0.16, -0.02, 0.0],    // 8  left flank
  [0, -0.08, -0.30],      // 9  rump
  [0.07, -0.02, -0.28],   // 10 right hip
  [0, 0.10, -0.20],       // 11 belly
  [-0.07, -0.02, -0.28],  // 12 left hip
  [0.18, -0.30, -0.66],   // 13 tail, right tip
  [0, -0.16, -0.54],      // 14 tail, notch
  [-0.18, -0.30, -0.66],  // 15 tail, left tip
];
const BODY_T = [
  // The beak, folded along its top and bottom.
  [0, 1, 2, YELLOW], [0, 4, 1, YELLOW], [0, 2, 3, OCHRE], [0, 3, 4, OCHRE],
  // Head to shoulders.
  [1, 5, 6, RED], [1, 6, 2, SCARLET], [1, 8, 5, RED], [1, 4, 8, SCARLET],
  [2, 6, 7, OCHRE], [2, 7, 3, YELLOW], [4, 3, 7, YELLOW], [4, 7, 8, OCHRE],
  // Shoulders to hips.
  [5, 10, 6, SCARLET], [5, 9, 10, RED], [5, 8, 12, SCARLET], [5, 12, 9, RED],
  [6, 10, 11, OCHRE], [6, 11, 7, MAROON], [8, 7, 11, MAROON], [8, 11, 12, OCHRE],
  // The rump, closed.
  [9, 11, 10, MAROON], [9, 12, 11, MAROON],
  // The tail.
  [9, 13, 14, RED], [9, 14, 15, SCARLET],
];

// --- the wings -------------------------------------------------------------
//
// One sheet each, about its own shoulder: a root along the back, a tip out
// and up, and a crease from the root to the tip that the sheet is folded on,
// light in front of the fold and dark behind. The back edge hangs lower than
// the front, as a bird holds a wing, which is also what gives it some area
// seen from the chase camera behind rather than a sheet seen edge on. The
// pose is the top of the stroke, raised in a V, which is what the beat below
// swings about.
const WING_P = [
  [0, 0, 0.14],           // 0  root, front
  [0, 0.10, -0.16],       // 1  root, back
  [0.30, -0.20, -0.02],   // 2  on the crease
  [0.56, -0.36, -0.16],   // 3  tip
  [0.26, 0.04, -0.30],    // 4  trailing edge
];
const WING_T = [
  [0, 2, 1, LEAF], [0, 3, 2, LEAF],
  [1, 2, 4, PINE], [2, 3, 4, PINE],
];
const mirror = (pts) => pts.map(([x, y, z]) => [-x, y, z]);

// Its lowest point is set on exactly the height the flight model lands on:
// otherwise the bird stands buried to the belly or hovering over the ground.
const LOWEST = Math.max(...BODY_P.map((p) => p[1]));
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
