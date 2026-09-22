// bird.js -- a hoverbird, as a third airframe.
//
// The flight model is the whole reason this works. The craft flies by tilting
// its body and pushing along its own up axis, which is what a quadrotor does
// and also, near enough, what a hovering bird does: a hummingbird at a flower
// or a kestrel on a windy ridge holds itself up on a beating wing and tips
// its whole body to go anywhere. Nothing in player.js had to change.
//
// Two facts about this game decide how it is built.
//
// The camera rides fifteen tiles behind and never rotates, so what you spend
// the flight looking at is the back of the thing and the tail behind it. A
// bird whose character is all in its face is a bird you will never see, so
// the character is in the tail: five long feathers carrying the only warm
// colour on the airframe, fanned where they cannot be missed.
//
// And there is no depth buffer, so every part is a separate model drawn in a
// fixed order -- body, then tail, then wings. That is the right order from
// behind: the tail is nearer the camera than the body it hangs off, and a
// wing on the upstroke crosses over the back rather than under it.

import { TILE, matMul, matRotY, matRotZ, matApply } from './maths.js';
import { Model, facet, shade, drawModel } from './model.js';
import { sky } from './daylight.js';

// --- palette ---------------------------------------------------------------
//
// The drone went bone white for a reason that has not changed: with the
// blocks muted, the rocks sanded down and the foreground going to silhouette,
// a saturated machine was the only loud thing left in the world and it took
// your eye off the landscape. A phoenix is a saturated idea, so it is spent
// where it buys the most and costs the least -- the crest, the primaries and
// the tail, which is to say the outline -- and the body stays the same bone
// white the drone had.
//
// The embers are also the night light. After dark they come up on their own
// (see EMBER_GLOW below), so the bird does not need navigation lamps bolted
// to it the way the drone did: what tells you which way it is pointing after
// dark is that its tail is glowing and its face is not.
const BODY_A  = [240, 236, 226];
const BODY_B  = [220, 214, 202];
const BODY_C  = [198, 192, 180];
const BELLY   = [ 92,  86,  80];   // warm charcoal, so it reads against snow
const BEAK    = [232, 178,  96];
const EYE     = [ 46,  44,  48];
const CREST   = [232, 132,  58];
const CREST_T = [248, 196, 104];
const COVERT  = [234, 228, 216];   // the pale part of the wing
const COVERT_U= [176, 170, 160];   // ... and its underside
const ARM     = [214, 208, 196];
const PRIM    = [216, 120,  60];   // primaries: ember
const PRIM_T  = [242, 168,  84];
const TAIL_A  = [206, 104,  54];
const TAIL_B  = [232, 142,  68];
const TAIL_C  = [248, 200, 112];   // the centre pair, brightest
const LEG     = [178, 152, 114];
const FOOT    = [148, 124,  92];

// --- layout ----------------------------------------------------------------

// Overall size. Everything below is in unscaled units and passes through
// here, so the whole bird resizes from one number.
const SCALE = 0.86;

// Where the feet sit: exactly the undercarriage height the flight model
// lands on, so the bird stands on the ground rather than in it or above it.
const STANCE = 0.39 / SCALE;

// The shoulder, which is both where a wing is drawn and what it pivots about.
const SHOULDER = [0.17, -0.09, 0.08];

function boxFaces(m, v, x0, y0, z0, x1, y1, z1, col, top = col) {
  const q = [
    v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1),
    v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1),
  ];
  m.face([q[0], q[1], q[2], q[3]], top);
  m.face([q[4], q[5], q[6], q[7]], shade(col, 0.72));
  m.face([q[0], q[1], q[5], q[4]], shade(col, 0.88));
  m.face([q[3], q[2], q[6], q[7]], shade(col, 0.96));
  m.face([q[1], q[2], q[6], q[5]], col);
  m.face([q[0], q[3], q[7], q[4]], col);
}

