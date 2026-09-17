// objects.js -- the things that sit on the landscape, and get blown up.
//
// Object placement, like the landscape itself, is a pure function of tile
// coordinates: the map is infinite and stores nothing except which tiles have
// been shot -- and, for the block structures, which have been knocked over.

import { TILE, hash2 } from './maths.js';
import { Model, facet, shade, mergeAt } from './model.js';
import { STRUCTURES, OPEN_STRUCTURES, OPEN_ALONG_Z, resetBlocks } from './blocks.js';
import { floraBiome, DENSITY, TUNDRA, TEMPERATE, DESERT } from './biome.js';
import { landAltitude, isOnLaunchpad, SEA_LEVEL, TILES_X, TILES_Z } from './landscape.js';
import { paint } from './style.js';

// --- the models ------------------------------------------------------------

// How much bigger the trees are than the shapes below describe. The models
// are left at their original proportions and resized from this one number,
// so the family keeps its relative sizes however it is tuned.
const TREE = 1.5;

const TRUNK  = paint([102, 68, 34]);
const LEAF   = paint([34, 153, 51]);
const LEAF2  = paint([51, 170, 68]);
const FIR    = paint([17, 119, 68]);
const CHAR   = paint([51, 42, 38]);

// Desert.
const CACTUS  = paint([ 58, 122,  62]);
const CACTUS2 = paint([ 88, 158,  86]);
const ROCK_W  = paint([178, 122,  78]);   // sun-baked sandstone
const ROCK_D  = paint([146,  96,  62]);   // the band under it, in shadow
const ROCK_L  = paint([202, 152, 104]);   // and the weathered cap

// Tundra.
const TRUNK_D = paint([ 78,  54,  32]);
const FIR_C   = paint([ 26,  84,  62]);   // conifer, colder and darker
const SNOW    = paint([236, 242, 250]);
const ICE     = paint([150, 200, 222]);
const ICE_P   = paint([198, 228, 240]);

function smallLeafyTree() {
  const m = new Model();
  m.box(0.07, 0, 0.34, 0.07, TRUNK, TRUNK);
  m.drum(0.16, 0.26, 0.28, 0.58, 6, LEAF, shade(LEAF2, 1.15));
  m.cone(0.2, 0.55, 0.78, 6, LEAF2);
  return m.scale(TREE);
}

function tallLeafyTree() {
  const m = new Model();
  m.box(0.08, 0, 0.55, 0.08, TRUNK, TRUNK);
  m.drum(0.2, 0.32, 0.45, 0.9, 6, LEAF, shade(LEAF2, 1.15));
  m.cone(0.24, 0.86, 1.2, 6, LEAF2);
  return m.scale(TREE);
}

function firTree() {
  const m = new Model();
  m.box(0.06, 0, 0.2, 0.06, TRUNK, TRUNK);
  m.cone(0.3, 0.18, 0.62, 7, FIR);
  m.cone(0.22, 0.55, 0.92, 7, shade(FIR, 1.2));
  m.cone(0.13, 0.86, 1.15, 7, shade(FIR, 1.35));
  return m.scale(TREE);
}

// A columnar cactus: one fat ribbed trunk and two arms that spur out and
// then turn up. Its arms are at different heights and on opposite sides,
// which is enough asymmetry to stop a field of them looking stamped.
function cactusArm(side, at, reach, rise) {
  const a = new Model();
  const spur = new Model();
  spur.box(reach, at, at + 0.12, 0.12, CACTUS2, CACTUS);
  mergeAt(a, spur, side * (reach / 2 + 0.09), 0, 0);
  const limb = new Model();
  limb.drum(0.10, 0.11, at, at + rise, 6, CACTUS, shade(CACTUS2, 1.12));
  mergeAt(a, limb, side * (reach + 0.06), 0, 0);
  return a;
}

function cactus() {
  const m = new Model();
  m.drum(0.17, 0.20, 0, 0.98, 7, CACTUS, shade(CACTUS2, 1.15));
  mergeAt(m, cactusArm(1, 0.40, 0.19, 0.34), 0, 0, 0);
  mergeAt(m, cactusArm(-1, 0.60, 0.16, 0.24), 0, 0, 0);
  return m.scale(TREE);
}

