// blocks.js -- the structures on the landscape, and knocking them over.
//
// Every built thing in the world is made of painted wooden toy blocks: cubes,
// bricks, pillars, turned cylinders, triangular roof prisms and half-round
// arch caps, in the primary colours a set like that always comes in. It suits
// a flat-shaded renderer exactly, and it makes the one rule of the toy box
// true here too -- if you knock it, it falls down.
//
// A structure is a list of placed blocks. The same list serves twice: merged
// into one model while it is standing, and animated block by block once it
// has been knocked over.

import {
  TILE, hash2, matMul, matRotX, matRotY, matRotZ, matApply,
} from './maths.js';
import { Model, facet, shade, drawModel, drawShadow } from './model.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { paint } from './style.js';

// --- the paint box ---------------------------------------------------------

// Painted a long time ago and left outside ever since. The set started in
// the primary colours a toy box always comes in -- pillar-box red, postbox
// blue, a yellow you could see from orbit -- which was right when the game
// was a shooting gallery and these were targets. Against a desert at dusk
// they were the only saturated thing in the world and they pulled the eye
// straight off the landscape.
//
// These are the same six colours with the sun taken out of them: clay, slate
// blue, ochre, sage, terracotta and a dusty plum. They still tell each block
// apart from the next -- which is the only thing the colour has to do -- and
// they sit in the same range as the rock and the scrub around them.
const RED    = paint([190,  98,  76]);   // clay
const BLUE   = paint([ 74, 114, 166]);   // slate
const YELLOW = paint([212, 168,  86]);   // ochre
const GREEN  = paint([100, 148,  90]);   // sage
const ORANGE = paint([202, 128,  74]);   // terracotta
const PURPLE = paint([140,  94, 148]);   // dusty plum
const WOOD   = paint([198, 166, 118]);   // unpainted, for the plain shapes
const WOOD_D = paint([150, 118,  80]);

// --- block shapes ----------------------------------------------------------
//
// Every block model is built centred on its own middle in all three axes.
// That is what lets a block tumble about its centre when the structure is
// knocked over, and it costs nothing while it is standing because the
// placement offset puts it back where it belongs.

function boxBlock(w, h, d, col) {
  const m = new Model();
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const v = (x, y, z) => m.vert(x, y, z);
  const q = [
    v(-hw, -hh, -hd), v(hw, -hh, -hd), v(hw, -hh, hd), v(-hw, -hh, hd),
    v(-hw,  hh, -hd), v(hw,  hh, -hd), v(hw,  hh, hd), v(-hw,  hh, hd),
  ];
  facet(m, [q[0], q[1], q[2], q[3]], shade(col, 1.12));   // top (-y is up)
  facet(m, [q[4], q[5], q[6], q[7]], shade(col, 0.55));   // bottom
  facet(m, [q[0], q[1], q[5], q[4]], col);
  facet(m, [q[3], q[2], q[6], q[7]], col);
  facet(m, [q[1], q[2], q[6], q[5]], col);
  facet(m, [q[0], q[3], q[7], q[4]], col);
  return m;
}

// A turned cylinder, eight sided. The flat of each stave catches the light
// differently, which is most of what makes it read as turned wood.
function cylBlock(r, h, col) {
  const m = new Model();
  const hh = h / 2;
  const SIDES = 8;
  const top = [], bot = [];
  for (let i = 0; i < SIDES; i++) {
    const a = (i / SIDES) * Math.PI * 2;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    top.push(m.vert(cx, -hh, cz));
    bot.push(m.vert(cx, hh, cz));
  }
  for (let i = 0; i < SIDES; i++) {
    const j = (i + 1) % SIDES;
    facet(m, [top[i], bot[i], bot[j], top[j]], col);
  }
  facet(m, top.slice(), shade(col, 1.14));
  facet(m, bot.slice(), shade(col, 0.55));
  return m;
}

