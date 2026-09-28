// origami.js -- the paper phoenix, and how it flies.
//
// Folded rather than modelled: every piece is a flat facet of paper, all of
// it in the oranges of a fire -- ember, rust, flame, amber, gold. A hooked
// beak; a neck that rises to the head; wings raised in a V, each an arm
// folded once and a hand cut into six long flight feathers with three
// shorter ones behind. No eyes, no crest and no legs: a shape of fire, not
// a creature with a face. And the fire itself: a tail of up to six tongues
// of flame, each drooping and then curling up at its tip -- lit from within,
// see-through towards their tips, and flickering.
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

import { TILE, matMul, matRotY, matRotZ, matApply, hash2, rnd } from './maths.js';
import { Model, LIGHT, shade, drawModel } from './model.js';
import { UNDERCARRIAGE_Y } from './landscape.js';
import { spawnEmber } from './particles.js';

// --- the paper -------------------------------------------------------------

const EMBER = [178, 52, 14];
const RUST = [206, 76, 18];
const FLAME = [232, 108, 28];
const AMBER = [244, 142, 48];
const GOLD = [250, 180, 80];
const PALE = [252, 208, 126];
const INK = [40, 18, 12];
// The one mark that is not fire: the beak in dark slate, so it reads apart
// from the head.
const SLATE = [58, 54, 66];
const OBSIDIAN = [34, 30, 40];

// The heat, from the core out: white-yellow in the chest, a saturated orange
// through the body and the wings, a deep ember at the feather tips and the
// ends of the tail. Every corner takes the colour for its distance from the
// middle of the bird, blended with its facet's own paper colour.
const HEAT_CORE = [255, 247, 194];
const HEAT_MID = [255, 107, 0];
const HEAT_TIP = [138, 18, 0];
const CORE = [0, -0.06, 0.06];            // the middle of the chest, in body space
const HEAT_MIX = 0.7;                     // how much of a corner is heat, not paper
function heatAt(d) {
  const a = Math.min(1, d / 0.38), b = Math.max(0, Math.min(1, (d - 0.38) / 0.62));
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = d < 0.38 ? HEAT_CORE[i] + (HEAT_MID[i] - HEAT_CORE[i]) * a
                      : HEAT_MID[i] + (HEAT_TIP[i] - HEAT_MID[i]) * b;
  }
  return out;
}
// Underneath is in its own shadow: a body facet facing down is darker, which
// is what gives the bird volume under a light that is otherwise even.
const UNDERSIDE = 0.82;


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
function build(points, tris, dy, seed, alpha, lit = false, heatFrom = null) {
  const m = new Model();
  const at = {};
  for (const [name, [x, y, z]] of Object.entries(points)) {
    at[name] = m.vert(x, y - dy, z);
    if (name.endsWith('R')) at[name.slice(0, -1) + 'L'] = m.vert(-x, y - dy, z);
  }
  const v = m.verts;
  // The middle of the piece, for telling which way is out (see UNDERSIDE).
  let mx = 0, my = 0, mz = 0;
  const nv = v.length / 3;
  for (let i = 0; i < nv; i++) { mx += v[i * 3]; my += v[i * 3 + 1]; mz += v[i * 3 + 2]; }
  mx /= nv; my /= nv; mz /= nv;
  // A left-hand name written out explicitly reads its right-hand twin's
  // alpha and heat: the two are the same distance from everything.
  const key = (nm) => (points[nm] ? nm : nm.slice(0, -1) + 'R');
  const add = (names, col, glow, from) => {
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
    const lit_ = Math.abs((n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]) / len);
    const k = ((hash2(m.faces.length, seed) & 255) / 255 - 0.5) * 2 * MOTTLE;
    // A mark (the beak) keeps its own colour and is solid.
    if (glow === 'mark') {
      m.faces.push({ idx: [a, b, c], col, glow: true, alpha: [1, 1, 1] });
      return;
    }
    if (alpha) {
      // Fire: lit from within, and see-through by how far out along it each
      // corner is (the twin's corners read the same as its own). Paper that
      // has caught keeps its folds' shading, so it still reads as folded.
      let f = lit ? (SHADE_FLOOR + SHADE_RANGE * lit_) * (1 + k) : 1 + k * 0.5;
      // Facing down, out of the piece: in its own shadow.
      const cx = (ax + v[b * 3] + v[c * 3]) / 3 - mx;
      const cy = (ay + v[b * 3 + 1] + v[c * 3 + 1]) / 3 - my;
      const cz = (az + v[b * 3 + 2] + v[c * 3 + 2]) / 3 - mz;
      const outward = n[0] * cx + n[1] * cy + n[2] * cz >= 0 ? 1 : -1;
      if (lit === 'shell' && (n[1] * outward) / len > 0.35) f *= UNDERSIDE;
      const face = {
        idx: [a, b, c], col: shade(col, f), glow: true,
        alpha: from.map((nm) => (typeof alpha === 'function' ? alpha(points[key(nm)]) : alpha[key(nm)])),
      };
      if (heatFrom) {
        // Each corner its own heat, by how far it is from the core. A twin's
        // corners are the same distance out as its own.
        face.cols = from.map((nm) => {
          const p = points[key(nm)];
          const d = Math.hypot(p[0] + heatFrom[0] - CORE[0], p[1] + heatFrom[1] - CORE[1],
                               p[2] + heatFrom[2] - CORE[2]);
          const h = heatAt(d);
          return shade(h.map((hv, j) => hv * HEAT_MIX + col[j] * (1 - HEAT_MIX)), f);
        });
        face.col = [0, 1, 2].map((j) =>
          Math.round((face.cols[0][j] + face.cols[1][j] + face.cols[2][j]) / 3));
      }
      m.faces.push(face);
    } else if (glow) {
      // A facet that makes its own light keeps its colour: it is not shaded
      // here, and the renderer does not dim it for the evening either.
      m.faces.push({ idx: [a, b, c], col, glow: true });
    } else {
      m.face([a, b, c], shade(col, (SHADE_FLOOR + SHADE_RANGE * lit_) * (1 + k)));
    }
  };
  for (const [names, col, both, glow] of tris) {
    add(names, col, glow, names);
    // ... and its twin on the other side, if it has one.
    if (both) add(names.map((n) => (n.endsWith('R') ? n.slice(0, -1) + 'L' : n)), col, glow, names);
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
  nape: [0, -0.44, 0.17], neckR: [0.13, -0.24, 0.19], throat: [0, -0.07, 0.30],
  back: [0, -0.20, -0.02], shoulderR: [0.18, -0.05, -0.02], keel: [0, 0.20, 0.14],
  rump: [0, -0.12, -0.28], hipR: [0.10, 0.02, -0.26], belly: [0, 0.14, -0.16],
  vent: [0, -0.02, -0.36],
};
const BODY_T = [
  // The beak, folded along its top and bottom, hooked at the tip.
  [['beak', 'billTop', 'billR'], SLATE, true, 'mark'],
  [['beak', 'billR', 'billUnder'], OBSIDIAN, true, 'mark'],
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
];

