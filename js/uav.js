// uav.js -- an original low-poly quadrotor, as an alternative airframe.
//
// A quad suits this game well. The flight model already works by tilting the
// whole craft to convert lift into forward speed, which is exactly how a
// quadrotor flies -- unlike a tilt-rotor, its rotors stay fixed to the
// airframe, so the animation needs nothing but spin.
//
// The arms are deliberately colour-coded, front warm and rear cool. That is
// how real machines are marked so the pilot can tell which way they are
// pointing, and it does the same job here: with the craft free to face any
// bearing, you need to read its heading at a glance.

import { TILE, matMul, matRotY, matApply } from './maths.js';
import { Model, facet, drawModel, recolour } from './model.js';
import { sky, beacon } from './daylight.js';

// --- palette ---------------------------------------------------------------

// Violet, hot orange, magenta and yellow: a racing quad, and the right
// machine for a game about shooting things. It is the wrong one now. With the
// blocks muted, the rocks sanded down and the foreground going to silhouette,
// it was the only saturated object left in the world and it took your eye off
// the landscape it is meant to be flying over.
//
// So: bone white. Matte, faceted, near enough one colour that the machine
// reads as a shape rather than as a paint job -- which is the whole of the
// style it now has to live in.
//
// Two things stop white being a bad idea. The belly is a warm charcoal, so
// the craft still reads against a pale sky and against snow, which a
// uniformly white machine would vanish into at exactly the moment you most
// need to see it. And the arms keep their marking, quietly: warm sand
// forward, slate aft, at a fraction of the old contrast but still the two
// ends of the temperature scale, so heading is legible at a glance.
const SHELL_A  = [242, 240, 232];   // shell, bone white
const SHELL_B  = [220, 216, 206];   // ... and the facets either side of it
const SHELL_C  = [198, 194, 184];
const UNDER    = [ 86,  82,  78];   // warm charcoal belly
const ARM_FWD  = [206, 176, 130];   // front arms, warm sand
const ARM_FWD2 = [226, 200, 158];
const ARM_AFT  = [140, 150, 162];   // rear arms, slate
const ARM_AFT2 = [168, 176, 186];
const POD      = [214, 210, 200];   // motor pods, off-white
const POD_B    = [186, 182, 172];
const HUB      = [104, 100,  96];
const BLADE    = [112, 110, 106];
const BLADE_LIT= [156, 154, 148];
const BLADE_TIP= [238, 236, 230];
const DISC_A   = [160, 160, 156];   // swept disc, alternating
const DISC_B   = [136, 136, 132];
const SKID     = [228, 226, 218];
const SKID_LEG = [158, 156, 150];
const LENS     = [ 92, 112, 116];   // a dark eye rather than a bright one

// --- layout ----------------------------------------------------------------

// Overall size of the aircraft. Everything below is in unscaled units and
// passes through here, so the whole machine resizes from one number.
const SCALE = 0.76;

export const ARM_R = 0.72;      // arm tip, out from the centre
const ARM_Y = -0.03;            // arms sit just above the waist
const BELLY = 0.39 / SCALE;     // scales to exactly the undercarriage height

// Arm bearings, X-configuration: two forward, two aft.
export const ARMS = [
  { a:  Math.PI * 0.25, fwd: true },    // front right
  { a: -Math.PI * 0.25, fwd: true },    // front left
  { a:  Math.PI * 0.75, fwd: false },   // rear right
  { a: -Math.PI * 0.75, fwd: false },   // rear left
];