// A triangular prism: the roof block, ridge running along z.
function roofBlock(w, h, d, col) {
  const m = new Model();
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const a0 = m.vert(-hw,  hh, -hd), a1 = m.vert(hw,  hh, -hd);
  const b0 = m.vert(-hw,  hh,  hd), b1 = m.vert(hw,  hh,  hd);
  const r0 = m.vert(0, -hh, -hd),   r1 = m.vert(0, -hh,  hd);
  facet(m, [a0, r0, r1, b0], shade(col, 1.08));   // left pitch
  facet(m, [a1, r0, r1, b1], shade(col, 0.86));   // right pitch
  facet(m, [a0, a1, r0], col);                    // gable ends
  facet(m, [b0, b1, r1], col);
  facet(m, [a0, a1, b1, b0], shade(col, 0.55));   // underside
  return m;
}

// A four-sided pyramid, for capping a tower.
function pyrBlock(w, h, d, col) {
  const m = new Model();
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const apex = m.vert(0, -hh, 0);
  const q = [
    m.vert(-hw, hh, -hd), m.vert(hw, hh, -hd),
    m.vert(hw, hh, hd), m.vert(-hw, hh, hd),
  ];
  for (let i = 0; i < 4; i++) facet(m, [apex, q[i], q[(i + 1) % 4]], col);
  facet(m, q.slice(), shade(col, 0.55));
  return m;
}

// The half-round that caps an archway: a half cylinder standing on its
// diameter, flat face down.
function archBlock(r, d, col, alongX) {
  const m = new Model();
  const hd = d / 2;
  const SIDES = 6;
  // The half round is built from its flat face up, then shifted down by half
  // its rise so that it too is centred on its own middle. Every block model
  // has to be, or it tumbles about a point that is not where it looks like
  // its centre is -- which is what left the first arch caps standing on edge
  // in the rubble instead of lying flat.
  const mid = r / 2;
  const top = [], bot = [];
  for (let i = 0; i <= SIDES; i++) {
    const a = (i / SIDES) * Math.PI;                 // half a turn only
    const cx = -Math.cos(a) * r, cy = -Math.sin(a) * r + mid;
    // Which way the barrel runs. Turning the finished block instead would
    // light it for the way it was built, not the way it ends up facing.
    top.push(alongX ? m.vert(-hd, cy, cx) : m.vert(cx, cy, -hd));
    bot.push(alongX ? m.vert(hd, cy, cx) : m.vert(cx, cy, hd));
  }
  for (let i = 0; i < SIDES; i++) {
    facet(m, [top[i], bot[i], bot[i + 1], top[i + 1]],
          shade(col, 0.82 + 0.3 * (i / SIDES)));
  }
  facet(m, [top[0], top[SIDES], bot[SIDES], bot[0]], shade(col, 0.55));  // flat
  facet(m, top.slice(), shade(col, 0.95));
  facet(m, bot.slice(), shade(col, 0.95));
  return m;
}

// --- placing blocks --------------------------------------------------------

// A placed block. `y` is the height of the block's centre above the ground,
// which is the natural way to write a stack down and the natural thing for
// the physics to work with afterwards.
function place(model, x, y, z, halfExtents, yaw = 0) {
  return { model, x, y, z, e: halfExtents, yaw };
}

const cube  = (s, col) => boxBlock(s, s, s, col);

// The recipes. Sizes are in tiles; a "unit" block is 0.6 of a tile, which
// puts a five-high tower well clear of the trees it stands among. There are
// correspondingly fewer of them on the map -- see the spawn table in
// objects.js -- because at this size a structure is a landmark rather than
// scenery, and a landscape full of landmarks has none.
const U = 0.6;

function tower() {
  const cols = [RED, BLUE, YELLOW, GREEN];
  const out = [];
  let y = 0;
  for (let i = 0; i < 4; i++) {
    const w = i === 2 ? U * 1.9 : U;              // one course laid long
    const h = U * 0.86;
    out.push(place(boxBlock(w, h, U, cols[i]), 0, y + h / 2, 0, [w / 2, h / 2, U / 2],
                   i === 2 ? 0.18 : 0));
    y += h;
  }
  out.push(place(roofBlock(U * 1.5, U, U * 1.5, ORANGE), 0, y + U / 2, 0,
                 [U * 0.75, U / 2, U * 0.75]));
  return out;
}

