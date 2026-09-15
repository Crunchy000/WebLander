// uav.js -- an original tilt-rotor UAV, as an alternative airframe.
//
// A tilt-rotor suits this game unusually well. The flight model already works
// by pitching the craft to convert lift into forward speed, which is exactly
// what a real tilt-rotor does as it transitions out of a hover -- so the
// nacelles can be driven straight off the pitch angle and the animation is
// telling you something true about the physics rather than just decorating it.
//
// Three assemblies: the airframe, a pair of nacelles that pivot on the wing
// axis, and the rotor discs, which spin about each nacelle's own axis.

import { TILE, matMul, matRotX, matRotY, matApply } from './maths.js';
import { Model, shade, facet, drawModel } from './model.js';

// --- palette ---------------------------------------------------------------

const ARMOUR   = [104, 148, 126];   // hull plate, green-teal
const ARMOUR_B = [ 74, 116, 104];
const PANEL    = [188, 204, 196];   // upper decking
const ACCENT   = [242, 132,  44];   // hazard orange
const LENS     = [ 72, 226, 236];   // sensor glass
const NACELLE  = [126, 136, 152];
const NACELLE_B= [ 92, 100, 116];
const BLADE    = [ 72,  78,  92];
const BLADE_LIT= [122, 130, 148];
const BLADE_TIP= [246, 214,  86];
const GUNMETAL = [104, 110, 122];
const MUZZLE   = [244,  96,  62];

// --- geometry --------------------------------------------------------------

export const WING = 0.92;      // nacelle pivot, out along the wing
export const NAC_Y = -0.04;    // pivot height
export const NAC_Z = -0.02;    // pivot station along the fuselage
const BELLY = 0.39;            // sits on its belly at the undercarriage height

function buildAirframe() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x, y, z);
  const CH = -0.04;            // chine

  // Fuselage: a faceted box tapering to a sensor nose.
  const nose  = v( 0.00, CH,  0.92);
  const shL   = v(-0.24, CH,  0.42);
  const shR   = v( 0.24, CH,  0.42);
  const hipL  = v(-0.22, CH, -0.62);
  const hipR  = v( 0.22, CH, -0.62);
  const tail  = v( 0.00, CH, -0.86);

  const topF = v(0.00, -0.30,  0.34);
  const topR = v(0.00, -0.26, -0.56);
  const botF = v(0.00, BELLY,  0.30);
  const botR = v(0.00, BELLY - 0.04, -0.58);

  facet(m, [nose, shR, topF], ACCENT);
  facet(m, [shR, hipR, topR, topF], PANEL);
  facet(m, [hipR, tail, topR], ARMOUR);
  facet(m, [tail, hipL, topR], ARMOUR);
  facet(m, [hipL, shL, topF, topR], PANEL);
  facet(m, [shL, nose, topF], ACCENT);

  facet(m, [nose, botF, shR], ARMOUR_B);
  facet(m, [shR, botF, botR, hipR], ARMOUR_B);
  facet(m, [hipR, botR, tail], ARMOUR);
  facet(m, [tail, botR, hipL], ARMOUR);
  facet(m, [hipL, botR, botF, shL], ARMOUR_B);
  facet(m, [shL, botF, nose], ARMOUR_B);

  // Sensor turret under the nose -- no cockpit, it is unmanned.
  const tr = 0.13;
  const ring = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ring.push(v(Math.cos(a) * tr, 0.10, 0.62 + Math.sin(a) * tr));
  }
  const chin = v(0.00, 0.26, 0.62);
  for (let i = 0; i < 6; i++) facet(m, [ring[i], ring[(i + 1) % 6], chin], NACELLE);
  facet(m, [v(-0.09, 0.20, 0.72), v(0.09, 0.20, 0.72), v(0.00, 0.10, 0.78)], LENS);

  // Wing booms out to the nacelle pivots.
  for (const sgn of [1, -1]) {
    const iT = v(sgn * 0.20, CH - 0.06, NAC_Z + 0.16);
    const iB = v(sgn * 0.20, CH + 0.08, NAC_Z + 0.16);
    const iT2 = v(sgn * 0.20, CH - 0.06, NAC_Z - 0.18);
    const iB2 = v(sgn * 0.20, CH + 0.08, NAC_Z - 0.18);
    const oT = v(sgn * WING, NAC_Y - 0.05, NAC_Z + 0.13);
    const oB = v(sgn * WING, NAC_Y + 0.06, NAC_Z + 0.13);
    const oT2 = v(sgn * WING, NAC_Y - 0.05, NAC_Z - 0.15);
    const oB2 = v(sgn * WING, NAC_Y + 0.06, NAC_Z - 0.15);
    facet(m, [iT, oT, oT2, iT2], PANEL);       // upper skin
    facet(m, [iB, oB, oB2, iB2], ARMOUR_B);    // lower skin
    facet(m, [iT, oT, oB, iB], ACCENT);        // leading edge
    facet(m, [iT2, oT2, oB2, iB2], ARMOUR);    // trailing edge
  }

  // Canted tail fins.
  for (const sgn of [1, -1]) {
    facet(m, [
      v(sgn * 0.10, CH - 0.04, -0.66),
      v(sgn * 0.40, CH - 0.40, -0.86),
      v(sgn * 0.12, CH - 0.04, -0.88),
    ], ACCENT);
  }

  // Chin cannon.
  const bw = 0.055;
  const g = [
    v(-bw, 0.16, 0.74), v(bw, 0.16, 0.74), v(bw, 0.27, 0.74), v(-bw, 0.27, 0.74),
    v(-bw, 0.16, 1.16), v(bw, 0.16, 1.16), v(bw, 0.27, 1.16), v(-bw, 0.27, 1.16),
  ];
  facet(m, [g[0], g[1], g[5], g[4]], GUNMETAL);
  facet(m, [g[3], g[2], g[6], g[7]], GUNMETAL);
  facet(m, [g[1], g[2], g[6], g[5]], GUNMETAL);
  facet(m, [g[0], g[3], g[7], g[4]], GUNMETAL);
  m.face([g[4], g[5], g[6], g[7]], MUZZLE);

  return m;
}

