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
import { Model, shade, facet, drawModel } from './model.js';

// --- palette ---------------------------------------------------------------

const SHELL_A  = [122,  92, 232];   // canopy shell, violet
const SHELL_B  = [ 78, 134, 246];   // ... to blue
const SHELL_C  = [ 46, 196, 232];   // ... to cyan
const UNDER    = [ 58,  62, 138];   // deep indigo belly
const ARM_FWD  = [248,  92,  64];   // front arms, hot orange
const ARM_FWD2 = [252, 148,  52];
const ARM_AFT  = [ 46, 214, 176];   // rear arms, teal
const ARM_AFT2 = [ 64, 168, 224];
const POD      = [250, 206,  62];   // motor pods, yellow
const POD_B    = [214, 158,  40];
const HUB      = [236,  72, 168];   // magenta hubs
const BLADE    = [ 68,  74,  92];
const BLADE_LIT= [126, 134, 156];
const BLADE_TIP= [246, 246, 250];
const DISC_A   = [116, 124, 146];   // swept disc, alternating
const DISC_B   = [ 92,  99, 120];
const SKID     = [232, 238, 246];
const SKID_LEG = [176, 186, 202];
const LENS     = [ 96, 244, 250];
const GUNMETAL = [110, 116, 130];
const BOMB     = [ 64,  70,  84];
const BOMB_TIP = [252,  80,  56];
const BOMB_FIN = [250, 206,  62];

// --- layout ----------------------------------------------------------------

export const ARM_R = 0.72;      // arm tip, out from the centre
const ARM_Y = -0.03;            // arms sit just above the waist
const BELLY = 0.39;             // skids reach the undercarriage height

// Arm bearings, X-configuration: two forward, two aft.
export const ARMS = [
  { a:  Math.PI * 0.25, fwd: true },    // front right
  { a: -Math.PI * 0.25, fwd: true },    // front left
  { a:  Math.PI * 0.75, fwd: false },   // rear right
  { a: -Math.PI * 0.75, fwd: false },   // rear left
];

function buildBody() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x, y, z);
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

  // Bomb rack under the belly, with a pair on the hardpoints.
  const rack = 0.045;
  boxFaces(-0.13, 0.20, -0.10, 0.13, 0.20 + rack, 0.16, GUNMETAL);
  for (const sgn of [1, -1]) {
    const x = sgn * 0.075;
    const bw = 0.042;
    // Body of the bomb.
    boxFaces(x - bw, 0.24, -0.06, x + bw, 0.24 + bw * 2, 0.10, BOMB);
    // Nose cone and tail fin, so it reads as ordnance rather than a crate.
    facet(m, [
      v(x - bw, 0.24, 0.10), v(x + bw, 0.24, 0.10),
      v(x, 0.24 + bw, 0.18),
    ], BOMB_TIP);
    facet(m, [
      v(x, 0.24, -0.06), v(x, 0.24 + bw * 2, -0.06), v(x, 0.24 + bw, -0.16),
    ], BOMB_FIN);
  }

  return m;
}

// A motor pod, built about the arm tip.
function buildPod() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x, y, z);
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
  const v = (x, y, z) => m.vert(x, y, z);
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
  const v = (x, y, z) => m.vert(x, y, z);
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

export const UAV_BODY = buildBody();
export const UAV_DISC = buildDisc();
export const UAV_POD = buildPod();
export const UAV_ROTOR = buildRotor();

const rotMat = new Float64Array(9);
const spinMat = new Float64Array(9);

export function drawUav(rd, p, camX, camY, camZ) {
  drawModel(rd, UAV_BODY, p.matrix, p.x, p.y, p.z, camX, camY, camZ);

  const spin = p.rotorSpin || 0;

  for (let i = 0; i < ARMS.length; i++) {
    const { a } = ARMS[i];
    const off = matApply(p.matrix, Math.sin(a) * ARM_R * TILE, ARM_Y * TILE, Math.cos(a) * ARM_R * TILE);
    const wx = (p.x + off[0]) | 0;
    const wy = (p.y + off[1]) | 0;
    const wz = (p.z + off[2]) | 0;

    drawModel(rd, UAV_POD, p.matrix, wx, wy, wz, camX, camY, camZ);

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
