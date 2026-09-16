// objects.js -- the things that sit on the landscape, and get blown up.
//
// Object placement, like the landscape itself, is a pure function of tile
// coordinates: the map is infinite and stores nothing except which tiles have
// been shot -- and, for the block structures, which have been knocked over.

import { TILE, hash2 } from './maths.js';
import { Model, shade, mergeAt } from './model.js';
import { STRUCTURES, resetBlocks } from './blocks.js';
import { floraBiome, DENSITY, TUNDRA, TEMPERATE, DESERT } from './biome.js';
import { landAltitude, isOnLaunchpad, SEA_LEVEL, TILES_X, TILES_Z } from './landscape.js';

// --- the models ------------------------------------------------------------

// How much bigger the trees are than the shapes below describe. The models
// are left at their original proportions and resized from this one number,
// so the family keeps its relative sizes however it is tuned.
const TREE = 1.5;

const TRUNK  = [102, 68, 34];
const LEAF   = [34, 153, 51];
const LEAF2  = [51, 170, 68];
const FIR    = [17, 119, 68];
const CHAR   = [51, 42, 38];

// Desert.
const CACTUS  = [ 58, 122,  62];
const CACTUS2 = [ 88, 158,  86];
const ROCK_W  = [178, 122,  78];   // sun-baked sandstone

// Tundra.
const TRUNK_D = [ 78,  54,  32];
const FIR_C   = [ 26,  84,  62];   // conifer, colder and darker
const SNOW    = [236, 242, 250];
const ICE     = [150, 200, 222];
const ICE_P   = [198, 228, 240];

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

// A weathered boulder, and a smaller one beside it.
function desertRock() {
  const m = new Model();
  m.cone(0.40, 0, 0.38, 5, ROCK_W);
  const b = new Model();
  b.cone(0.23, 0, 0.25, 4, shade(ROCK_W, 0.84));
  mergeAt(m, b, 0.32, 0, 0.17);
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
  BLOCKS_0: 7,
  REMAINS_L: 7 + STRUCTURES.length,
  REMAINS_R: 8 + STRUCTURES.length,
};

export const MODELS = [
  smallLeafyTree(),
  tallLeafyTree(),
  firTree(),
  cactus(),
  desertRock(),
  snowFir(),
  iceBlock(),
  ...STRUCTURES.map((st) => st.model),
  remains(-1),
  remains(1),
];

// Score for shooting each type. Knocking over a structure pays the same as
// blowing it up did -- the bigger the stack, the better.
export const OBJ_SCORE = [
  10, 15, 15,        // temperate trees
  12, 8, 15, 10,     // cactus, rock, snow fir, ice
  50, 60, 90, 70, 55, 45,
  0, 0,
];

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
];

const SPAWN_TABLE = FLORA.map((flora) => [
  ...flora, ...flora, ...flora,
  ...STRUCTURES.map((_, i) => OBJ.BLOCKS_0 + i),
]);

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