// One nacelle, built around its pivot at the origin. Its thrust axis is local
// -y, so at zero tilt the rotor disc lies flat and lifts straight up.
function buildNacelle() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x, y, z);
  const r = 0.115;

  const top = [], bot = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 12;
    top.push(v(Math.cos(a) * r, -0.20, NAC_Z_LOCAL + Math.sin(a) * r * 1.6));
    bot.push(v(Math.cos(a) * r * 0.82, 0.22, NAC_Z_LOCAL + Math.sin(a) * r * 1.35));
  }
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    facet(m, [top[i], bot[i], bot[j], top[j]], i % 2 ? NACELLE : NACELLE_B);
  }
  facet(m, top.slice(), ACCENT);                       // intake collar
  facet(m, bot.slice().reverse(), NACELLE_B);          // exhaust

  // Hub above the intake.
  const hr = 0.05;
  const hub = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    hub.push(v(Math.cos(a) * hr, -0.30, NAC_Z_LOCAL + Math.sin(a) * hr));
  }
  facet(m, hub.slice(), GUNMETAL);
  for (let i = 0; i < 4; i++) {
    facet(m, [hub[i], hub[(i + 1) % 4], top[i % 6]], NACELLE);
  }
  return m;
}

const NAC_Z_LOCAL = 0;

// The rotor disc, built at the hub with blades radiating in the xz plane.
//
// The blades are solid boxes rather than flat quads, and cone upwards slightly
// towards the tips the way a loaded rotor does. Both matter: the camera rides
// at the craft's own altitude, so at a hover the disc is seen very nearly
// edge-on, and a zero-thickness blade would disappear entirely.
function buildRotor() {
  const m = new Model();
  const v = (x, y, z) => m.vert(x, y, z);
  const R = 0.60;          // tip radius
  const w = 0.05;          // chord
  const t = 0.035;         // thickness
  const HUB_Y = -0.31;
  const CONE = 0.07;       // tip rise

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const px = -sa * w, pz = ca * w;             // chord, square to the span

    // Root and tip cross-sections, upper and lower.
    const seg = (r, y) => [
      v(ca * r + px, y, sa * r + pz), v(ca * r - px, y, sa * r - pz),
    ];
    const [r0a, r0b] = seg(0.07, HUB_Y);
    const [r0c, r0d] = seg(0.07, HUB_Y + t);
    const [t0a, t0b] = seg(R, HUB_Y - CONE);
    const [t0c, t0d] = seg(R, HUB_Y - CONE + t);

    facet(m, [r0a, r0b, t0b, t0a], BLADE);        // upper skin
    facet(m, [r0c, r0d, t0d, t0c], BLADE_LIT);    // lower skin
    facet(m, [r0a, r0c, t0c, t0a], BLADE);        // leading edge
    facet(m, [r0b, r0d, t0d, t0b], BLADE);        // trailing edge
    m.face([t0a, t0b, t0d, t0c], BLADE_TIP);      // tip cap
  }
  return m;
}

export const UAV_AIRFRAME = buildAirframe();
export const UAV_NACELLE = buildNacelle();
export const UAV_ROTOR = buildRotor();

// How far the nacelles swing forward relative to the airframe, per radian of
// pitch. Greater than one, so the transition from hover to forward flight is
// clearly readable at a glance.
const TILT_GAIN = 1.25;

const nacMat = new Float64Array(9);
const rotMat = new Float64Array(9);
const tiltMat = new Float64Array(9);
const spinMat = new Float64Array(9);

// Draw the whole aircraft: airframe, then each nacelle and its rotor, pivoted
// on the wing axis by the current pitch and spun by the rotor phase.
export function drawUav(rd, p, camX, camY, camZ) {
  drawModel(rd, UAV_AIRFRAME, p.matrix, p.x, p.y, p.z, camX, camY, camZ);

  const tilt = p.lean * TILT_GAIN;
  matRotX(tilt, tiltMat);
  matMul(p.matrix, tiltMat, nacMat);

  matRotY(p.rotorSpin || 0, spinMat);
  matMul(nacMat, spinMat, rotMat);

  for (const sgn of [1, -1]) {
    // Pivot position in world space.
    const off = matApply(p.matrix, sgn * WING * TILE, NAC_Y * TILE, NAC_Z * TILE);
    const wx = (p.x + off[0]) | 0;
    const wy = (p.y + off[1]) | 0;
    const wz = (p.z + off[2]) | 0;

    drawModel(rd, UAV_NACELLE, nacMat, wx, wy, wz, camX, camY, camZ);
    drawModel(rd, UAV_ROTOR, rotMat, wx, wy, wz, camX, camY, camZ);
  }
}