// A weathered boulder, and two smaller ones beside it.
//
// Geodesic rather than conical. A cone has one apex and a handful of long
// triangles running down from it, which reads as a tent whatever colour it is
// painted; a boulder is a lot of small flat faces at a lot of angles, and this
// renderer shades every one of them differently for nothing. The three lumps
// take different seeds, so a clump is three rocks rather than one rock drawn
// three times.
function desertRock() {
  const m = new Model();
  m.geode(0.42, 0, 0.44, 9, 4, ROCK_W, 3);
  const b = new Model();
  b.geode(0.24, 0, 0.26, 7, 3, shade(ROCK_W, 0.84), 11);
  mergeAt(m, b, 0.34, 0, 0.18);
  const c = new Model();
  c.geode(0.15, 0, 0.15, 6, 2, shade(ROCK_W, 0.92), 29);
  mergeAt(m, c, -0.30, 0, -0.26);
  return m.scale(TREE);
}

// A lump of rock, centred on itself, for placing along a curve. Given three
// radii it is a slab, an egg or a boulder as required -- the geode is built
// round a unit sphere and then squashed, which is safe here because a geode
// is shaded by the angle round it rather than by its face normals.
function blob(rx, ry, rz, col, seed) {
  const m = new Model();
  m.geode(1, -1, 1, 7, 3, col, seed);
  return m.scale3(rx, ry, rz);
}