// --- the fire --------------------------------------------------------------
//
// The tail is not paper but flame: a piece of their own, drawn
// after the rest of the bird, every facet lit from within so the evening does
// not dim it, and see-through -- nearly solid at the root, a wisp at the tip.
// On the GPU it also flickers (see modelpass.js); the CPU path draws it as a
// steady translucent glow.
const FIRE_ROOT = [238, 92, 22];
const FIRE_MID = [250, 136, 36];
const FIRE_HOT = [255, 176, 64];
const FIRE_TIP = [255, 214, 120];
const FLAME_P = {};
const FLAME_A = {};           // how solid each point is, 0 to 1

// The tail: five tongues of flame from the vent, fanned, each drooping and
// then curling up at its tip, and each folded down its length so the two
// halves take the light differently.
// `rise` lifts a tongue above the others, for the long one down the middle.
function tongue(name, spread, reach, side, rise = 0) {
  const R = side ? 'R' : '';
  const line = [
    [spread * 0.06, -0.06, -0.32, 0.06, 0.92],
    [spread * 0.28, 0.08 - rise * 0.6, -0.32 - 0.30 * reach, 0.09, 0.78],
    [spread * 0.50, 0.16 - rise, -0.32 - 0.62 * reach, 0.07, 0.55],
    [spread * 0.66, 0.02 - rise * 1.3, -0.32 - 0.90 * reach, 0, 0.16],
  ];
  const cols = [FIRE_ROOT, FIRE_MID, FIRE_HOT];
  line.forEach(([x, y, z, w, a], j) => {
    const put = (k, p) => { FLAME_P[`${name}${k}${j}${R}`] = p; FLAME_A[`${name}${k}${j}${R}`] = a; };
    put('c', [x, y - 0.03, z]);                                     // the fold, raised
    if (w) {
      put('a', [x - w, y + 0.01, z]);
      put('b', [x + w, y + 0.01, z]);
    }
  });
  // Its faces, as a list of their own: the tail grows a tongue at a time
  // (see setFireLevel), so each one -- and each side of a pair -- has to be
  // separable. A side tongue is written on the right and copied to the left.
  const n = (k, e) => `${name}${k}${e}${R}`;
  const faces = [];
  for (let j = 0; j < 2; j++) {
    faces.push([[n('a', j), n('a', j + 1), n('c', j)], cols[j]]);
    faces.push([[n('c', j), n('a', j + 1), n('c', j + 1)], cols[j + 1]]);
    faces.push([[n('c', j), n('c', j + 1), n('b', j + 1)], cols[j]]);
    faces.push([[n('c', j), n('b', j + 1), n('b', j)], cols[j + 1]]);
  }
  faces.push([[n('a', 2), n('c', 3), n('c', 2)], FIRE_TIP]);
  faces.push([[n('c', 2), n('c', 3), n('b', 2)], FIRE_HOT]);
  TONGUES.push(faces);
  if (side) {
    TONGUES.push(faces.map(([names, col]) =>
      [names.map((nm) => (nm.endsWith('R') ? nm.slice(0, -1) + 'L' : nm)), col]));
  }
}
const TONGUES = [];

