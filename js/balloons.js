// balloons.js -- hot air balloons, and the bunting strung between them.
//
// The sky had nothing in it but weather. Clouds drift and the sun goes round,
// but there was nothing up there at your own altitude -- nothing to fly
// towards, nothing to give the air a scale, and nothing to tell you how fast
// you were moving except the ground going past underneath.
//
// Balloons come in pairs with a line of bunting slung between them, which is
// the whole point of them: one balloon is an object, two balloons and a line
// is a place. They drift with the same wind that pushes the craft about, they
// are lit from inside after dark, and nothing about them can hurt you. You
// can fly straight through the bunting, and should.

import { TILE, rnd, rndSigned } from './maths.js';
import { Model, facet, shade, drawModel, recolour, silhouetteAmount } from './model.js';
import { sky, beacon, litColour } from './daylight.js';
import {
  SEA_LEVEL, landAltitude, fogForRow, FOG_MAX, LANDSCAPE_Z_MID,
} from './landscape.js';
import { HIGHEST_ALTITUDE } from './player.js';
import { project, SCREEN_W, SCREEN_H, CENTRE_X, FOCAL_X } from './renderer.js';
import { weather } from './weather.js';

export const MAX_PAIRS = 4;

// Everything scales from here.
const S = 1.15;

// Where they appear.
//
// The landscape is drawn from 10 to 26 tiles out and the balloons used to be
// bucketed into its rows, so anything past 26 was simply never drawn -- which
// is why they all had to be put down close. Far balloons have their own pass
// now (see drawFarBalloons), so the band reaches past the drawn landscape:
// near ones to fly through, far ones sitting over the ranges the way they do
// in the picture this is all after.
//
// It went out to sixty tiles first, and sixty is too far. A balloon that far
// back is four or five pixels of envelope hanging in the haze -- not scenery,
// just specks -- and with enough of them out there the sky read as busy while
// nothing in it was legible. Thirty-eight is about one and a half times the
// depth of the drawn ground: far enough to sit behind the ranges and read as
// distance, near enough that you can still tell it is a balloon.
const SPAWN_MIN = 12 * TILE;
const SPAWN_MAX = 38 * TILE;
const RETIRE = 52 * TILE;

// Past here a balloon is beyond the drawn landscape and belongs to the far
// pass instead of to a row.
const FAR_MIN = 26 * TILE;
// ... and by here it is as hazy as it is going to get.
const FAR_HAZE = 46 * TILE;

// And they appear inside the camera's cone rather than on a ring around the
// craft. The camera never turns, so the frame is a fixed wedge of the world:
// at d tiles of depth it is CENTRE_X / FOCAL_X tiles wide to each side of the
// axis, which is a shade under half of d. A ring puts most of its balloons
// outside that wedge, and the further out the ring the worse it gets -- with
// the band opened out to sixty tiles, a frame with fourteen balloons alive in
// it had eleven of them off the side of the screen.
//
// So the depth is chosen first and the sideways offset second, inside the
// wedge at that depth. SPREAD reaches a little past the edge of the frame,
// which is what lets one drift in from the side instead of every one of them
// being born already in shot.
const HALF_WEDGE = CENTRE_X / FOCAL_X;
const SPAWN_SPREAD = 1.2;
// How far behind the craft the eye sits, in tiles -- the constant itself is
// fixed point, and everything here is counting tiles.
const CAM_BACK = LANDSCAPE_Z_MID / TILE;

// ... and they are let go once the wind has taken them well outside it. A
// plain radius does not do it: a balloon blown sixty tiles out to one side is
// still well inside seventy-eight, so it sat there off the edge of the frame
// holding a slot that nobody could see out of.
const RETIRE_SPREAD = 1.8;

// How high they ride, in tiles above the ground under them.
//
// This is not a matter of taste, it is a matter of what the camera can see.
// The eye is only allowed a tile and a half above y = 0 and the screen centre
// sits high, so there is about sixty pixels of headroom: anything more than
// d/8 tiles above the eye, at d tiles away, is off the top of the frame. With
// the scan drawing out to 26 tiles that is three and a quarter tiles above
// the eye at the very best, and the craft pootles along two or three tiles
// up.
//
// Measured with the first numbers -- four and a half to ten and a half tiles
// -- a balloon was on screen in 8% of frames over fifteen hundred frames of
// ordinary flying. They were up in a part of the sky the camera could not
// look at.
//
// The camera follows the craft to the ceiling now, so the top of the band has
// gone back up a little: the low ones are what you meet pottering along, and
// the high ones are a reason to climb.
const RIDE_LOW = 2.4, RIDE_HIGH = 7.0;