// A natural arch.
//
// Two attempts at this were wrong in the same way before it came right, and
// both are worth recording because the mistake is an inviting one.
//
// The first was a ring of round lumps traced over a half circle. It read as a
// croquet hoop: two legs and a bend, all of it as deep as it was wide. The
// second kept the lumps and made them slabs, which is nearer -- but a lump is
// a lump, and sizing them so they touch all the way round is a losing game:
// spaced along the arc they either leave gaps or cost four hundred faces to
// close them. It came out beaded, and at 396 faces it was the most expensive
// thing in the world by a factor of five.
//
// What an arch actually is: a fin. A wall of rock standing on its own, thin
// across and long along, with a hole worn through the middle of it. So this
// is swept rather than stacked -- one continuous band walked up one leg, over
// the opening and down the other, four faces a step. The inner surface of
// that band is the hole, the outer surface is the rock, and they are
// separately shaped, which is the whole trick: the opening can be a clean
// ellipse while the rock around it is lumpy and flat-topped and heavier at
// the feet.
//
// Sixty-odd faces for the whole thing, and nothing can come apart, because
// consecutive rings share their vertices by construction.
//
// It is also the one piece of scenery you can fly through rather than over.
// The opening is a bit over three tiles across and two high -- room to line
// up and go through at speed, where the first one was tight enough that you
// had to mean it.
//
// `alongZ` builds the same arch facing the other way. It is built rather than
// turned: the shading is worked out when the model is made, so an arch turned
// afterwards would be lit as though it still faced the way it was built.
function rockArch(alongZ) {
  const m = new Model();
  const RIN = 1.06;          // half the width of the opening
  const HIN = 1.30;          // height of the underside of the crown
  const SPRING = 0.58;       // how far up the legs stand before the arc starts
  const TOP = HIN + 0.34;    // a flat top, as a weathered fin has
  const WOUT = RIN + 0.62;   // and how far out the rock stands beside it
  const ARC = 10;

  const jig = (i, k) => {
    let h = (i * 374761393 + k * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  // The path of the band, from the foot of one leg to the foot of the other.
  // Each ring carries where it is and which way is out.
  const path = [];
  const LEG = 2;
  for (let j = 0; j <= LEG; j++) {
    path.push({ u: -RIN, y: -SPRING * (j / LEG), nu: -1, ny: 0 });
  }
  for (let j = 1; j < ARC; j++) {
    const a = (Math.PI * j) / ARC;
    path.push({
      u: -Math.cos(a) * RIN,
      y: -SPRING - Math.sin(a) * (HIN - SPRING),
      nu: -Math.cos(a), ny: -Math.sin(a),
    });
  }
  for (let j = LEG; j >= 0; j--) {
    path.push({ u: RIN, y: -SPRING * (j / LEG), nu: 1, ny: 0 });
  }

  // Build the four corners of each ring: inner and outer, front and back.
  const rings = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const up = -p.y / TOP;                      // 0 at the ground, 1 at the top

    // The outer surface is not the inner one pushed out by a fixed amount.
    // That was the last thing wrong with this: a band of even thickness bent
    // round a curve is a hoop, whatever it is made of, and no amount of
    // shading makes it read as rock.
    //
    // Instead the band is run outward from the hole until it meets the
    // outline of the fin -- a flat top and two sides, leaning in a little as
    // it rises. So the rock is deep at the haunches, where the corner of that
    // outline is furthest from the curve, and shallow over the crown, which
    // is exactly where an arch is thinnest and why they eventually fall down.
    const wall = WOUT - 0.16 * up;
    let reach = p.nu > 0 ? (wall - p.u) / p.nu
              : p.nu < 0 ? (-wall - p.u) / p.nu : 1e9;
    if (p.ny < 0) reach = Math.min(reach, (-TOP - p.y) / p.ny);
    // Eroded rather than cut: every ring stops a little short of the outline,
    // by its own amount, and the left leg carries more than the right.
    reach *= (0.80 + 0.30 * jig(i, 1)) * (p.u < 0 ? 1.06 : 0.96);
    const ou = p.u + p.nu * reach;
    const oy = p.y + p.ny * reach;
    // The fin is thinner across than it is anywhere else, and thinner still
    // over the opening than at the feet.
    const d = (0.46 - 0.14 * up) * (0.84 + 0.3 * jig(i, 2));
    const vert = (u, y, v) => (alongZ ? m.vert(v, y, u) : m.vert(u, y, v));
    rings.push([
      vert(p.u, p.y, -d), vert(ou, oy, -d),
      vert(ou, oy, d), vert(p.u, p.y, d),
      up,
    ]);
  }

  // Strata: dark at the bottom, sandstone through the middle, the weathered
  // cap on top. Flat bands rather than a gradient, because that is what makes
  // it read as rock that was laid down rather than rock that was painted.
  const band = (up) => (up < 0.30 ? ROCK_D : up < 0.74 ? ROCK_W : ROCK_L);

  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i], b = rings[i + 1];
    const col = band((a[4] + b[4]) / 2);
    facet(m, [a[1], b[1], b[2], a[2]], col);                  // outer
    facet(m, [a[0], b[0], b[3], a[3]], shade(col, 0.80));     // the soffit
    facet(m, [a[0], b[0], b[1], a[1]], col);                  // the two faces
    facet(m, [a[3], b[3], b[2], a[2]], col);
  }

  // Fallen rock at the foot. An arch this size has been shedding for a long
  // time, and a clean join to the ground is what gives a model away.
  const rubble = (u, v, r, col, seed) => {
    const b = new Model();
    b.geode(r, -r * 0.55, r * 0.6, 6, 2, col, seed);
    mergeAt(m, b, alongZ ? v : u, -r * 0.4, alongZ ? u : v);
  };
  rubble(-RIN - 0.46, 0.40, 0.26, ROCK_W, 97);
  rubble(RIN + 0.52, -0.34, 0.19, shade(ROCK_D, 1.06), 103);
  rubble(RIN * 0.2, 0.62, 0.15, ROCK_W, 109);

  return m.scale(TREE);
}

// A mesa: flat-topped, stepped, and wider at every level down. Three drums
// rather than one taper, because the steps are what say "this was laid down
// in layers and then cut", which a smooth cone cannot.
function mesa() {
  const m = new Model();
  m.drum(0.62, 0.78, 0, 0.34, 7, ROCK_D, null);
  m.drum(0.48, 0.60, 0.32, 0.74, 7, ROCK_W, null);
  m.drum(0.40, 0.47, 0.72, 0.96, 7, ROCK_L, ROCK_L);
  return m.scale(TREE);
}

// A spire with a cap it never quite lost: narrow where the weather got at it,
// wide at the top where the hard layer protected what was underneath.
function hoodoo() {
  const m = new Model();
  m.drum(0.17, 0.30, 0, 0.42, 6, ROCK_D, null);
  m.drum(0.13, 0.17, 0.40, 1.02, 6, ROCK_W, null);
  mergeAt(m, blob(0.26, 0.26, 0.26, ROCK_L, 41), 0, -1.08, 0);
  return m.scale(TREE);
}