function buildBody() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * SCALE, y * SCALE, z * SCALE);
  const CH = -0.02;

  // Faceted shell: a ring at the waist, drawn up to a short spine and down
  // to a keel, so it reads as a rounded hull without any curved surfaces.
  const ring = [];
  const RX = 0.30, RZ = 0.46;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    ring.push(v(Math.sin(a) * RX, CH, Math.cos(a) * RZ));
  }
  const topF = v(0.00, -0.26,  0.14);
  const topR = v(0.00, -0.21, -0.20);
  const botF = v(0.00,  0.20,  0.10);
  const botR = v(0.00,  0.18, -0.18);

  const shellTone = [SHELL_A, SHELL_B, SHELL_C, SHELL_B, SHELL_A, SHELL_B, SHELL_C, SHELL_B];
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    const fore = Math.cos((i / 8) * Math.PI * 2 + Math.PI / 8) > 0;
    facet(m, [ring[i], ring[j], fore ? topF : topR], shellTone[i]);
    facet(m, [ring[i], fore ? botF : botR, ring[j]], UNDER);
  }

  // Sensor lens in the nose.
  facet(m, [v(-0.09, CH + 0.06, 0.44), v(0.09, CH + 0.06, 0.44), v(0.00, CH - 0.04, 0.50)], LENS);

  // Arms out to the motor pods, each a slim faceted boom.
  for (const { a, fwd } of ARMS) {
    const sx = Math.sin(a), sz = Math.cos(a);
    const px = -sz * 0.055, pz = sx * 0.055;   // boom half-width, square to it
    const inR = 0.20, outR = ARM_R;
    const top = -0.05, bot = 0.06;

    const iTa = v(sx * inR + px, ARM_Y + top, sz * inR + pz);
    const iTb = v(sx * inR - px, ARM_Y + top, sz * inR - pz);
    const iBa = v(sx * inR + px, ARM_Y + bot, sz * inR + pz);
    const iBb = v(sx * inR - px, ARM_Y + bot, sz * inR - pz);
    const oTa = v(sx * outR + px, ARM_Y + top, sz * outR + pz);
    const oTb = v(sx * outR - px, ARM_Y + top, sz * outR - pz);
    const oBa = v(sx * outR + px, ARM_Y + bot, sz * outR + pz);
    const oBb = v(sx * outR - px, ARM_Y + bot, sz * outR - pz);

    const c1 = fwd ? ARM_FWD : ARM_AFT;
    const c2 = fwd ? ARM_FWD2 : ARM_AFT2;
    facet(m, [iTa, iTb, oTb, oTa], c2);   // upper
    facet(m, [iBa, iBb, oBb, oBa], c1);   // lower
    facet(m, [iTa, iBa, oBa, oTa], c1);   // side
    facet(m, [iTb, iBb, oBb, oTb], c1);   // side
  }

  // Skids: two rails on drop legs. Built as solid boxes rather than flat
  // quads -- the camera rides at the craft's own altitude, so a zero-thickness
  // rail is seen edge-on and collapses into a scratch of stray pixels.
  const boxFaces = (x0, y0, z0, x1, y1, z1, col) => {
    const q = [
      v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1),
      v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1),
    ];
    facet(m, [q[0], q[1], q[2], q[3]], col);
    facet(m, [q[4], q[5], q[6], q[7]], col);
    facet(m, [q[0], q[1], q[5], q[4]], col);
    facet(m, [q[3], q[2], q[6], q[7]], col);
    facet(m, [q[1], q[2], q[6], q[5]], col);
    facet(m, [q[0], q[3], q[7], q[4]], col);
  };

  for (const sgn of [1, -1]) {
    const x = sgn * 0.23, t = 0.032;
    // Two drop legs.
    for (const z of [0.20, -0.22]) {
      boxFaces(x - t, 0.12, z - t, x + t, BELLY - 0.05, z + t, SKID_LEG);
    }
    // The rail they stand on.
    boxFaces(x - t * 1.2, BELLY - 0.06, -0.34, x + t * 1.2, BELLY, 0.32, SKID);
  }

  // What used to hang here was a bomb rack with a pair on the hardpoints. The
  // bombs went when the weapons did; the rack outlasted them by several
  // commits, which is how these things go. In their place, a plain pannier:
  // something to be carrying, since a machine pottering about a desert at
  // dusk is presumably carrying something.
  const pod = 0.05;
  boxFaces(-0.10, 0.20, -0.08, 0.10, 0.20 + pod * 2, 0.14, SKID_LEG);
  boxFaces(-0.07, 0.20 + pod * 2, -0.05, 0.07, 0.20 + pod * 2.6, 0.11, POD_B);

  return m;
}

// A motor pod, built about the arm tip.
function buildPod() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * SCALE, y * SCALE, z * SCALE);
  const r = 0.085;
  const top = [], bot = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    top.push(v(Math.cos(a) * r, -0.13, Math.sin(a) * r));
    bot.push(v(Math.cos(a) * r * 0.9, 0.06, Math.sin(a) * r * 0.9));
  }
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    facet(m, [top[i], bot[i], bot[j], top[j]], i % 2 ? POD : POD_B);
  }
  facet(m, top.slice(), HUB);
  return m;
}

// A two-bladed prop. Solid, with a little coning: the camera rides at the
// craft's own altitude, so at a hover the disc is seen very nearly edge-on
// and a zero-thickness blade would vanish entirely.
function buildRotor() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * SCALE, y * SCALE, z * SCALE);
  const R = 0.46, w = 0.055, t = 0.028;
  const Y = -0.17, CONE = 0.05;

  for (let i = 0; i < 2; i++) {
    const a = i * Math.PI;
    const ca = Math.cos(a), sa = Math.sin(a);
    const px = -sa * w, pz = ca * w;
    const seg = (r, y) => [
      v(ca * r + px, y, sa * r + pz), v(ca * r - px, y, sa * r - pz),
    ];
    const [ra, rb] = seg(0.05, Y);
    const [rc, rd] = seg(0.05, Y + t);
    const [ta, tb] = seg(R, Y - CONE);
    const [tc, td] = seg(R, Y - CONE + t);

    facet(m, [ra, rb, tb, ta], BLADE);
    facet(m, [rc, rd, td, tc], BLADE_LIT);
    facet(m, [ra, rc, tc, ta], BLADE);
    facet(m, [rb, rd, td, tb], BLADE);
    m.face([ta, tb, td, tc], BLADE_TIP);
  }
  return m;
}