// ... and they keep this much air under them as they drift, so one crossing
// a ridge rises over it instead of sinking into it.
const MIN_CLEAR = 1.9 * TILE;

// --- the envelope ----------------------------------------------------------
//
// Canvas in two tones, banded. Stripes are the thing that says "balloon"
// before the shape does, and they cost nothing here: a band is already a ring
// of faces, so striping is a matter of which colour it is handed.
const CANVAS = [
  [[226, 206, 176], [188, 132,  96]],   // cream and clay
  [[214, 206, 196], [122, 146, 164]],   // chalk and slate
  [[228, 210, 168], [186, 150,  84]],   // bone and ochre
  [[210, 202, 194], [138, 128, 152]],   // pale and plum
];
const BASKET   = [126,  98,  70];
const BASKET_D = [ 98,  76,  56];
const CORD     = [ 86,  76,  66];
const MOUTH    = [ 92,  74,  58];       // the dark inside of the envelope
const BURNER   = [255, 214, 140];       // ... and the burner lighting it

// Profile of the envelope: how far down it is, and how wide there. A teardrop
// -- widest above the middle, drawn in to a mouth at the bottom.
const PROFILE = [
  [0.00, 0.20], [0.14, 0.58], [0.34, 0.84],
  [0.56, 0.80], [0.76, 0.56], [0.92, 0.30],
];
const SIDES = 7;
const ENV_H = 1.95;          // envelope height, in units
const BASKET_DROP = 0.72;    // from the mouth to the top of the basket

// The top of the envelope above the point the balloon is placed at.
export const ENVELOPE_TOP = ENV_H * S * TILE;
const ENV_TOP = ENVELOPE_TOP;

// And the highest the top of one may ever be. The craft's ceiling is a line
// in world y; a balloon whose envelope pokes through it is one you cannot get
// over, which would make it the only thing in the world that can turn you
// back. This keeps a tile and a bit of air between the top of the biggest
// balloon and the bottom of the thin air.
const CEILING_CLEAR = 1.2 * TILE;
const HIGHEST_TOP = HIGHEST_ALTITUDE + CEILING_CLEAR + ENV_TOP;

// Not above the ceiling, and not into the ground.
function keepInBand(b) {
  if (b.y < HIGHEST_TOP) b.y = HIGHEST_TOP | 0;
  const floor = (Math.min(landAltitude(b.x, b.z), SEA_LEVEL) - MIN_CLEAR) | 0;
  if (b.y > floor) b.y = (b.y + (floor - b.y) * 0.08) | 0;
}

// How far apart a pair flies, and how far their bunting sags.
const PAIR_MIN = 5.0 * TILE, PAIR_MAX = 9.0 * TILE;
const SAG = 0.34;

const mouthFaces = [];

function buildBalloon(pair) {
  const m = new Model();
  const [light, dark] = CANVAS[pair % CANVAS.length];
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);

  const rings = PROFILE.map(([t, r]) => {
    const ring = [];
    for (let i = 0; i < SIDES; i++) {
      const a = (i / SIDES) * Math.PI * 2;
      ring.push(v(Math.cos(a) * r, -ENV_H * (1 - t), Math.sin(a) * r));
    }
    return ring;
  });

  // The crown, then the bands down to the mouth.
  facet(m, rings[0].slice(), shade(light, 1.05));
  for (let j = 0; j < rings.length - 1; j++) {
    const top = rings[j], bot = rings[j + 1];
    const col = j % 2 ? dark : light;
    for (let i = 0; i < SIDES; i++) {
      const n = (i + 1) % SIDES;
      facet(m, [top[i], top[n], bot[n], bot[i]], col);
    }
  }

  // The mouth: a dark disc closing the bottom, which is what the burner
  // lights up after dark.
  const mouth = rings[rings.length - 1];
  facet(m, mouth.slice().reverse(), MOUTH);
  mouthFaces.push(m.faces.length - 1);

  // Basket, hung below on four cords.
  const bw = 0.26, bh = 0.24;
  const top = -ENV_H * (1 - PROFILE[PROFILE.length - 1][0]) + BASKET_DROP;
  const q = [
    v(-bw, top, -bw), v(bw, top, -bw), v(bw, top, bw), v(-bw, top, bw),
    v(-bw, top + bh, -bw), v(bw, top + bh, -bw), v(bw, top + bh, bw), v(-bw, top + bh, bw),
  ];
  facet(m, [q[0], q[1], q[2], q[3]], shade(BASKET, 1.08));
  facet(m, [q[4], q[5], q[6], q[7]], BASKET_D);
  facet(m, [q[0], q[1], q[5], q[4]], BASKET);
  facet(m, [q[3], q[2], q[6], q[7]], BASKET);
  facet(m, [q[1], q[2], q[6], q[5]], shade(BASKET, 0.86));
  facet(m, [q[0], q[3], q[7], q[4]], shade(BASKET, 0.86));

  // Four cords from the mouth rim down to the basket corners. Thin boxes
  // rather than lines, for the usual reason: the camera rides at the craft's
  // own altitude, and a zero-thickness cord seen edge-on is a scatter of
  // stray pixels.
  const rim = PROFILE[PROFILE.length - 1][1];
  const cw = 0.022;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const rx = Math.cos(a) * rim, rz = Math.sin(a) * rim;
    const bx = Math.cos(a) * bw * 1.1, bz = Math.sin(a) * bw * 1.1;
    const ry = -ENV_H * (1 - PROFILE[PROFILE.length - 1][0]);
    const c = [
      v(rx - cw, ry, rz - cw), v(rx + cw, ry, rz + cw),
      v(bx + cw, top, bz + cw), v(bx - cw, top, bz - cw),
    ];
    facet(m, c, CORD);
  }
  return m;
}