// --- the body --------------------------------------------------------------
//
// A spindle: one ring of eight at the chest, drawn forward to a point at the
// base of the neck and back to a point at the root of the tail. Eight facets
// each way, which is enough that it reads as round and few enough that every
// one of them catches the light differently.
function buildBody() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * SCALE, y * SCALE, z * SCALE);

  const RX = 0.25, RY = 0.225, RZ = 0.02;
  const ring = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    ring.push(v(Math.cos(a) * RX, Math.sin(a) * RY, RZ));
  }
  const neck = v(0.00, -0.07, 0.42);
  const rump = v(0.00, -0.05, -0.44);

  const tone = [BODY_A, BODY_B, BODY_C, BODY_B, BODY_A, BODY_B, BODY_C, BODY_B];
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    // Anything on the underside is belly. Sin is positive downwards here.
    const under = Math.sin(a + Math.PI / 8) > 0.35;
    facet(m, [ring[i], ring[j], neck], under ? BELLY : tone[i]);
    facet(m, [ring[j], ring[i], rump], under ? BELLY : shade(tone[i], 0.94));
  }

  // The head, on the end of a short neck: a second, much smaller spindle.
  const HR = 0.105;
  const head = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    head.push(v(Math.cos(a) * HR, -0.10 + Math.sin(a) * HR, 0.50));
  }
  const brow = v(0.00, -0.11, 0.62);
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    facet(m, [head[i], head[j], brow], i % 2 ? BODY_A : BODY_B);
    facet(m, [head[j], head[i], neck], BODY_B);
  }

  // A beak, which is four flat faces off a short ring. Small: the camera is
  // behind, so this is for the moments the bird banks hard enough to show a
  // profile, and a big beak on a machine you mostly see from behind is just
  // weight at the wrong end.
  const b = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.push(v(Math.cos(a) * 0.045, -0.095 + Math.sin(a) * 0.04, 0.59));
  }
  const tip = v(0.00, -0.085, 0.78);
  for (let i = 0; i < 4; i++) facet(m, [b[i], b[(i + 1) % 4], tip], BEAK);

  // Eyes, one facet each. At this size an eye is a dark triangle and that is
  // all it needs to be.
  for (const s of [1, -1]) {
    facet(m, [v(s * 0.075, -0.155, 0.505), v(s * 0.105, -0.115, 0.535),
              v(s * 0.070, -0.100, 0.495)], EYE);
  }

  // The crest: three swept-back spikes, each with volume rather than a flat
  // fin. A fin on the centreline is a plane the camera is looking straight
  // along, so it would be invisible from exactly where you always are.
  for (let k = 0; k < 3; k++) {
    const lean = (k - 1) * 0.16;
    const len = 0.30 - Math.abs(k - 1) * 0.07;
    const bx = lean * 0.30;
    const base = [
      v(bx - 0.035, -0.175, 0.50 - k * 0.055),
      v(bx + 0.035, -0.175, 0.50 - k * 0.055),
      v(bx, -0.165, 0.44 - k * 0.055),
    ];
    const spike = v(bx + lean, -0.175 - len, 0.34 - k * 0.075);
    facet(m, [base[0], base[1], spike], CREST_T);
    facet(m, [base[1], base[2], spike], CREST);
    facet(m, [base[2], base[0], spike], CREST);
  }

  // Legs. A bird in flight tucks them; this one does not, because it is a
  // machine for landing on things and the moment you want to see where its
  // feet are is the moment before they touch.
  for (const s of [1, -1]) {
    const x = s * 0.11, t = 0.026;
    boxFaces(m, v, x - t, 0.13, -0.10, x + t, STANCE - 0.05, -0.04, LEG);
    // A foot, as one plate rather than three toes. Toes were there for a
    // while and they were forty-eight faces of nothing: at fifteen tiles a
    // toe is a twentieth of a tile, which is under two pixels, and half of
    // those pixels are the shadow it is standing in.
    boxFaces(m, v, x - 0.075, STANCE - 0.045, -0.15, x + 0.075, STANCE, 0.03, FOOT);
  }

  return m;
}