// A conifer with snow lying on it. Each skirt of needles gets a slightly
// smaller, slightly higher white cone sitting in it, which is where snow
// actually collects on a fir -- on the upper face of each tier, not as a
// coating over the whole tree.
function snowFir() {
  const m = new Model();
  m.box(0.06, 0, 0.2, 0.06, TRUNK_D, TRUNK_D);
  m.cone(0.30, 0.18, 0.62, 7, FIR_C);
  m.cone(0.27, 0.42, 0.66, 7, SNOW);
  m.cone(0.22, 0.55, 0.92, 7, FIR_C);
  m.cone(0.19, 0.72, 0.96, 7, SNOW);
  m.cone(0.13, 0.86, 1.15, 7, SNOW);
  return m.scale(TREE);
}

// A shard of ice shouldering out of the snow.
function iceBlock() {
  const m = new Model();
  m.cone(0.33, 0, 0.44, 5, ICE);
  const b = new Model();
  b.cone(0.21, 0, 0.60, 4, shade(ICE_P, 1.04));
  mergeAt(m, b, -0.21, 0, 0.13);
  return m.scale(TREE);
}

// What is left after something is destroyed: a blackened stump.
function remains(lean) {
  const m = new Model();
  const top = new Model();
  top.box(0.16, 0, 0.3, 0.16, CHAR, CHAR);
  mergeAt(m, top, lean * 0.05, 0, 0);
  const spur = new Model();
  spur.cone(0.11, 0.26, 0.52, 4, shade(CHAR, 1.3));
  mergeAt(m, spur, lean * 0.13, 0, 0);
  return m.scale(TREE);
}


// Object type ids. Trees first, then one id per block structure, then the
// stumps a burnt tree leaves behind. Everything built is made of blocks, so
// the structures share one contiguous run of ids and the code can tell them
// apart from the scenery with a range check.
export const OBJ = {
  SMALL_TREE: 0,
  TALL_TREE: 1,
  FIR_TREE: 2,
  CACTUS: 3,
  DESERT_ROCK: 4,
  SNOW_FIR: 5,
  ICE_BLOCK: 6,
  ROCK_ARCH: 7,
  ROCK_ARCH_Z: 8,
  MESA: 9,
  HOODOO: 10,
  BLOCKS_0: 11,
  REMAINS_L: 11 + STRUCTURES.length,
  REMAINS_R: 12 + STRUCTURES.length,
};

export const MODELS = [
  smallLeafyTree(),
  tallLeafyTree(),
  firTree(),
  cactus(),
  desertRock(),
  snowFir(),
  iceBlock(),
  rockArch(false),
  rockArch(true),
  mesa(),
  hoodoo(),
  ...STRUCTURES.map((st) => st.model),
  remains(-1),
  remains(1),
];

// Score for shooting each type. Knocking over a structure pays the same as
// blowing it up did -- the bigger the stack, the better.
export const OBJ_SCORE = [
  10, 15, 15,        // temperate trees
  12, 8, 15, 10,     // cactus, rock, snow fir, ice
  40, 40, 35, 22,    // arch both ways, mesa, hoodoo
  50, 60, 90, 70, 55, 45, 80, 80,
  0, 0,
];

// Scenery you can fly through rather than into.
//
// Collision is a cylinder of the model's radius, which is the right shape for
// a tree and exactly the wrong one for an arch: the opening is the middle of
// the cylinder, so the one place the arch is meant to let you through is the
// one place it would stop you. Rather than teach the collision test about
// holes -- which would mean a second geometry for every model that has one --
// an arch is simply not solid. Clip a leg and you pass through it, which is a
// smaller lie than a solid arch would be, and the only thing in this game
// that can still end a flight is the ground.
const OPEN = new Set([
  OBJ.ROCK_ARCH, OBJ.ROCK_ARCH_Z,
  ...OPEN_STRUCTURES.map((i) => OBJ.BLOCKS_0 + i),
]);

export function isOpen(type) {
  return OPEN.has(type);
}

// Which way an open thing stands: false spans x, true spans z. Only the
// shadows ask, and only because a thing with a hole in it does not cast a
// solid circle.
const ALONG_Z = new Set([
  OBJ.ROCK_ARCH_Z,
  ...OPEN_ALONG_Z.map((i) => OBJ.BLOCKS_0 + i),
]);

export function spansZ(type) {
  return ALONG_Z.has(type);
}