function archway() {
  const out = [];
  const legH = U * 2;
  for (const sx of [-1, 1]) {
    out.push(place(boxBlock(U * 0.7, legH, U * 0.7, WOOD), sx * U * 0.72, legH / 2, 0,
                   [U * 0.35, legH / 2, U * 0.35]));
  }
  const lintelH = U * 0.5;
  out.push(place(boxBlock(U * 2.5, lintelH, U * 0.8, RED),
                 0, legH + lintelH / 2, 0, [U * 1.25, lintelH / 2, U * 0.4]));
  out.push(place(archBlock(U * 1.1, U * 0.8, BLUE),
                 0, legH + lintelH + U * 0.55, 0, [U * 1.1, U * 0.55, U * 0.4]));
  out.push(place(cube(U * 0.7, YELLOW), 0, legH + lintelH + U * 1.1 + U * 0.35, 0,
                 [U * 0.35, U * 0.35, U * 0.35]));
  return out;
}

function castle() {
  const out = [];
  const baseH = U * 0.6;
  out.push(place(boxBlock(U * 3.2, baseH, U * 1.5, GREEN), 0, baseH / 2, 0,
                 [U * 1.6, baseH / 2, U * 0.75]));
  // A round turret at each end, with a pointed cap.
  const turH = U * 2.2;
  for (const [sx, col] of [[-1, RED], [1, BLUE]]) {
    out.push(place(cylBlock(U * 0.52, turH, col), sx * U * 1.2, baseH + turH / 2, 0,
                   [U * 0.52, turH / 2, U * 0.52]));
    out.push(place(pyrBlock(U * 1.1, U * 0.9, U * 1.1, YELLOW),
                   sx * U * 1.2, baseH + turH + U * 0.45, 0,
                   [U * 0.55, U * 0.45, U * 0.55]));
  }
  // Battlements along the wall between them.
  for (const sx of [-0.45, 0.45]) {
    out.push(place(cube(U * 0.62, PURPLE), sx * U, baseH + U * 0.31, 0,
                   [U * 0.31, U * 0.31, U * 0.31]));
  }
  return out;
}

function bridge() {
  const out = [];
  const pierH = U * 1.5;
  for (const [sx, col] of [[-1, BLUE], [1, RED]]) {
    out.push(place(boxBlock(U * 0.8, pierH, U * 0.9, col), sx * U * 1.35, pierH / 2, 0,
                   [U * 0.4, pierH / 2, U * 0.45]));
  }
  const deckH = U * 0.45;
  out.push(place(boxBlock(U * 4, deckH, U * 1.1, WOOD), 0, pierH + deckH / 2, 0,
                 [U * 2, deckH / 2, U * 0.55]));
  out.push(place(cylBlock(U * 0.4, U * 0.9, YELLOW), 0, pierH + deckH + U * 0.45, 0,
                 [U * 0.4, U * 0.45, U * 0.4]));
  return out;
}

// A stack nobody was careful with: every course a bit off and a bit turned.
// It is the one that looks like it is about to go over on its own, which is
// exactly the invitation this game wants to extend.
function wobbly() {
  const cols = [YELLOW, PURPLE, GREEN, ORANGE, BLUE, RED];
  const out = [];
  let y = 0, ox = 0, oz = 0;
  for (let i = 0; i < 6; i++) {
    const h = U * (i % 2 ? 0.55 : 0.8);
    const w = U * (i % 3 === 1 ? 1.4 : 0.9);
    ox += (i % 2 ? 1 : -1) * U * 0.16;
    oz += (i % 3 === 0 ? 1 : -1) * U * 0.1;
    out.push(place(boxBlock(w, h, U * 0.9, cols[i]), ox, y + h / 2, oz,
                   [w / 2, h / 2, U * 0.45], i * 0.31));
    y += h;
  }
  return out;
}

function steps() {
  const out = [];
  const cols = [BLUE, GREEN, RED];
  let y = 0;
  for (let i = 0; i < 3; i++) {
    const w = U * (2.6 - i * 0.7);
    const h = U * 0.55;
    out.push(place(boxBlock(w, h, w, cols[i]), 0, y + h / 2, 0, [w / 2, h / 2, w / 2]));
    y += h;
  }
  out.push(place(pyrBlock(U * 1.1, U * 1.0, U * 1.1, WOOD_D), 0, y + U * 0.5, 0,
                 [U * 0.55, U * 0.5, U * 0.55]));
  return out;
}