// --- the tail --------------------------------------------------------------
//
// Five feathers off the rump, fanned in plan and drooping a little at the
// tips. This is the bird's face, as far as this camera is concerned.
//
// Each feather is a long quad rather than a triangle: a triangle tapers to
// nothing and at fifteen tiles the last third of it is under a pixel wide,
// so it frays. A quad that stays a few hundredths wide to the end holds
// together.
function buildTail() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * SCALE, y * SCALE, z * SCALE);
  const cols = [TAIL_A, TAIL_B, TAIL_C, TAIL_B, TAIL_A];

  for (let k = -2; k <= 2; k++) {
    const i = k + 2;
    // A fan held down, not a starburst and not a rudder.
    //
    // Two goes at this were wrong in opposite directions. Spread wide and
    // thin, it read as a spray of rays under the belly. Lifted level with the
    // back, it vanished: the camera sits behind and only seven degrees above,
    // so a tail pointing straight back is seen end-on and hides behind the
    // body it is attached to.
    //
    // Cocked down about sixteen degrees, the whole upper surface turns
    // towards the camera and the fan reads as a fan -- and a bird holding its
    // tail down is a bird braking, which is what this one spends its life
    // doing.
    const spread = k * 0.20;
    const len = 0.62 - Math.abs(k) * 0.07;
    const droop = 0.16 + Math.abs(k) * 0.03;
    const w = 0.085 - Math.abs(k) * 0.008;

    const r0 = v(k * 0.04 - 0.045, -0.05, -0.40);
    const r1 = v(k * 0.04 + 0.045, -0.05, -0.40);
    const t0 = v(spread - w, -0.05 + droop, -0.40 - len);
    const t1 = v(spread + w, -0.05 + droop, -0.40 - len);

    // Top and underside, a hair apart, so a feather seen edge-on is still a
    // feather. The underside is darker, which is also what birds do.
    m.face([r0, r1, t1, t0], cols[i]);
    const u0 = v(k * 0.04 - 0.045, -0.035, -0.40);
    const u1 = v(k * 0.04 + 0.045, -0.035, -0.40);
    const s0 = v(spread - w, -0.035 + droop, -0.40 - len);
    const s1 = v(spread + w, -0.035 + droop, -0.40 - len);
    m.face([u0, s0, s1, u1], shade(cols[i], 0.62));
    m.face([r0, t0, s0, u0], shade(cols[i], 0.80));
    m.face([r1, u1, s1, t1], shade(cols[i], 0.80));
  }
  return m;
}

