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
import { Model, facet, shade, recolour, drawModel, drawShadow } from './model.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { paint } from './style.js';
import { TUNDRA, DESERT } from './biome.js';

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

// The same set, mixed for the ground it is standing on.
//
// A red-and-blue tower in the middle of a desert was the only thing for miles
// that the sun had not got to, and a painted castle on an ice field looked
// like it had been dropped there from another game. Out here things weather
// into what they are standing on: timber left in a desert goes the colour of
// the sand, and anything left in a frozen place ends up rimed.
//
// One counterpart per colour rather than a formula, so a stack is still six
// blocks you can tell apart. Where a formula does come in is the shading: a
// face is its block's colour scaled by how the light catches it, so the
// substitution keeps that scale factor and only swaps what it is a factor of.
// Every facet, edge and roof pitch stays exactly as legible as it was.
const PAINTBOX = [RED, BLUE, YELLOW, GREEN, ORANGE, PURPLE, WOOD, WOOD_D];

// Written in the style's own terms rather than passed through `paint()` like
// every other palette here, and that is deliberate. The serene transform
// posterises value into four steps; run a set of eight through it and they
// come out as two, which is exactly what you do not want from a set whose
// whole job is to stay distinguishable from itself. These are already mixed
// for the style -- muted, inside its value band -- and are simply spread
// across it rather than bunched.
const SANDSTONE = [
  [158, 108,  84],   // rust
  [110,  92,  78],   // shadowed sand
  [204, 186, 152],   // pale sand
  [170, 152, 120],   // dun
  [190, 154, 104],   // ochre
  [136, 118, 112],   // mauve rock
  [196, 176, 142],   // bleached timber
  [146, 124,  96],
];

const RIME = [
  [186, 198, 210],   // rime
  [112, 142, 176],   // deep ice
  [210, 220, 230],   // snow
  [150, 184, 190],   // glacier
  [164, 180, 202],   // frost
  [128, 138, 166],   // shadowed drift
  [200, 212, 224],   // frosted timber
  [142, 158, 182],
];

const BIOME_SET = [];
BIOME_SET[TUNDRA] = RIME;
BIOME_SET[DESERT] = SANDSTONE;

const lum = (c) => 0.30 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// Which of the eight a face came from. Shading multiplies all three channels
// by the same figure, so the direction of the colour survives it and the
// nearest direction is the right answer rather than a guess -- see the check
// in the tests, which reproduces every face in every structure to within a
// couple of levels.
function nearest(col) {
  const l = lum(col) || 1;
  let best = 0, bestErr = 1e9;
  for (let i = 0; i < PAINTBOX.length; i++) {
    const b = PAINTBOX[i];
    const bl = lum(b) || 1;
    let err = 0;
    for (let k = 0; k < 3; k++) {
      const d = col[k] / l - b[k] / bl;
      err += d * d;
    }
    if (err < bestErr) { bestErr = err; best = i; }
  }
  return best;
}

export function dressColour(col, biome) {
  const set = BIOME_SET[biome];
  if (!set) return col;
  const i = nearest(col);
  const f = lum(col) / (lum(PAINTBOX[i]) || 1);
  const t = set[i];
  return [clamp8(t[0] * f), clamp8(t[1] * f), clamp8(t[2] * f)];
}

// Re-dressed models, built the first time a biome asks for one. `recolour`
// shares the vertices, so a variant is a face list and nothing else.
const dressCache = new Map();