// A gateway: two piers and a beam across them, built at a size you can fly
// through rather than a size you can knock over.
//
// The small archway above is a toy: its opening is barely wider than the
// craft and it goes over like everything else in the box. This is the other
// thing entirely -- the built answer to the rock arch, standing where a rock
// arch would stand and open in the same way. It is the one structure that
// does not topple, because a thing you are meant to aim at has to be a thing
// you can pass through, and collision here is a cylinder that would put an
// invisible wall across the very gap you were lining up for.
//
// `alongZ` faces it the other way. Like the rock arch it is built facing that
// way rather than turned afterwards: the shading of every block is worked out
// when the block is made, so a block turned a quarter turn later would be lit
// as though it had not been.
function gateway(alongZ) {
  const out = [];
  const span = U * 2.6;          // half the distance between the piers
  const pierW = U * 0.92, pierD = U * 1.05;
  const pierH = U * 3.2;
  // Across the span and along it: the piers are deeper than they are wide,
  // so the gateway reads as something with a front and a back.
  const dim = (w, d) => (alongZ ? [d, w] : [w, d]);
  const at = (u, v) => (alongZ ? [v, u] : [u, v]);

  for (const [su, col] of [[-1, RED], [1, BLUE]]) {
    const [w, d] = dim(pierW, pierD);
    const [px, pz] = at(su * span, 0);
    out.push(place(boxBlock(w, pierH, d, col), px, pierH / 2, pz,
                   [w / 2, pierH / 2, d / 2]));
    // A wider foot, so it looks like it is standing rather than planted.
    const [fw, fd] = dim(pierW * 1.5, pierD * 1.2);
    out.push(place(boxBlock(fw, U * 0.4, fd, WOOD_D), px, U * 0.2, pz,
                   [fw / 2, U * 0.2, fd / 2]));
  }

  const beamH = U * 0.62;
  const [bw, bd] = dim(span * 2 + pierW * 1.6, pierD * 0.9);
  out.push(place(boxBlock(bw, beamH, bd, WOOD), 0, pierH + beamH / 2, 0,
                 [bw / 2, beamH / 2, bd / 2]));

  // A half round over the beam, lying along the span, and a plain block on
  // top of that -- the same grammar as the little archway, at four times the
  // size.
  const capR = U * 1.05;
  out.push(place(archBlock(capR, pierD * 0.92, YELLOW, alongZ),
                 0, pierH + beamH + capR * 0.5, 0,
                 [capR, capR * 0.5, capR]));
  return out;
}

const RECIPES = [tower, archway, castle, bridge, wobbly, steps,
                 () => gateway(false), () => gateway(true)];

// Which recipes you can fly through, and which of those face along z. They
// are placed like the rock arches -- on their own, with room round them --
// rather than sprinkled in with the rest.
export const OPEN_STRUCTURES = [6, 7];
export const OPEN_ALONG_Z = [7];

// Build each recipe once: the block list for toppling, and the whole thing
// merged into a single model for while it is standing.
function assemble(blocks) {
  const whole = new Model();
  const yawMat = new Float64Array(9);
  for (const b of blocks) {
    matRotY(b.yaw, yawMat);
    const base = whole.verts.length / 3;
    const src = b.model.verts;
    for (let i = 0; i < src.length; i += 3) {
      const r = matApply(yawMat, src[i], src[i + 1], src[i + 2]);
      whole.verts.push(
        (r[0] + b.x * TILE) | 0,
        (r[1] - b.y * TILE) | 0,        // +y is down, so "up" subtracts
        (r[2] + b.z * TILE) | 0,
      );
    }
    for (const f of b.model.faces) {
      whole.faces.push({ idx: f.idx.map((i) => i + base), col: f.col });
    }
    const top = (b.y + b.e[1]) * TILE;
    if (top > whole.height) whole.height = top | 0;
    const reach = (Math.hypot(b.x, b.z) + Math.max(b.e[0], b.e[2])) * TILE;
    if (reach > whole.radius) whole.radius = reach | 0;
  }
  return whole;
}

