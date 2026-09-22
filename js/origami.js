// origami.js -- the folded-paper hummingbird, and how it flies.
//
// Everything else in this game is modelled in code, because a model that is
// code can be argued with. This one arrived as a file, so the work was the
// other way round: decode it, throw away everything the renderer cannot use,
// and find the joints it was never given.
//
// What survived the trip:
//
//   The geometry. 546 triangles, welded from 817 loose vertices down to 273
//   positions, turned from Y-up-with-the-beak-at--x into this engine's axes.
//
//   The paint, as a palette. The export carried its colour in a WebP texture
//   and there are no textures here, so each triangle was sampled at its own
//   UVs and reduced to one flat colour. That is not a compromise for a model
//   like this one -- it is a folded paper bird, every facet is one flat tone
//   already, and the sampling just reads the tone off the paper.
//
// What did not survive, and had to be invented: the joints. There is no
// skeleton and no animation in the file, so the wings are found rather than
// named -- every triangle whose centre sits above the back and out to one
// side or the other is that wing -- and each is rebuilt about its own
// shoulder so it can be rotated there. Measured, that is 424 triangles of
// body, 75 of one wing and 47 of the other. The wings are not symmetrical,
// which is what you get from a model somebody folded rather than mirrored.

import { TILE, matMul, matRotY, matRotZ, matApply } from './maths.js';
import { Model, LIGHT, shade, drawModel } from './model.js';
import {
  BODY_V, BODY_F, WING_R_V, WING_R_F, WING_L_V, WING_L_F,
} from './origami-data.js';

// How far the whole bird sits above its own origin, so its lowest point is
// exactly the height the flight model lands on. Without it the bird stands
// buried to the belly or hovering a quarter tile up, and both read as a bug
// rather than as a bird.
import { UNDERCARRIAGE_Y } from './landscape.js';
const LOWEST = 0.6498;
const LIFT = LOWEST - UNDERCARRIAGE_Y / TILE;

// The shoulders, in the engine's units, already lifted. The signs are what
// decides which wing is which: the export's +z side comes out on this
// engine's left.
const SHOULDER_A = [-0.0639, -0.0965 - LIFT, 0.0362];
const SHOULDER_B = [0.0572, -0.1097 - LIFT, 0.0523];

// Build one piece. The colour is the paper's; the shading is this engine's,
// so the bird sits in the same light as the hills behind it.
//
// Both sides of a facet are lit the same, which is why the dot product is
// taken absolute. The material was marked double-sided and the winding that
// came with it is not consistent, so the usual trick -- flip the normal away
// from the model's origin -- gives a wing panel an arbitrary answer. Lighting
// a face by how it is inclined rather than which way it faces is the right
// rule for folded paper anyway: paper has no inside.
// How much of the engine's light to put on top of the paint.
//
// Everything else in this game is shaded hard by its own normal, because
// everything else is bare geometry and the faceting is all the detail there
// is. This one arrives already painted, with its own light baked into the
// texture, and shading it that hard a second time gives a mottled bird --
// two lightings fighting over the same facet. A quarter of the usual range
// keeps it sitting in the world's light without repainting it.
const SHADE_FLOOR = 0.86;
const SHADE_RANGE = 0.20;

function build(verts, faces, lift) {
  const m = new Model();
  for (let i = 0; i < verts.length; i += 3) {
    m.vert(verts[i], verts[i + 1] - lift, verts[i + 2]);
  }
  const v = m.verts;
  for (let i = 0; i < faces.length; i += 6) {
    const a = faces[i], b = faces[i + 1], c = faces[i + 2];
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
    m.face([a, b, c], shade([faces[i + 3], faces[i + 4], faces[i + 5]], SHADE_FLOOR + SHADE_RANGE * lit));
  }
  return m;
}

export const ORIGAMI_BODY = build(BODY_V, BODY_F, LIFT);
const WING_A = build(WING_R_V, WING_R_F, 0);
const WING_B = build(WING_L_V, WING_L_F, 0);

// The two wings, each with the shoulder it turns about and the sign that
// makes a rotation about the craft's forward axis take it downwards.
const WINGS = [
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

  drawModel(rd, ORIGAMI_BODY, p.matrix, p.x, p.y, p.z, camX, camY, camZ);

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
    drawModel(rd, wing.model, wingMat, wx, wy, wz, camX, camY, camZ);
  }
}
