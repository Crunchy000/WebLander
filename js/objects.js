// objects.js -- the things that sit on the landscape, and get blown up.
//
// Object placement, like the landscape itself, is a pure function of tile
// coordinates: the map is infinite and stores nothing except which tiles have
// been shot.

import { TILE, hash2 } from './maths.js';
import { Model, shade, mergeAt } from './model.js';
import { landAltitude, isOnLaunchpad, SEA_LEVEL, TILES_X, TILES_Z } from './landscape.js';

// --- the models ------------------------------------------------------------

const TRUNK  = [102, 68, 34];
const LEAF   = [34, 153, 51];
const LEAF2  = [51, 170, 68];
const FIR    = [17, 119, 68];
const STONE  = [153, 153, 153];
const ROOF   = [153, 51, 34];
const WALL   = [204, 187, 153];
const METAL  = [187, 187, 204];
const NOSE   = [204, 68, 51];
const CHAR   = [51, 42, 38];

function smallLeafyTree() {
  const m = new Model();
  m.box(0.07, 0, 0.34, 0.07, TRUNK, TRUNK);
  m.drum(0.16, 0.26, 0.28, 0.58, 6, LEAF, shade(LEAF2, 1.15));
  m.cone(0.2, 0.55, 0.78, 6, LEAF2);
  return m;
}

function tallLeafyTree() {
  const m = new Model();
  m.box(0.08, 0, 0.55, 0.08, TRUNK, TRUNK);
  m.drum(0.2, 0.32, 0.45, 0.9, 6, LEAF, shade(LEAF2, 1.15));
  m.cone(0.24, 0.86, 1.2, 6, LEAF2);
  return m;
}

function firTree() {
  const m = new Model();
  m.box(0.06, 0, 0.2, 0.06, TRUNK, TRUNK);
  m.cone(0.3, 0.18, 0.62, 7, FIR);
  m.cone(0.22, 0.55, 0.92, 7, shade(FIR, 1.2));
  m.cone(0.13, 0.86, 1.15, 7, shade(FIR, 1.35));
  return m;
}

function gazebo() {
  const m = new Model();
  for (const [dx, dz] of [[-0.22, -0.22], [0.22, -0.22], [0.22, 0.22], [-0.22, 0.22]]) {
    const sub = new Model();
    sub.box(0.05, 0, 0.42, 0.05, STONE, STONE);
    mergeAt(m, sub, dx, 0, dz);
  }
  const top = new Model();
  top.drum(0.34, 0.34, 0.42, 0.48, 6, STONE, shade(STONE, 1.1));
  top.cone(0.36, 0.46, 0.74, 6, ROOF);
  mergeAt(m, top, 0, 0, 0);
  return m;
}

function building() {
  const m = new Model();
  m.box(0.62, 0, 0.62, 0.52, shade(WALL, 1.1), WALL);
  const roof = new Model();
  roof.cone(0.46, 0.6, 0.98, 4, ROOF);
  mergeAt(m, roof, 0, 0, 0);
  return m;
}

function rocket() {
  const m = new Model();
  m.drum(0.17, 0.2, 0, 1.15, 8, METAL, null);
  m.cone(0.17, 1.12, 1.62, 8, NOSE);
  // Three fins around the base.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const cx = Math.cos(a), cz = Math.sin(a);
    const v0 = m.vert(cx * 0.18, 0, cz * 0.18);
    const v1 = m.vert(cx * 0.44, 0, cz * 0.44);
    const v2 = m.vert(cx * 0.18, -0.42, cz * 0.18);
    m.face([v0, v1, v2], shade(NOSE, 0.8 + 0.3 * cx));
  }
  return m;
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
  return m;
}


// Object type ids. The live types come first; destroying one swaps it for the
// matching wreck.
export const OBJ = {
  SMALL_TREE: 0,
  TALL_TREE: 1,
  FIR_TREE: 2,
  GAZEBO: 3,
  BUILDING: 4,
  ROCKET: 5,
  REMAINS_L: 6,
  REMAINS_R: 7,
};

export const MODELS = [
  smallLeafyTree(),
  tallLeafyTree(),
  firTree(),
  gazebo(),
  building(),
  rocket(),
  remains(-1),
  remains(1),
];

// Score for shooting each type.
export const OBJ_SCORE = [10, 15, 15, 40, 60, 100, 0, 0];

// Types that can be spawned onto the map, with their relative frequency.
const SPAWN_TABLE = [
  OBJ.SMALL_TREE, OBJ.SMALL_TREE, OBJ.SMALL_TREE, OBJ.SMALL_TREE,
  OBJ.TALL_TREE, OBJ.TALL_TREE, OBJ.FIR_TREE, OBJ.FIR_TREE,
  OBJ.GAZEBO, OBJ.BUILDING, OBJ.ROCKET,
];

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
}

const KEY = (tx, tz) => tx + ',' + tz;

// What stands on this tile, or -1 for nothing.
export function objectAt(tx, tz) {
  // The launchpad and its immediate surroundings are kept clear so you always
  // have somewhere to put down.
  const x = (tx * TILE) | 0, z = (tz * TILE) | 0;
  if (isOnLaunchpad(x, z)) return -1;

  const h = hash2(tx, tz);
  // Roughly one tile in five is occupied.
  if (h % 100 >= 21) return -1;

  // Nothing grows in the sea, or on very steep ground.
  const alt = landAltitude(x, z);
  if (alt >= SEA_LEVEL) return -1;

  const wreck = destroyed.get(KEY(tx, tz));
  if (wreck !== undefined) return wreck;

  return SPAWN_TABLE[(h >>> 8) % SPAWN_TABLE.length];
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