export function dressModel(model, biome) {
  if (!BIOME_SET[biome]) return model;
  let byBiome = dressCache.get(model);
  if (!byBiome) dressCache.set(model, (byBiome = []));
  if (!byBiome[biome]) {
    byBiome[biome] = recolour(model, (c) => dressColour(c, biome));
  }
  return byBiome[biome];
}

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
function archBlock(r, d, col) {
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
    top.push(m.vert(cx, cy, -hd));
    bot.push(m.vert(cx, cy, hd));
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

// The arch block: a block with a doorway cut through it.
//
// This is the piece the set is remembered for, and the game had no version of
// it -- only the solid half-round above, which is an arch's top rather than an
// arch. On its own a half-round laid over a gap reads as a dome, because that
// is what it is.
//
// The opening is swept the same way the rock arch's was: from the curve
// outward along the radius until it meets the block's own outline, so the
// stone above the hole is thick at the haunches and thin over the crown
// without any of it being written down twice.
function gateBlock(w, h, d, col) {
  const m = new Model();
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const r = Math.min(hw * 0.74, h * 0.66);
  const SEG = 7;

  const inner = [], outer = [];
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI;
    const dx = -Math.cos(a), dy = -Math.sin(a);       // -y is up
    inner.push([dx * r, hh + dy * r]);
    // How far the radius runs before it leaves the block.
    let t = Infinity;
    if (dx > 0.0001) t = Math.min(t, hw / dx);
    if (dx < -0.0001) t = Math.min(t, -hw / dx);
    if (dy < -0.0001) t = Math.min(t, h / -dy);
    outer.push([dx * t, hh + dy * t]);
  }

  const v = (p, z) => m.vert(p[0], p[1], z);
  for (let i = 0; i < SEG; i++) {
    const i0 = inner[i], i1 = inner[i + 1], o0 = outer[i], o1 = outer[i + 1];
    // The two faces of the block, the outside of it, and the soffit.
    facet(m, [v(i0, -hd), v(i1, -hd), v(o1, -hd), v(o0, -hd)], col);
    facet(m, [v(i0, hd), v(i1, hd), v(o1, hd), v(o0, hd)], col);
    facet(m, [v(o0, -hd), v(o1, -hd), v(o1, hd), v(o0, hd)], shade(col, 1.06));
    facet(m, [v(i0, -hd), v(i1, -hd), v(i1, hd), v(i0, hd)], shade(col, 0.62));
  }
  // The feet it stands on.
  for (const sx of [-1, 1]) {
    const x0 = sx * r, x1 = sx * hw;
    facet(m, [m.vert(x0, hh, -hd), m.vert(x1, hh, -hd),
              m.vert(x1, hh, hd), m.vert(x0, hh, hd)], shade(col, 0.55));
  }
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

// The recipes.
//
// They were built when a structure had to survive being shot at and were sized
// accordingly: four or five blocks, a metre or two of toy. A real set of these
// blocks gets stacked until it is taller than the child stacking it, with
// arches spanning gaps and a cone or a roof on the very top, and that is what
// these are now -- ten to fourteen blocks, three to four and a half tiles
// tall, wide enough at the base to be worth flying round.
//
// The arch blocks earn their keep here. There was exactly one in the whole
// world before, buried in the small archway, and a half-round spanning two
// pillars is the most recognisable thing in a box of wooden blocks.

// A tower: two storeys of pillars, each spanned by an arch, on a plinth, with
// a roof. The kind of thing that is one nudge from going over, which is the
// invitation.
function tower() {
  const out = [];
  const plinth = U * 0.5;
  out.push(place(boxBlock(U * 2.5, plinth, U * 1.5, GREEN), 0, plinth / 2, 0,
                 [U * 1.25, plinth / 2, U * 0.75]));
  let y = plinth;

  // Two storeys, each a pair of pillars with a span across them.
  for (const [pillarH, cols] of [[U * 1.7, [RED, BLUE]], [U * 1.5, [YELLOW, PURPLE]]]) {
    const pw = U * 0.5;
    for (let i = 0; i < 2; i++) {
      const sx = i ? 1 : -1;
      out.push(place(boxBlock(pw, pillarH, pw, cols[i]), sx * U * 0.72, y + pillarH / 2, 0,
                     [pw / 2, pillarH / 2, pw / 2]));
    }
    // The span: an arch block bridging the two pillars, and a lintel over it
    // tying them together.
    out.push(place(gateBlock(U * 1.94, U * 0.92, U * 0.5, ORANGE),
                   0, y + pillarH - U * 0.46, 0, [U * 0.97, U * 0.46, U * 0.25]));
    const lint = U * 0.36;
    out.push(place(boxBlock(U * 2.1, lint, U * 0.62, WOOD), 0, y + pillarH + lint / 2, 0,
                   [U * 1.05, lint / 2, U * 0.31]));
    y += pillarH + lint;
  }

  out.push(place(cube(U * 0.8, RED), 0, y + U * 0.4, 0, [U * 0.4, U * 0.4, U * 0.4], 0.2));
  y += U * 0.8;
  out.push(place(roofBlock(U * 1.5, U * 1.1, U * 1.5, BLUE), 0, y + U * 0.55, 0,
                 [U * 0.75, U * 0.55, U * 0.75]));
  return out;
}

// A gateway: one big arch on two thick piers, with a stack on top of it.
function archway() {
  const out = [];
  const legH = U * 2.6;
  const pw = U * 0.78;
  for (const [sx, col] of [[-1, WOOD], [1, WOOD_D]]) {
    out.push(place(boxBlock(pw, legH, pw, col), sx * U * 1.02, legH / 2, 0,
                   [pw / 2, legH / 2, pw / 2]));
  }
  const lintelH = U * 0.55;
  out.push(place(boxBlock(U * 2.9, lintelH, U * 0.9, RED),
                 0, legH + lintelH / 2, 0, [U * 1.45, lintelH / 2, U * 0.45]));
  let y = legH + lintelH;
  out.push(place(gateBlock(U * 2.3, U * 1.15, U * 0.9, BLUE), 0, y + U * 0.575, 0,
                 [U * 1.15, U * 0.575, U * 0.45]));
  y += U * 1.15;
  out.push(place(cylBlock(U * 0.42, U * 1.1, YELLOW), 0, y + U * 0.55, 0,
                 [U * 0.42, U * 0.55, U * 0.42]));
  y += U * 1.1;
  out.push(place(pyrBlock(U * 0.95, U * 0.95, U * 0.95, GREEN), 0, y + U * 0.48, 0,
                 [U * 0.48, U * 0.48, U * 0.48]));
  return out;
}

// A castle: a long wall with an arched gate through it and a turret at each
// end, which is what everybody builds first.
function castle() {
  const out = [];
  const baseH = U * 0.6;
  out.push(place(boxBlock(U * 4.4, baseH, U * 1.6, GREEN), 0, baseH / 2, 0,
                 [U * 2.2, baseH / 2, U * 0.8]));

  // The gate: two short piers, an arch, and a wall over the top of it.
  const gateH = U * 1.3, gp = U * 0.44;
  for (const sx of [-1, 1]) {
    out.push(place(boxBlock(gp, gateH, U * 1.2, WOOD), sx * U * 0.62, baseH + gateH / 2, 0,
                   [gp / 2, gateH / 2, U * 0.6]));
  }
  out.push(place(gateBlock(U * 1.68, U * 1.3, U * 1.2, ORANGE),
                 0, baseH + gateH / 2, 0, [U * 0.84, gateH / 2, U * 0.6]));
  out.push(place(boxBlock(U * 1.9, U * 0.5, U * 1.2, PURPLE),
                 0, baseH + gateH + U * 0.25, 0, [U * 0.95, U * 0.25, U * 0.6]));

  // A round turret at each end, capped.
  const turH = U * 3.0;
  for (const [sx, col] of [[-1, RED], [1, BLUE]]) {
    out.push(place(cylBlock(U * 0.56, turH, col), sx * U * 1.72, baseH + turH / 2, 0,
                   [U * 0.56, turH / 2, U * 0.56]));
    out.push(place(pyrBlock(U * 1.2, U * 1.0, U * 1.2, YELLOW),
                   sx * U * 1.72, baseH + turH + U * 0.5, 0,
                   [U * 0.6, U * 0.5, U * 0.6]));
  }
  // Battlements along the wall between them.
  for (const sx of [-0.35, 0.35]) {
    out.push(place(cube(U * 0.6, WOOD_D), sx * U * 2.6, baseH + gateH + U * 0.8, 0,
                   [U * 0.3, U * 0.3, U * 0.3]));
  }
  return out;
}

// A bridge: three piers, two arches under it, and a deck laid across the lot.
function bridge() {
  const out = [];
  const pierH = U * 1.9;
  const pw = U * 0.7;
  [[-2.0, BLUE], [0, WOOD_D], [2.0, RED]].forEach(([sx, col]) => {
    out.push(place(boxBlock(pw, pierH, U * 1.0, col), sx * U, pierH / 2, 0,
                   [pw / 2, pierH / 2, U * 0.5]));
  });
  for (const sx of [-1, 1]) {
    out.push(place(gateBlock(U * 1.3, U * 1.2, U * 0.9, ORANGE), sx * U, pierH - U * 0.6, 0,
                   [U * 0.65, U * 0.6, U * 0.45]));
  }
  const deckH = U * 0.5;
  out.push(place(boxBlock(U * 5.2, deckH, U * 1.2, WOOD), 0, pierH + deckH / 2, 0,
                 [U * 2.6, deckH / 2, U * 0.6]));
  // Something standing on it, because an empty bridge is a plank.
  out.push(place(cylBlock(U * 0.44, U * 1.2, YELLOW), 0, pierH + deckH + U * 0.6, 0,
                 [U * 0.44, U * 0.6, U * 0.44]));
  out.push(place(pyrBlock(U * 0.9, U * 0.8, U * 0.9, GREEN), 0,
                 pierH + deckH + U * 1.2 + U * 0.4, 0, [U * 0.45, U * 0.4, U * 0.45]));
  return out;
}

// A stack nobody was careful with: every course a bit off and a bit turned.
// It is the one that looks like it is about to go over on its own, which is
// exactly the invitation this game wants to extend.
function wobbly() {
  const cols = [YELLOW, PURPLE, GREEN, ORANGE, BLUE, RED, WOOD, BLUE];
  const out = [];
  let y = 0, ox = 0, oz = 0;
  for (let i = 0; i < 8; i++) {
    const h = U * (i % 2 ? 0.62 : 0.9);
    const w = U * (i % 3 === 1 ? 1.7 : 1.1);
    ox += (i % 2 ? 1 : -1) * U * 0.2;
    oz += (i % 3 === 0 ? 1 : -1) * U * 0.12;
    out.push(place(boxBlock(w, h, U * 1.05, cols[i]), ox, y + h / 2, oz,
                   [w / 2, h / 2, U * 0.525], i * 0.31));
    y += h;
  }
  out.push(place(cylBlock(U * 0.4, U * 0.9, WOOD_D), ox, y + U * 0.45, oz,
                 [U * 0.4, U * 0.45, U * 0.4]));
  return out;
}

// Steps: a ziggurat, with a column and a cone on the top of it.
function steps() {
  const out = [];
  const cols = [BLUE, GREEN, RED, PURPLE];
  let y = 0;
  for (let i = 0; i < 4; i++) {
    const w = U * (3.4 - i * 0.7);
    const h = U * 0.6;
    out.push(place(boxBlock(w, h, w, cols[i]), 0, y + h / 2, 0, [w / 2, h / 2, w / 2]));
    y += h;
  }
  out.push(place(cylBlock(U * 0.42, U * 1.2, WOOD), 0, y + U * 0.6, 0,
                 [U * 0.42, U * 0.6, U * 0.42]));
  y += U * 1.2;
  out.push(place(pyrBlock(U * 1.0, U * 1.1, U * 1.0, ORANGE), 0, y + U * 0.55, 0,
                 [U * 0.5, U * 0.55, U * 0.5]));
  return out;
}

// --- things that grow, built the same way -----------------------------------
//
// Trees and cacti used to be single models, and flying into one ended the
// flight. They are stacks now, for the same reason everything else here is:
// so they go over when you clip them. It costs a handful of faces each and it
// turns every wood in the world into something you can knock about.
//
// It also means a tree is no longer lethal. That is the trade, and it is the
// right way round for this game -- the ground is the thing that ends a
// flight, and a fir tree was never going to be the other one.
const TRUNK    = [118,  92,  66];
const LEAF_A   = [ 96, 124,  84];
const LEAF_B   = [ 78, 106,  72];
const FIR_A    = [ 74, 102,  82];
const FIR_B    = [ 58,  84,  68];
const SNOW_W   = [222, 230, 238];
const CACTUS_A = [110, 142, 106];
const CACTUS_B = [ 92, 124,  92];

// A conifer: a trunk and three square tiers, each a little smaller and a
// little turned. Square rather than conical because these are blocks -- and
// because a stack of squares is what falls apart interestingly.
function conifer(snowy) {
  const out = [];
  const t = U * 0.26;
  const trunkH = U * 0.80;
  out.push(place(boxBlock(t, trunkH, t, TRUNK), 0, trunkH / 2, 0,
                 [t / 2, trunkH / 2, t / 2]));
  let y = trunkH;
  const tiers = [[U * 1.34, U * 0.56], [U * 1.02, U * 0.50], [U * 0.68, U * 0.44]];
  tiers.forEach(([w, h], i) => {
    const col = snowy ? (i % 2 ? FIR_B : SNOW_W) : (i % 2 ? FIR_B : FIR_A);
    out.push(place(boxBlock(w, h, w, col), 0, y + h / 2, 0,
                   [w / 2, h / 2, w / 2], (i - 1) * 0.24));
    y += h * 0.84;
  });
  const cap = U * 0.58;
  out.push(place(pyrBlock(cap, cap * 1.1, cap, snowy ? SNOW_W : FIR_A),
                 0, y + cap * 0.55, 0, [cap / 2, cap * 0.55, cap / 2]));
  return out;
}

// A broadleaf: a turned trunk and a canopy of two blocks, the upper one
// shoved off to one side so no two trees look stamped.
function broadleaf(tall) {
  const out = [];
  const trunkH = tall ? U * 1.66 : U * 1.02;
  const r = U * 0.15;
  out.push(place(cylBlock(r, trunkH, TRUNK), 0, trunkH / 2, 0, [r, trunkH / 2, r]));
  const c = tall ? U * 1.20 : U * 0.98;
  const h1 = U * 0.72, h2 = U * 0.52;
  out.push(place(boxBlock(c, h1, c * 0.92, LEAF_A), 0, trunkH + h1 / 2, 0,
                 [c / 2, h1 / 2, c * 0.46], 0.26));
  out.push(place(boxBlock(c * 0.70, h2, c * 0.70, LEAF_B),
                 U * 0.10, trunkH + h1 + h2 / 2, -U * 0.06,
                 [c * 0.35, h2 / 2, c * 0.35], -0.32));
  return out;
}

// A columnar cactus: a trunk and two arms that spur out and turn up, at
// different heights and on opposite sides.
function saguaro() {
  const out = [];
  const h = U * 2.46, r = U * 0.21;
  out.push(place(cylBlock(r, h, CACTUS_A), 0, h / 2, 0, [r, h / 2, r]));
  for (const [side, at, reach, rise] of [[1, 0.92, 0.38, 0.72], [-1, 1.42, 0.32, 0.54]]) {
    const armW = U * 0.17;
    out.push(place(boxBlock(U * reach, armW, armW, CACTUS_B),
                   side * U * (reach / 2 + 0.16), U * at, 0,
                   [U * reach / 2, armW / 2, armW / 2]));
    const ar = U * 0.13;
    out.push(place(cylBlock(ar, U * rise, CACTUS_A),
                   side * U * (reach + 0.14), U * (at + rise / 2), 0,
                   [ar, U * rise / 2, ar]));
  }
  return out;
}

// Built things first, then growing things, and the split is named rather than
// implied: objects.js spawns them from different tables, and the biome paint
// -- sandstone in the desert, rime in the cold -- belongs to the toy blocks
// only. A cactus dressed as sandstone is a rock, and we have just spent three
// commits taking the rocks out.
const BUILT_RECIPES = [tower, archway, castle, bridge, wobbly, steps];
const PLANT_RECIPES = [
  () => conifer(false), () => conifer(true),
  () => broadleaf(false), () => broadleaf(true), saguaro,
];

const RECIPES = [...BUILT_RECIPES, ...PLANT_RECIPES];

// Which index in STRUCTURES each one is.
export const BUILT = BUILT_RECIPES.map((_, i) => i);
export const PLANT = {
  FIR: BUILT_RECIPES.length,
  SNOW_FIR: BUILT_RECIPES.length + 1,
  SMALL_TREE: BUILT_RECIPES.length + 2,
  TALL_TREE: BUILT_RECIPES.length + 3,
  CACTUS: BUILT_RECIPES.length + 4,
};
export const PLANT_INDICES = Object.values(PLANT);

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

export function drawPile(rd, ent, camX, camY, camZ, fog, row, biome, sil = 0) {
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
    drawModel(rd, dressModel(p.model, biome), p.mat, p.x, p.y, p.z, camX, camY, camZ, fog, sil);
  }
}

// Where the blocks of a settled pile are, for the shadows to follow.
export function pileParts(ent) {
  return ent.parts;
}