// Is this one of the block structures?
export function isBlocks(type) {
  return type >= OBJ.BLOCKS_0 && type < OBJ.BLOCKS_0 + STRUCTURES.length;
}

// Which structure recipe a block type refers to.
export function structureIndex(type) {
  return type - OBJ.BLOCKS_0;
}

// Ground higher than this carries nothing tall -- see objectAt.
const TREE_LINE = (TILE * 0.8) | 0;

// Types that can be spawned onto the map, with their relative frequency.
//
// One table per biome. Every structure recipe gets exactly one entry, and the
// flora list is repeated to set how often a built thing turns up at all --
// three passes of it puts a structure on roughly one occupied tile in five.
// Halving that is a matter of adding another pass, not of dropping recipes,
// which would quietly retire whichever ones came last.
//
// Toy blocks turn up in all three. They are what you are here to knock over,
// and a desert with nothing in it to hit would be a long flight.
const FLORA = [];
FLORA[TUNDRA] = [
  OBJ.SNOW_FIR, OBJ.SNOW_FIR, OBJ.SNOW_FIR, OBJ.SNOW_FIR,
  OBJ.ICE_BLOCK, OBJ.ICE_BLOCK, OBJ.ICE_BLOCK,
];
FLORA[TEMPERATE] = [
  OBJ.SMALL_TREE, OBJ.SMALL_TREE, OBJ.SMALL_TREE,
  OBJ.TALL_TREE, OBJ.TALL_TREE, OBJ.FIR_TREE, OBJ.FIR_TREE,
];
FLORA[DESERT] = [
  OBJ.CACTUS, OBJ.CACTUS, OBJ.CACTUS, OBJ.CACTUS,
  OBJ.DESERT_ROCK, OBJ.DESERT_ROCK, OBJ.DESERT_ROCK,
  OBJ.HOODOO, OBJ.HOODOO,
];

const SPAWN_TABLE = FLORA.map((flora) => [
  ...flora, ...flora, ...flora,
  ...STRUCTURES.map((_, i) => OBJ.BLOCKS_0 + i)
    .filter((t) => !OPEN.has(t)),
]);

// ---------------------------------------------------------------------------
// Formations
// ---------------------------------------------------------------------------
//
// The big things -- arches, gateways, mesas -- are placed by a different rule
// from everything else, because the rule everything else uses cannot give
// them what they need.
//
// That rule is per tile: roll a hash, and if it comes up, stand something
// here. It is perfect for trees, which want to be in among each other, and
// hopeless for an arch, which is three and a half tiles across and wants
// nothing near it. Rolled per tile, arches came up in twos and threes with
// cactus growing through the opening, and the one thing an arch is for --
// being seen from a distance, lined up, and flown through -- was the one
// thing you could not do with it.
//
// So the world is divided into cells five tiles square, and a cell either has
// a formation or it does not. When it does, it stands in the middle three by
// three of the cell, never on the edge, which is what guarantees the spacing:
// two formations in neighbouring cells are at least three tiles apart however
// the hashes fall, and no formation can ever land inside another's clearing.
// The clearing is two tiles in every direction, and nothing else grows there.
//
// The whole thing is still a pure function of the tile -- no storage, no
// generation pass, and the same landscape every time.
const CELL = 5;
const CLEAR = 2;                  // tiles kept empty around a formation
const FORMATION_CHANCE = 36;      // in a hundred cells

const FORMATIONS = [
  OBJ.ROCK_ARCH, OBJ.ROCK_ARCH_Z, OBJ.ROCK_ARCH, OBJ.ROCK_ARCH_Z,
  OBJ.MESA, OBJ.MESA,
  ...STRUCTURES.map((_, i) => OBJ.BLOCKS_0 + i).filter((t) => OPEN.has(t)),
];

// Floor division, which is not what % gives for negative tiles -- and the
// world runs in both directions.
const cellOf = (t) => Math.floor(t / CELL);

// What this cell holds, written into `out` as [tx, tz, type], or false.
function cellFormation(cx, cz, out) {
  const h = hash2(cx ^ 0x27d4eb2f, cz ^ 0x165667b1);
  if (h % 100 >= FORMATION_CHANCE) return false;
  out[0] = cx * CELL + 1 + ((h >>> 8) % 3);
  out[1] = cz * CELL + 1 + ((h >>> 16) % 3);
  out[2] = FORMATIONS[(h >>> 24) % FORMATIONS.length];
  return true;
}