// --- a wing ----------------------------------------------------------------
//
// Built relative to the shoulder, because that is what it pivots about, and
// mirrored per side rather than negated at draw time: a mirrored model has
// its faces wound the other way, and the lighting would come out inside out.
//
// Shape: a thick arm from shoulder to wrist with the pale coverts behind it,
// then four primaries fanning back from the wrist. The primaries carry the
// ember colour, which puts the warm part of the bird at the two widest points
// of its silhouette.
function buildWing(side) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * side * SCALE, y * SCALE, z * SCALE);

  // The leading arm, with thickness, so it never disappears edge-on.
  const arm = (x0, z0, x1, z1, y, t, col) => {
    const a0 = v(x0, y - t, z0), a1 = v(x1, y - t, z1);
    const b0 = v(x0, y + t, z0), b1 = v(x1, y + t, z1);
    const c0 = v(x0, y - t, z0 - 0.07), c1 = v(x1, y - t, z1 - 0.06);
    const d0 = v(x0, y + t, z0 - 0.07), d1 = v(x1, y + t, z1 - 0.06);
    m.face([a0, a1, c1, c0], col);                       // top
    m.face([b0, d0, d1, b1], shade(col, 0.66));          // underside
    m.face([a0, b0, b1, a1], shade(col, 0.86));          // leading edge
    m.face([c0, c1, d1, d0], shade(col, 0.78));          // trailing edge
  };
  arm(0.03, 0.19, 0.44, 0.12, -0.02, 0.022, ARM);

  // Coverts: the pale sheet behind the arm, in three panels so the trailing
  // edge can be ragged rather than a ruled line.
  const covert = (x0, z0, x1, z1, back0, back1, col) => {
    const p0 = v(x0, -0.005, z0), p1 = v(x1, -0.02, z1);
    const q1 = v(x1, 0.01, z1 - back1), q0 = v(x0, 0.02, z0 - back0);
    m.face([p0, p1, q1, q0], col);
    m.face([p0, q0, q1, p1], shade(col, 0.60));
  };
  covert(0.02, 0.12, 0.20, 0.10, 0.30, 0.34, COVERT);
  covert(0.20, 0.10, 0.34, 0.08, 0.34, 0.32, shade(COVERT, 0.97));
  covert(0.34, 0.08, 0.46, 0.06, 0.32, 0.26, COVERT_U);

  // Primaries: four feathers fanning back from the wrist, each a long quad.
  // Three of them, broad. Four narrow ones read as spines rather than
  // feathers at any distance you actually fly at.
  for (let k = 0; k < 3; k++) {
    const t = k / 2;
    const ang = 0.26 + t * 0.78;              // out-and-back, in radians
    const len = 0.46 - t * 0.07;
    const wx = 0.44 + k * 0.03, wz = 0.10 - k * 0.10;
    const tx = wx + Math.cos(ang) * len;
    const tz = wz - Math.sin(ang) * len;
    const w = 0.085;
    const col = k < 2 ? PRIM_T : PRIM;

    const r0 = v(wx, -0.02, wz + 0.05);
    const r1 = v(wx, -0.02, wz - 0.07);
    const p0 = v(tx, -0.05, tz + w);
    const p1 = v(tx, -0.05, tz - w);
    m.face([r0, r1, p1, p0], col);
    const s0 = v(wx, -0.005, wz + 0.05);
    const s1 = v(wx, -0.005, wz - 0.07);
    const q0 = v(tx, -0.035, tz + w);
    const q1 = v(tx, -0.035, tz - w);
    m.face([s0, q0, q1, s1], shade(col, 0.58));
  }
  return m;
}

// --- the embers ------------------------------------------------------------
//
// After dark the warm parts come up by themselves. Not a lamp hung off the
// airframe: the faces that are already ember-coloured are redrawn over
// themselves in a hotter tone, marked emissive so they keep their colour
// through the night tint, and faded in with the hour. At noon the overlay is
// invisible; at midnight the bird is carrying its own fire, which is the
// whole of what a phoenix is.
//
// Warm is decided by the colour rather than declared, because facet() has
// already shaded every face by the time there is a model to ask.
function hotter(col) {
  if (col[0] < col[2] * 1.25) return null;   // not a warm face: leave it
  return [
    Math.min(255, Math.round(col[0] * 0.55 + 255 * 0.45)),
    Math.min(255, Math.round(col[1] * 0.60 + 190 * 0.40)),
    Math.min(255, Math.round(col[2] * 0.55 +  90 * 0.45)),
  ];
}

// The overlay carries only the faces that actually glow. recolour() keeps
// the whole face list, which would mean redrawing the entire bird every night
// frame to change a third of it -- and the other two thirds would be blending
// their own colour over themselves, which is a lot of triangles to achieve
// nothing.
function emberOnly(model) {
  const out = new Model();
  out.verts = model.verts;
  out.height = model.height;
  out.radius = model.radius;
  out.faces = [];
  for (const f of model.faces) {
    const col = hotter(f.col);
    if (col) out.faces.push({ idx: f.idx, col, glow: true });
  }
  return out;
}

export const BIRD_BODY = buildBody();
export const BIRD_TAIL = buildTail();
const WING_R = buildWing(1);
const WING_L = buildWing(-1);

const BODY_GLOW = emberOnly(BIRD_BODY);
const TAIL_GLOW = emberOnly(BIRD_TAIL);
const WING_R_GLOW = emberOnly(WING_R);
const WING_L_GLOW = emberOnly(WING_L);