export const STRUCTURES = RECIPES.map((r) => {
  const blocks = r();
  return { blocks, model: assemble(blocks) };
});

export const STRUCTURE_COUNT = STRUCTURES.length;

// ---------------------------------------------------------------------------
// Knocking them over
// ---------------------------------------------------------------------------
//
// Once a structure has been hit it stops being one model and becomes its
// blocks again, each falling and tumbling on its own. They bounce once or
// twice, then settle -- and on settling their pitch and roll snap to the
// nearest quarter turn, so they come to rest lying flat on a face the way a
// real block does instead of half buried at whatever angle they happened to
// stop at.

const GRAVITY = TILE * 0.0026;     // per 50Hz frame
const SETTLE = TILE * 0.010;       // below this the next landing is the last
const BOUNCE = 0.30;
const FRICTION = 0.55;

// Far more structures can be knocked over in one game than can ever be on
// screen, and the world is endless, so old rubble is forgotten once there is
// too much of it. By then it is many tiles behind you.
const MAX_PILES = 240;

const piles = new Map();           // "tx,tz" -> { type, parts, live }

export function resetBlocks() {
  piles.clear();
}

const KEY = (tx, tz) => tx + ',' + tz;

export function pileAt(tx, tz) {
  return piles.get(KEY(tx, tz));
}

export function isKnocked(tx, tz) {
  return piles.has(KEY(tx, tz));
}

const rx = new Float64Array(9), ry = new Float64Array(9), rz = new Float64Array(9);
const tmp = new Float64Array(9);

function buildMat(p) {
  matRotY(p.ay, ry);
  matRotX(p.ax, rx);
  matRotZ(p.az, rz);
  matMul(ry, rx, tmp);
  matMul(tmp, rz, p.mat);
}

// How far the block's centre sits above the ground when it is lying still --
// the box's own half-extents projected onto world up. Exact for any rotation,
// which is what keeps a tumbled block sitting on the dirt rather than in it.
function halfV(p) {
  const m = p.mat;
  return (Math.abs(m[3]) * p.e[0] + Math.abs(m[4]) * p.e[1] + Math.abs(m[5]) * p.e[2]) * TILE;
}

const QUARTER = Math.PI / 2;
const snap = (a) => Math.round(a / QUARTER) * QUARTER;

// A long thin block does not come to rest balanced on its end. It can happen,
// and it did -- a pillar left standing bolt upright in the middle of its own
// rubble, looking for all the world as though it had been missed. So a block
// that settles on its longest axis is tipped onto whichever face leaves it
// lying flattest.
//
// Yaw is left alone, so the pile keeps the scattered look the tumble gave it.
// The six orientations a snapped block can lie in, as absolute pitch and
// roll. They have to be absolute rather than offsets from wherever it stopped:
// pitch and roll do not commute, so adding a quarter turn to each in turn does
// not reliably reach all three choices of which axis ends up vertical, which
// is why the first attempt still left the odd pillar on its end.
const LIE = [[0, 0], [QUARTER, 0], [Math.PI, 0], [-QUARTER, 0], [0, QUARTER], [0, -QUARTER]];

function layDown(p) {
  const e = p.e;
  const longest = Math.max(e[0], e[1], e[2]);
  if (longest < Math.min(e[0], e[1], e[2]) * 1.35) return;   // near enough a cube

  buildMat(p);
  // Did it settle standing on its longest axis?
  if (halfV(p) < longest * TILE - 1) return;

  let bestAx = p.ax, bestAz = p.az, best = Infinity;
  for (const [ax, az] of LIE) {
    p.ax = ax;
    p.az = az;
    buildMat(p);
    const v = halfV(p);
    if (v < best) { best = v; bestAx = ax; bestAz = az; }
  }
  p.ax = bestAx;
  p.az = bestAz;
  buildMat(p);
}