tongue('t0', 0, 1.25, false);
tongue('t1', 0.55, 1.05, true);
tongue('t2', 1.15, 0.85, true);
// The sixth, and last: a long one straight back over the middle one,
// curling higher -- the finishing plume of the whole bird.
tongue('t3', 0, 1.6, false, 0.12);

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
  // Coverts: a second, shorter tier of feathers laid along the top of the
  // wing from the shoulder to the wrist, standing just proud of the sheet,
  // so the wing is layered rather than one flat fan -- which is what gives
  // it depth seen straight from behind or in front.
  {
    const R = WING_P.root, Wr = WING_P.wrist, E = WING_P.elbow;
    const e1 = Wr.map((v, i) => v - R[i]), e2 = E.map((v, i) => v - R[i]);
    let nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...nrm);
    nrm = nrm.map((v) => v / l);
    if (nrm[1] > 0) nrm = nrm.map((v) => -v);            // the upper side
    const lift = (p, h) => p.map((v, i) => v + nrm[i] * h);
    const C = 4;
    for (let k = 0; k <= C; k++) WING_P['cov' + k] = lift(lerp(R, Wr, 0.08 + 0.84 * k / C), 0.015);
    for (let k = 0; k < C; k++) {
      const mid = lerp(WING_P['cov' + k], WING_P['cov' + (k + 1)], 0.5);
      const toward = lerp(mid, lerp(E, WING_P.rootBack, 0.5), 0.42);
      WING_P['covTip' + k] = lift([toward[0], toward[1], toward[2] - 0.04], 0.02);
      WING_T.push([['cov' + k, 'covTip' + k, 'cov' + (k + 1)], k % 2 ? AMBER : FLAME]);
    }
  }
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

// The whole bird burns. The body and the wings are paper that has caught:
// lit from within like the fire, see-through -- the body nearly solid, the
// wings thinning towards their feather tips -- and flickering, more gently
// than the tail, so the bird shimmers rather than strobes. `flame`
// is how hard it flickers (see modelpass.js).
const BODY_ALPHA = () => 0.8;
const WING_ALPHA = ([x, y, z]) => 0.86 - 0.52 * Math.min(1, Math.hypot(x, y, z) / 0.6);