export const EMBER_FACES = BODY_GLOW.faces.length + TAIL_GLOW.faces.length
                         + WING_R_GLOW.faces.length + WING_L_GLOW.faces.length;

// --- the beat --------------------------------------------------------------
//
// The wings run off the same phase the rotors did, so nothing in the flight
// model had to learn a new word for it. What changes with power is the depth
// of the stroke, not just its speed: a bird holding station beats hard and a
// bird gliding down holds its wings out and still. Eased rather than
// switched, because power comes and goes several times a second when someone
// is flying properly and a wing that snapped between two amplitudes would
// read as a fault.
const BEAT_IDLE = 0.13;      // radians either side of level, gliding
const BEAT_POWER = 0.62;     // ... and at full power
const BEAT_EASE = 0.08;
const DIHEDRAL = 0.10;       // wings held a little above level at rest

// ... and folded, on the ground. A bird standing about with its wings out is
// a bird that has just been startled; one that has settled puts them away.
// It is two rotations rather than one -- up over the back and swept back
// along it -- because a wing that only goes up is a wing being held up.
const FOLD_RISE = -0.62;
const FOLD_SWEEP = 1.20;
const FOLD_EASE = 0.06;

let beat = BEAT_IDLE;
let fold = 0;

const flapMat = new Float64Array(9);
const sweepMat = new Float64Array(9);
const poseMat = new Float64Array(9);
const wingMat = new Float64Array(9);

export function drawBird(rd, p, camX, camY, camZ) {
  const want = p.thrusting === 2 ? BEAT_POWER
             : p.thrusting === 1 ? (BEAT_IDLE + BEAT_POWER) / 2
             : BEAT_IDLE;
  beat += (want - beat) * BEAT_EASE;
  fold += ((p.landed ? 1 : 0) - fold) * FOLD_EASE;

  const lamp = sky.lamp;
  const glow = lamp > 0.02;

  drawModel(rd, BIRD_BODY, p.matrix, p.x, p.y, p.z, camX, camY, camZ);
  if (glow) {
    drawModel(rd, BODY_GLOW, p.matrix, p.x, p.y, p.z, camX, camY, camZ, 0, 0, lamp);
  }
  drawModel(rd, BIRD_TAIL, p.matrix, p.x, p.y, p.z, camX, camY, camZ);
  if (glow) {
    drawModel(rd, TAIL_GLOW, p.matrix, p.x, p.y, p.z, camX, camY, camZ, 0, 0, lamp);
  }

  // The stroke. Positive rotation about the craft's own forward axis drops
  // whichever wing is out to the right, so the two sides take opposite signs
  // and the bird beats symmetrically rather than rolling itself over.
  const angle = (DIHEDRAL + Math.sin(p.rotorSpin || 0) * beat) * (1 - fold)
              + FOLD_RISE * fold;
  const sweep = FOLD_SWEEP * fold;
  for (const side of [1, -1]) {
    const off = matApply(p.matrix,
      SHOULDER[0] * side * SCALE * TILE,
      SHOULDER[1] * SCALE * TILE,
      SHOULDER[2] * SCALE * TILE);
    const wx = (p.x + off[0]) | 0;
    const wy = (p.y + off[1]) | 0;
    const wz = (p.z + off[2]) | 0;

    // Swept first, then raised, then carried by the craft's own attitude.
    matRotY(sweep * side, sweepMat);
    matRotZ(angle * side, flapMat);
    matMul(flapMat, sweepMat, poseMat);
    matMul(p.matrix, poseMat, wingMat);
    const wing = side > 0 ? WING_R : WING_L;
    drawModel(rd, wing, wingMat, wx, wy, wz, camX, camY, camZ);
    if (glow) {
      const g = side > 0 ? WING_R_GLOW : WING_L_GLOW;
      drawModel(rd, g, wingMat, wx, wy, wz, camX, camY, camZ, 0, 0, lamp);
    }
  }
}