const BALLOONS = [0, 1, 2, 3].map(buildBalloon);

// Lit variants: the mouth glows when the burner goes. One face each, built
// once, sharing the envelope's vertices.
const BALLOONS_LIT = BALLOONS.map((model, i) => {
  const out = recolour(model, () => null);
  const f = mouthFaces[i];
  out.faces[f] = { idx: model.faces[f].idx, col: BURNER, glow: true };
  return out;
});

// --- bunting ---------------------------------------------------------------

const FLAGS = [
  [208, 146, 110], [150, 166, 178], [206, 178, 116],
  [140, 162, 132], [176, 142, 166], [214, 200, 178],
];
const CORD_COL = [72, 64, 58];

// The bunting is drawn in screen space rather than as a model, which means
// nothing puts the time of day through it -- so it does that for itself.
// The first version did not, and a line of bright party flags hung across a
// midnight sky like a shop sign.
const buntCol = [0, 0, 0, 255];

// Fairy lights along the cord: one bulb at every joint, between the flags.
//
// They are lights, so two rules that apply to everything else do not apply to
// them. They do not take the daylight tint, because a lamp run through the
// evening's colour is darker than the thing carrying it at exactly the hour
// it is meant to show. And they do not take the near-camera silhouette --
// same reason the canoe's lantern does not: a light that dims as it comes
// towards you is not a light.
//
// They do fade in with `sky.lamp`, which is the game's own measure of how
// dark it is, so they come on with the burners and the lanterns on the water
// rather than at a threshold of their own. By day they are unlit bulbs on a
// string, which is to say nothing at all.
const BULB = [255, 216, 150];
const BULB_HALO = [255, 186, 96];
const bulbCol = [0, 0, 0, 255];
const haloCol = [0, 0, 0, 255];

function dayLit(col, fog, sil, out) {
  const c = litColour(col, fog);
  const k = sil > 0.01 ? 1 - sil : 1;
  out[0] = Math.round(c[0] * k);
  out[1] = Math.round(c[1] * k);
  out[2] = Math.round(c[2] * k);
  out[3] = 255;
  return out;
}

// --- state -----------------------------------------------------------------

const pairs = [];
for (let i = 0; i < MAX_PAIRS; i++) {
  pairs.push({ live: false, a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 },
               style: 0, phase: 0, bob: 0, vx: 0, vz: 0, burnAt: 0 });
}

export function resetBalloons() {
  for (const p of pairs) p.live = false;
}

export function balloonCount() {
  return pairs.reduce((n, p) => n + (p.live ? 2 : 0), 0);
}