// `heatFrom` is where each piece's own origin sits in body space, so its
// corners can be measured from the core; `'shell'` asks for the underside
// shading, which means something for the closed body and nothing for a sheet.
export const ORIGAMI_BODY = build(BODY_P, BODY_T, LIFT, 1, BODY_ALPHA, 'shell', [0, 0, 0]);
ORIGAMI_BODY.flame = 0.4;
// The fire at each stage of the game: a tongue of the tail for each feather
// -- the middle one first, then the pairs either side, one side at a time,
// and the long plume last. Never fewer than one: the bird is always a fire.
export const TAIL_FEATHERS = TONGUES.length;
const FIRE_BY_LEVEL = TONGUES.map((_, i) => {
  const m = build(FLAME_P, TONGUES.slice(0, i + 1).flat(), LIFT, 4, FLAME_A, false, [0, 0, 0]);
  m.flame = 1;
  return m;
});
FIRE_BY_LEVEL.unshift(FIRE_BY_LEVEL[0]);
let fireLevel = TAIL_FEATHERS;
export function setFireLevel(n) {
  fireLevel = Math.max(1, Math.min(TAIL_FEATHERS, n | 0));
}
export const ORIGAMI_FIRE = FIRE_BY_LEVEL[TAIL_FEATHERS];
const WING_A = build(mirror(WING_P), WING_T, 0, 2, WING_ALPHA, true, [-0.10, -0.14, 0.04]);
const WING_B = build(WING_P, WING_T, 0, 3, WING_ALPHA, true, [0.10, -0.14, 0.04]);
WING_A.flame = WING_B.flame = 0.4;

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
  if (gpu && gpu.drawTurned(ORIGAMI_BODY, p.pose,
        (p.x - camX) | 0, (p.y - camY) | 0, (p.z - camZ) | 0, fresh)) {
    fresh = false;
  } else {
    drawModel(rd, ORIGAMI_BODY, p.pose, p.x, p.y, p.z, camX, camY, camZ, 0, 0, BIRD_CPU_FADE);
  }

  const angle = Math.sin(p.rotorSpin || 0) * beat * (1 - fold) + FOLD_RISE * fold;
  const sweep = FOLD_SWEEP * fold;

  for (const wing of WINGS) {
    const off = matApply(p.pose,
      wing.at[0] * TILE, wing.at[1] * TILE, wing.at[2] * TILE);
    const wx = (p.x + off[0]) | 0;
    const wy = (p.y + off[1]) | 0;
    const wz = (p.z + off[2]) | 0;

    matRotY(sweep * wing.side, sweepMat);
    matRotZ(angle * wing.side, flapMat);
    matMul(flapMat, sweepMat, poseMat);
    matMul(p.pose, poseMat, wingMat);
    if (gpu && gpu.drawTurned(wing.model, wingMat,
          (wx - camX) | 0, (wy - camY) | 0, (wz - camZ) | 0, fresh)) {
      fresh = false;
    } else {
      drawModel(rd, wing.model, wingMat, wx, wy, wz, camX, camY, camZ, 0, 0, BIRD_CPU_FADE);
    }
  }

  // The fire last, over the paper, blended.
  const fire = FIRE_BY_LEVEL[fireLevel];
  if (!(gpu && gpu.drawTurned(fire, p.pose,
        (p.x - camX) | 0, (p.y - camY) | 0, (p.z - camZ) | 0, fresh))) {
    drawModel(rd, fire, p.pose, p.x, p.y, p.z, camX, camY, camZ, 0, 0, FIRE_CPU_FADE);
  }
}
// Embers: now and then a spark comes off the tail and drifts up, left behind
// as the bird flies on. A few alive at a time -- enough to say the fire is
// alive, not so many that it smokes. Called from the simulation step.
const EMBER_RATE = 0.09;          // per step
export function shedEmbers(p) {
  if (p.dead || rnd() > EMBER_RATE * (p.landed ? 0.4 : 1)) return;
  // Somewhere along the tail, in the bird's own frame.
  const along = 0.45 + rnd() * 0.65;
  const lx = (rnd() - 0.5) * 0.9 * along, ly = 0.10 - LIFT, lz = -0.32 - along * 0.8;
  const off = matApply(p.pose, lx * TILE, ly * TILE, lz * TILE);
  spawnEmber((p.x + off[0]) | 0, (p.y + off[1]) | 0, (p.z + off[2]) | 0,
    (p.vx * 0.3 + (rnd() - 0.5) * TILE * 0.006) | 0,
    (-TILE * (0.004 + rnd() * 0.006)) | 0,
    (p.vz * 0.3 + (rnd() - 0.5) * TILE * 0.006) | 0);
}

// Without the GPU there is no flicker and no per-corner see-through, so the
// fire is drawn as one steady translucent glow.
const FIRE_CPU_FADE = 0.72;
const BIRD_CPU_FADE = 0.85;