// The swept disc. At speed a real prop blurs into a translucent ring, and
// with no blending available the honest approximation is a dim, faintly
// coned annulus sitting just inside the blade tips, with the solid blades
// still drawn over it. Coned rather than flat for the usual reason: the
// camera rides at the craft's altitude, so a flat ring would be edge-on.
function buildDisc() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * SCALE, y * SCALE, z * SCALE);
  const RI = 0.26, RO = 0.455, Y = -0.17, CONE = 0.05, SEG = 12;

  const inner = [], outer = [];
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    inner.push(v(ca * RI, Y - CONE * (RI / RO), sa * RI));
    outer.push(v(ca * RO, Y - CONE, sa * RO));
  }
  for (let i = 0; i < SEG; i++) {
    const j = (i + 1) % SEG;
    // Alternate tones so the ring reads as motion rather than a solid plate.
    facet(m, [inner[i], outer[i], outer[j], inner[j]], i % 2 ? DISC_A : DISC_B);
  }
  return m;
}

// Navigation lights, in the colours every aircraft carries them in: red to
// port, green to starboard, white aft. They are on a machine that can face
// any bearing over a landscape with no landmarks, so after dark they are the
// only thing telling you which way you are pointing -- the arm colours that
// do that job by day are invisible then.
//
// They are not lamps hung off the airframe. A lamp has to be drawn as a
// screen-space square, and at this resolution a square with a halo round it
// reads as a sticker rather than as light. Instead the motor pod itself takes
// the colour for a few frames: the machine winks, and between winks there is
// nothing extra on screen at all.
const NAV_RED   = [255,  48,  40];
const NAV_GREEN = [ 60, 255, 110];

function lit(col) {
  return (base) => [
    Math.round(base[0] * 0.25 + col[0] * 0.75),
    Math.round(base[1] * 0.25 + col[1] * 0.75),
    Math.round(base[2] * 0.25 + col[2] * 0.75),
  ];
}

// Roughly one wink a second.
const BLINK_PERIOD = 55;
const BLINK_FLASH = 4;

export const UAV_BODY = buildBody();
export const UAV_DISC = buildDisc();
export const UAV_POD = buildPod();
export const UAV_ROTOR = buildRotor();

// Lit variants of the pod, built once. They share the pod's vertices.
const POD_STBD = recolour(UAV_POD, lit(NAV_GREEN), true);
const POD_PORT = recolour(UAV_POD, lit(NAV_RED), true);

// Both arms down a side carry that side's colour, not just the front pair.
// This camera only ever looks from behind, so a light on the front arm alone
// spends most of its life hidden behind the rear motor in front of it -- and
// lighting the whole side is the convention anyway. Flying away you see red
// to the left and green to the right; coming back at you they swap, which is
// exactly how the rig is meant to be read.
//
// Arms are indexed front right, front left, rear right, rear left.
const POD_LIT = [POD_STBD, POD_PORT, POD_STBD, POD_PORT];

const rotMat = new Float64Array(9);
const spinMat = new Float64Array(9);


export function drawUav(rd, p, camX, camY, camZ) {
  drawModel(rd, UAV_BODY, p.matrix, p.x, p.y, p.z, camX, camY, camZ);

  const spin = p.rotorSpin || 0;
  const wink = sky.lamp > 0.05 && beacon(BLINK_PERIOD, BLINK_FLASH);

  for (let i = 0; i < ARMS.length; i++) {
    const { a } = ARMS[i];
    const off = matApply(p.matrix,
      Math.sin(a) * ARM_R * SCALE * TILE,
      ARM_Y * SCALE * TILE,
      Math.cos(a) * ARM_R * SCALE * TILE);
    const wx = (p.x + off[0]) | 0;
    const wy = (p.y + off[1]) | 0;
    const wz = (p.z + off[2]) | 0;

    drawModel(rd, wink ? POD_LIT[i] : UAV_POD, p.matrix, wx, wy, wz, camX, camY, camZ);

    // Under power the blades are turning too fast to resolve, so lay the
    // swept disc down first and draw the blades over it.
    if (p.thrusting) {
      drawModel(rd, UAV_DISC, p.matrix, wx, wy, wz, camX, camY, camZ);
    }

    // Diagonally opposite rotors turn the same way, adjacent ones oppose --
    // as they must on a real quad, or it would spin about its own axis.
    const dir = (i === 0 || i === 3) ? 1 : -1;
    matRotY(spin * dir, spinMat);
    matMul(p.matrix, spinMat, rotMat);
    drawModel(rd, UAV_ROTOR, rotMat, wx, wy, wz, camX, camY, camZ);
  }
}