function place(p, px, pz) {
  const r = SPAWN_MIN + rnd() * (SPAWN_MAX - SPAWN_MIN);
  // The wedge is measured from the camera, which trails the craft, so the
  // depth that decides how wide it is out here is the one the camera sees.
  const wedge = (r / TILE + CAM_BACK) * HALF_WEDGE * SPAWN_SPREAD;
  const x = (px + rndSigned() * wedge * TILE) | 0;
  const z = (pz + r) | 0;
  const ground = Math.min(landAltitude(x, z), SEA_LEVEL);
  const ride = RIDE_LOW + rnd() * (RIDE_HIGH - RIDE_LOW);
  const y = (ground - TILE * ride) | 0;

  // The pair hangs along a bearing of its own, so bunting is not always
  // broadside to the camera.
  const span = PAIR_MIN + rnd() * (PAIR_MAX - PAIR_MIN);
  const bearing = rnd() * Math.PI * 2;
  p.a.x = x; p.a.y = y; p.a.z = z;
  p.b.x = (x + Math.cos(bearing) * span) | 0;
  p.b.y = (y + rndSigned() * TILE * 0.6) | 0;
  p.b.z = (z + Math.sin(bearing) * span) | 0;

  keepInBand(p.a);
  keepInBand(p.b);

  p.style = (Math.random() * CANVAS.length) | 0;
  p.phase = rnd() * Math.PI * 2;
  p.burnAt = (rnd() * 200) | 0;
  p.live = true;
}

export function updateBalloons(player) {
  for (const p of pairs) {
    if (!p.live) {
      if (Math.random() < 0.02) place(p, player.x, player.z);
      continue;
    }

    // They go where the air goes, and a good deal more slowly than it does.
    const wx = weather.windX * 2.2, wz = weather.windZ * 2.2;
    p.phase += 0.011;
    const lift = Math.sin(p.phase) * TILE * 0.0016;
    for (const b of [p.a, p.b]) {
      b.x = (b.x + wx) | 0;
      b.z = (b.z + wz) | 0;
      b.y = (b.y + lift) | 0;
      keepInBand(b);
    }

    const dx = (p.a.x - player.x) / TILE, dz = (p.a.z - player.z) / TILE;
    const wedge = (dz + CAM_BACK) * HALF_WEDGE * RETIRE_SPREAD + 6;
    if (Math.hypot(dx, dz) * TILE > RETIRE ||
        dz < -CAM_BACK - 4 ||
        Math.abs(dx) > wedge) p.live = false;
  }
}

// Everything beyond the drawn landscape, furthest first.
//
// It cannot go in a row, because there are no rows out there -- so it is
// drawn in one pass straight after the sky and before the horizon ranges.
// That ordering is the whole of the occlusion it needs: a balloon over the
// mountains is in the sky above the skyline, and one that dips below the
// skyline is hidden by the range in front of it, which is what would happen.
const far = [];

export function drawFarBalloons(rd, camX, camY, camZ) {
  far.length = 0;
  for (const p of pairs) {
    if (!p.live) continue;
    // Per balloon, not per pair: a pair can straddle the line, and the one
    // beyond it still has to be drawn by somebody.
    const aFar = p.a.z - camZ > FAR_MIN;
    const bFar = p.b.z - camZ > FAR_MIN;
    if (aFar) far.push(p.a, p, bFar ? 1 : 0);
    if (bFar) far.push(p.b, p, 0);
  }
  if (!far.length) return;

  // Furthest first. There is no depth buffer, so submission order is the
  // whole of what puts one balloon in front of another.
  const n = far.length / 3;
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((i, j) => far[j * 3].z - far[i * 3].z);

  for (const i of order) {
    const b = far[i * 3], p = far[i * 3 + 1], leads = far[i * 3 + 2];
    // Haze deepens with distance, starting where the landscape's own far
    // edge leaves off so a balloon and the ground under it agree about how
    // far away they are.
    const dz = (b.z - camZ) / TILE;
    const t = Math.min(1, Math.max(0, (dz - FAR_MIN / TILE) /
                                      ((FAR_HAZE - FAR_MIN) / TILE)));
    const fog = Math.min(0.94, fogForRow(1) + (1 - FOG_MAX) * t * 0.8);
    // The burner still shows out here. It is a lit face, so the haze does not
    // touch it, and a warm speck over the ranges after dark is most of the
    // reason for putting balloons that far away at all.
    const lit = sky.lamp > 0.05 && beacon(150, 16, p.burnAt);
    const model = (lit ? BALLOONS_LIT : BALLOONS)[p.style];
    drawModel(rd, model, null, b.x, b.y, b.z, camX, camY, camZ, fog, 0);
    // Only when both ends are out here. A pair straddling the line keeps its
    // bunting in the row pass, with the end of it the camera can reach.
    if (leads) drawBunting(rd, p, camX, camY, camZ, 0, fog);
  }
}

// Which pairs have a balloon standing in this band of ground, for the row
// bucketing -- the same arrangement the boats use, so a hill in front hides
// what is behind it.
export function balloonsInRow(zLo, zHi, out) {
  for (const p of pairs) {
    if (!p.live) continue;
    if (p.a.z >= zLo && p.a.z < zHi) out.push({ pair: p, which: 0 });
    if (p.b.z >= zLo && p.b.z < zHi) out.push({ pair: p, which: 1 });
  }
  return out;
}