// Start a topple. `force` scales the whole thing: a shove from the drone is
// about 1, a bomb going off underneath is 3 or more.
export function topple(tx, tz, type, wx, base, wz, hitX, hitZ, force) {
  const k = KEY(tx, tz);
  if (piles.has(k)) return false;

  if (piles.size >= MAX_PILES) piles.delete(piles.keys().next().value);

  const parts = [];
  const yawMat = new Float64Array(9);
  for (const b of STRUCTURES[type].blocks) {
    matRotY(b.yaw, yawMat);
    const o = matApply(yawMat, b.x * TILE, 0, b.z * TILE);
    const px = (wx + o[0]) | 0;
    const pz = (wz + o[2]) | 0;
    const py = (base - b.y * TILE) | 0;

    // Everything is shoved away from where it was hit, and the higher a block
    // sat the harder it goes -- which is what makes a tall stack fold over
    // from the top rather than burst outwards from the bottom.
    let dx = px - hitX, dz = pz - hitZ;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const lift = 0.35 + b.y * 0.9;
    const kick = force * TILE * 0.006 * lift;
    const jitter = () => (Math.random() - 0.5);

    parts.push({
      model: b.model,
      x: px, y: py, z: pz,
      vx: dx * kick + jitter() * TILE * 0.004 * force,
      vy: -force * TILE * 0.005 * (0.4 + b.y),
      vz: dz * kick + jitter() * TILE * 0.004 * force,
      ax: 0, ay: b.yaw, az: 0,
      sx: jitter() * 0.10 * force + dz * 0.05 * force,
      sy: jitter() * 0.07 * force,
      sz: jitter() * 0.10 * force - dx * 0.05 * force,
      e: b.e,
      rest: false,
      mat: new Float64Array(9),
    });
    buildMat(parts[parts.length - 1]);
  }

  piles.set(k, { type, parts, live: parts.length });
  return true;
}

export function updateBlocks() {
  for (const ent of piles.values()) {
    if (ent.live === 0) continue;
    let live = 0;
    for (const p of ent.parts) {
      if (p.rest) continue;

      p.vy += GRAVITY;
      p.x = (p.x + p.vx) | 0;
      p.y = (p.y + p.vy) | 0;
      p.z = (p.z + p.vz) | 0;
      p.ax += p.sx; p.ay += p.sy; p.az += p.sz;
      buildMat(p);

      const ground = landAltitude(p.x, p.z);
      // A block that ends up in the sea just sinks and is done with.
      if (ground >= SEA_LEVEL) {
        if (p.y >= ground) { p.rest = true; p.sunk = true; }
        else live++;
        continue;
      }

      const floor = (ground - halfV(p)) | 0;
      if (p.y >= floor) {
        p.y = floor;
        if (p.vy > SETTLE) {
          p.vy = -p.vy * BOUNCE;
          p.vx *= FRICTION; p.vz *= FRICTION;
          p.sx *= 0.45; p.sy *= 0.7; p.sz *= 0.45;
        } else {
          p.vx = p.vy = p.vz = 0;
          p.sx = p.sy = p.sz = 0;
          p.ax = snap(p.ax);
          p.az = snap(p.az);
          buildMat(p);
          layDown(p);
          p.y = (ground - halfV(p)) | 0;
          p.rest = true;
        }
      }
      if (!p.rest) live++;
    }
    ent.live = live;
  }
}

export function drawPile(rd, ent, camX, camY, camZ, fog, row) {
  // Shadows for the whole pile first, then the blocks, so no block is drawn
  // underneath another's shadow.
  for (const p of ent.parts) {
    if (p.sunk) continue;
    const ground = landAltitude(p.x, p.z);
    const lift = Math.max(0, ground - p.y);
    const r = Math.max(p.e[0], p.e[2]) * TILE;
    drawShadow(rd, p.x, p.z, r * 1.15, 0.66, camX, camY, camZ, row, fog, lift);
  }
  for (const p of ent.parts) {
    if (p.sunk) continue;
    drawModel(rd, p.model, p.mat, p.x, p.y, p.z, camX, camY, camZ, fog);
  }
}

// Where the blocks of a settled pile are, for the shadows to follow.
export function pileParts(ent) {
  return ent.parts;
}