const scratchCell = [0, 0, 0];

// The formation standing on this tile, or CLEARING if the tile is inside one
// formation's space, or -1 if this tile is ordinary ground.
const CLEARING = -2;

function formationAt(tx, tz) {
  const cx = cellOf(tx), cz = cellOf(tz);
  for (let ox = -1; ox <= 1; ox++) {
    for (let oz = -1; oz <= 1; oz++) {
      if (!cellFormation(cx + ox, cz + oz, scratchCell)) continue;
      const dx = Math.abs(tx - scratchCell[0]);
      const dz = Math.abs(tz - scratchCell[1]);
      if (dx === 0 && dz === 0) return scratchCell[2];
      if (dx <= CLEAR && dz <= CLEAR) return CLEARING;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// The object map
// ---------------------------------------------------------------------------
//
// Like the landscape, object placement is a pure function of tile coordinates,
// so the map is infinite and needs no storage. The only state is the set of
// tiles whose object has been destroyed.

const destroyed = new Map(); // "x,z" -> wreck type

export function resetObjects() {
  destroyed.clear();
  resetBlocks();
}

const KEY = (tx, tz) => tx + ',' + tz;

// What stands on this tile, or -1 for nothing.
export function objectAt(tx, tz) {
  // The launchpad and its immediate surroundings are kept clear so you always
  // have somewhere to put down.
  const x = (tx * TILE) | 0, z = (tz * TILE) | 0;
  if (isOnLaunchpad(x, z)) return -1;

  const h = hash2(tx, tz);

  // Nothing grows in the sea.
  const alt = landAltitude(x, z);
  if (alt >= SEA_LEVEL) return -1;

  // How crowded the ground is depends on where in the world it is. The
  // desert's emptiness is most of what makes it read as desert rather than
  // as temperate ground that happens to be beige.
  const biome = floraBiome(x, z, h);

  // A formation and its clearing are decided before the density roll, since
  // the whole point of them is that they do not depend on how crowded the
  // ground happens to be here. An empty desert gets its arches; a thick
  // temperate valley still gets the space cleared round one.
  const big = formationAt(tx, tz);
  if (big === CLEARING) return -1;
  if (big >= 0) {
    const wrecked = destroyed.get(KEY(tx, tz));
    return wrecked !== undefined ? wrecked : big;
  }

  if (h % 100 >= DENSITY[biome]) return -1;

  const wreck = destroyed.get(KEY(tx, tz));
  if (wreck !== undefined) return wreck;

  const table = SPAWN_TABLE[biome];
  const type = table[(h >>> 8) % table.length];

  // Above the treeline only the small tree grows, because that is what real
  // high ground looks like. At the current tree scale it is decoration: a
  // tall tree clears the drone's ceiling anywhere in the world. It earns its
  // keep at larger scales, where a tall tree on the very highest peak would
  // otherwise stand above the ceiling with no way over it and nothing on
  // screen to warn you -- so raising TREE stays safe as far as 3.0 without
  // having to work that out again. It costs a quarter of a percent of the
  // land area either way.
  if (alt < TREE_LINE) {
    if (type === OBJ.TALL_TREE || type === OBJ.FIR_TREE) return OBJ.SMALL_TREE;
    if (type === OBJ.SNOW_FIR) return OBJ.ICE_BLOCK;      // bare ice above it
    if (type === OBJ.CACTUS) return OBJ.DESERT_ROCK;      // bare rock above it
  }

  return type;
}

// The exact spot an object stands on within its tile, so they are not all
// lined up in the middle of a grid square.
export function objectOffset(tx, tz) {
  const h = hash2(tx ^ 0x5bf03635, tz);
  const fx = ((h & 0xffff) / 65536 - 0.5) * 0.62;
  const fz = (((h >>> 16) & 0xffff) / 65536 - 0.5) * 0.62;
  return [(fx * TILE) | 0, (fz * TILE) | 0];
}

export function destroyObject(tx, tz) {
  const wreck = hash2(tx, tz) & 1 ? OBJ.REMAINS_L : OBJ.REMAINS_R;
  destroyed.set(KEY(tx, tz), wreck);
}

export function isWreck(type) {
  return type === OBJ.REMAINS_L || type === OBJ.REMAINS_R;
}