const pt = { x: 0, y: 0 };
const pa = { x: 0, y: 0 };
const pb = { x: 0, y: 0 };
const flagCol = [0, 0, 0, 255];

// The bunting: a line sagging between the two baskets, with flags hanging off
// it. Drawn in screen space once the two ends are projected, which is what
// keeps a cord one pixel wide at any distance instead of vanishing.
function drawBunting(rd, p, camX, camY, camZ, sil, fog) {
  const N = 16;
  const lamp = sky.lamp;
  const ax = p.a.x, ay = p.a.y, az = p.a.z;
  const bx = p.b.x, by = p.b.y, bz = p.b.z;
  // Bunting is tied to the baskets, which hang below the envelopes.
  const drop = (BASKET_DROP + 0.2) * S * TILE;

  let prev = null;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = (ax + (bx - ax) * t) | 0;
    const z = (az + (bz - az) * t) | 0;
    // A sine is not a catenary, but at this size nobody has ever been able
    // to tell, and it costs one call instead of three.
    const sag = Math.sin(Math.PI * t) * SAG * TILE;
    const y = (ay + (by - ay) * t + drop + sag) | 0;
    if (!project((x - camX) | 0, (y - camY) | 0, (z - camZ) | 0, pt)) { prev = null; continue; }
    if (pt.x < -80 || pt.x > SCREEN_W + 80 || pt.y < -80 || pt.y > SCREEN_H + 80) {
      prev = { x: pt.x, y: pt.y };
      continue;
    }
    if (prev) {
      // The cord.
      const dx = pt.x - prev.x, dy = pt.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      rd.quad(prev.x + nx * 0.5, prev.y + ny * 0.5,
              pt.x + nx * 0.5, pt.y + ny * 0.5,
              pt.x - nx * 0.5, pt.y - ny * 0.5,
              prev.x - nx * 0.5, prev.y - ny * 0.5,
              dayLit(CORD_COL, fog, sil, buntCol));
      // A flag hanging from the middle of this span, sized by how near it is
      // so it shrinks with everything else.
      const mx = (prev.x + pt.x) / 2, my = (prev.y + pt.y) / 2;
      const h = Math.max(1.5, len * 0.9);
      const w = Math.max(1.2, len * 0.42);
      rd.tri(mx - w, my, mx + w, my, mx, my + h,
             dayLit(FLAGS[i % FLAGS.length], fog, sil, flagCol));

      // A bulb at this joint, sized off the same span the flag is, and
      // breathing slightly out of step with its neighbours.
      if (lamp > 0.04) {
        const twinkle = 0.72 + 0.28 * Math.sin(sky.tick * 0.055 + i * 1.7);
        // Small, and capped: a fairy light is a pinprick, and one sized off
        // the span alone becomes a lit window when the pair is close.
        const r = Math.min(1.6, Math.max(0.5, len * 0.10));
        bulbCol[0] = BULB[0]; bulbCol[1] = BULB[1]; bulbCol[2] = BULB[2];
        bulbCol[3] = Math.min(255, Math.round(255 * lamp * twinkle));
        haloCol[0] = BULB_HALO[0]; haloCol[1] = BULB_HALO[1]; haloCol[2] = BULB_HALO[2];
        haloCol[3] = Math.round(70 * lamp * twinkle);
        rd.rect(prev.x - r * 1.9, prev.y - r * 1.9, r * 3.8, r * 3.8, haloCol);
        rd.rect(prev.x - r, prev.y - r, r * 2, r * 2, bulbCol);
      }
    }
    prev = { x: pt.x, y: pt.y };
  }
}

export function drawBalloon(rd, entry, camX, camY, camZ, fog = 0) {
  const p = entry.pair;
  const b = entry.which ? p.b : p.a;

  const sil = silhouetteAmount((b.x - camX) / TILE, (b.z - camZ) / TILE);

  // The burner goes every few seconds, and only when it is dark enough for it
  // to show. It is the one light in the sky that is not a star.
  const lit = sky.lamp > 0.05 && beacon(150, 16, p.burnAt);
  const model = lit ? BALLOONS_LIT[p.style] : BALLOONS[p.style];
  drawModel(rd, model, null, b.x, b.y, b.z, camX, camY, camZ, fog, sil);

  // The bunting belongs to the pair, so only one of the two draws it.
  if (entry.which === 0) drawBunting(rd, p, camX, camY, camZ, sil, fog);
}
