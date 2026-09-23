// flowers.js -- small folded paper flowers, scattered over the ground.
//
// They are not objects in the object map, and that is the whole design. That
// map puts at most one thing on a tile, gives it a shadow, lets it be knocked
// over and keeps a record when it is -- all of which is right for a tree and
// none of which is right for a flower. Flowers want to come in handfuls, they
// want to be too small to have a shadow worth drawing, and nothing should
// happen when you fly through one.
//
// So this is its own scatter layer: a pure function of tile coordinates, like
// the landscape and like the object map, but sampled several times per tile
// and drawn with the row it stands in so the painter's order still holds.
//
// Two rules keep it cheap.
//
// They only exist near you: the nearest nine rows of the landscape, which is
// the ground from about eighteen tiles in. Drawn from every row instead, the
// layer is three times the size -- 197 flowers in a view against 67, 2600
// triangles against 880 -- and costs about a sixth of the frame's drawing
// time (2.5 to 3.1ms against 2.2 to 2.4 at the same spot), all of it spent on
// ground that is behind the haze and mostly behind the trees as well.
//
// They come in patches. A second, much coarser hash decides whether a stretch
// of ground is a meadow at all, so most of the world has none and the places
// that do have a dozen together. That is both what a meadow looks like and
// what keeps the count down: uniform scattering at this density would put one
// on every other tile and cost four times as much for a picture that reads as
// a rash rather than as flowers.

import { TILE, hash2 } from './maths.js';
import { Model, facet, shade, drawModel } from './model.js';
import {
  landAltitude, isOnLaunchpad, SEA_LEVEL, TILES_X, TILES_Z, LANDSCAPE_X,
} from './landscape.js';
import { floraBiome, TUNDRA, TEMPERATE, DESERT } from './biome.js';

// --- the paper -------------------------------------------------------------
//
// One palette per biome, because a flower is the cheapest way to say where
// you are: cornfield yellows and cornflower blues on the grass, saffron and
// hot pink in the desert, and almost nothing in the snow -- a few white and
// alpine-pink ones, which is what actually grows up there.
const PAPERS = [];
// White flowers on snow are white on white, which is honest and invisible.
// The cold gets the colours that actually show against it.
PAPERS[TUNDRA] = [
  [[232, 150, 178], [198, 114, 146]],   // alpine pink
  [[150, 170, 226], [116, 136, 198]],   // gentian
  [[236, 196, 106], [204, 162, 74]],    // arnica
];
PAPERS[TEMPERATE] = [
  [[246, 206, 92], [214, 168, 58]],     // buttercup
  [[238, 122, 118], [204, 88, 86]],     // poppy
  // The paper tulip's own red, read off its texture: the lit tenth of its
  // bud faces average [140, 53, 26] and the median is [152, 20, 14]. Both
  // are darker and harder than anything else here, so this is the median
  // lifted until it sits in the same range as its neighbours -- the model's
  // colour, in this palette's voice.
  [[196, 74, 62], [162, 48, 40]],       // scarlet
  [[224, 232, 244], [190, 200, 218]],   // white
  [[168, 176, 232], [134, 142, 206]],   // cornflower
  [[240, 168, 208], [206, 132, 176]],   // pink
  [[252, 236, 176], [220, 200, 140]],   // cream
];
PAPERS[DESERT] = [
  [[244, 150, 62], [210, 116, 36]],     // saffron
  [[232, 92, 120], [198, 64, 92]],      // hot pink
  [[248, 214, 110], [216, 180, 76]],    // sand yellow
  [[196, 120, 200], [162, 92, 166]],    // desert mallow
];
// The green is paper green, not leaf green: the folded flowers this is after
// are cut from a bright card that no plant is actually that colour.
const STEM = [122, 196, 70];
const LEAF = [142, 214, 78];

// --- the fold --------------------------------------------------------------
//
// A tulip, folded: a pointed bud that swells at the belly and closes again at
// the tip, on a straight stem with a long leaf on each side. It was a daisy
// before -- petals laid flat and open around a centre -- which is the shape a
// flower has when you draw it from above, and these are almost never seen
// from above. From the air at a bird's height you see the side of it, and a
// flat daisy from the side is a line.
//
// The bud is a spindle rather than a cup, so it is closed: no hole at the top
// to see the ground through, and no inside faces to sort. Every face points
// away from the middle of the bud, which is what lets facet() light them from
// their own normals and get the fold lines for nothing.
//
// The stem is a quad rather than a pair of triangles standing at right
// angles, because it is one pixel wide and nobody is going to see round it.
const STEM_W = 0.024;

function flower(petals, radius, bud, height, col, edge, spent = false) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x, y, z);

  // Stem: a thin upright, leaning a little so a patch of them is not a
  // parade ground.
  const lean = ((petals * 37) % 7 - 3) * 0.018;
  const a = v(-STEM_W, 0, 0), b = v(STEM_W, 0, 0);
  const c = v(STEM_W + lean, -height, 0), d = v(-STEM_W + lean, -height, 0);
  m.face([a, b, c, d], shade(STEM, 0.92));

  // A leaf each side, at different heights and lengths so the two sides are
  // not a mirror. One triangle apiece: root at the stem, tip swept up and
  // out, and a third point hung below the line between them, which is what
  // gives a straight-edged triangle the belly of a long leaf. Flat in the
  // screen plane and lit by hand rather than by facet(), because a flat leaf
  // has one normal and would otherwise come out the same grey whichever way
  // it pointed.
  for (const side of [-1, 1]) {
    const up = side < 0 ? 0.32 : 0.48;
    const len = height * (side < 0 ? 0.46 : 0.54);
    const y0 = -height * up;
    const x0 = lean * up + side * STEM_W;
    const root = v(x0, y0, 0);
    const belly = v(x0 + side * len * 0.55, y0 - len * 0.26, 0);
    const tip = v(x0 + side * len, y0 - len * 0.82, 0);
    m.face([root, belly, tip], shade(LEAF, side < 0 ? 0.88 : 1));
  }

  // The bud. Spent, the head tips over and shrinks: a flower a hummingbird
  // has just emptied has to read as empty from the air, or you will keep
  // going back to it.
  const cx = lean, top = -height;
  const rr = spent ? radius * 0.56 : radius;
  const len = spent ? bud * 0.52 : bud;
  const tipX = spent ? rr * 1.6 : 0;          // how far the head hangs over
  const base = v(cx, top + len * 0.06, 0);
  const apex = v(cx + tipX, top - len, 0);
  // The belly sits four fifths of the way up, and the bud is a little wider
  // than it is long. Both of those are measured off a folded paper tulip
  // rather than guessed: in that model the widest cross-section is within a
  // twentieth of the tip, 0.36 across against 0.27 long, and it tapers all
  // the way down from there into the stem. A bud with its belly in the
  // middle is a diamond; this is a cup carried high.
  const bx = cx + tipX * 0.6, by = top - len * 0.80;
  // Every other belly vertex is lifted, which costs nothing and turns the
  // top of the bud into a crown of uneven points rather than a cone: it is
  // the difference between a tulip and a cut gem, and it is one term.
  const rim = [];
  for (let i = 0; i < petals; i++) {
    const t = (i / petals) * Math.PI * 2 + 0.4;
    rim.push(v(bx + Math.cos(t) * rr, by - (i & 1 ? len * 0.13 : 0), Math.sin(t) * rr));
  }
  for (let i = 0; i < petals; i++) {
    const j = (i + 1) % petals;
    // Alternating tone, so the folds read even when the light does not.
    facet(m, [base, rim[i], rim[j]], i % 2 ? col : edge);
    facet(m, [rim[i], rim[j], apex], i % 2 ? edge : col);
  }
  return m;
}

// Built once per paper colour per biome: three sizes and petal counts, which
// is enough variety at half a tile tall. Any more and the extra is invisible
// and the table is four times the size.
// Four or five sides to the bud, and never six. Every triangle is charged for
// at full price by the rasteriser whether it covers four pixels or four
// hundred, so a sixth fold is a twenty per cent tax on the whole layer for an
// edge nobody can see.
//
// Half a tree tall. They were a tenth of that, which was the right size for
// something to notice and the wrong size for something to visit: the
// hummingbird takes nectar off them now, and you cannot aim at a speck. Stem
// and bud together they run 0.50 to 0.80 tiles against a small tree's 1.17
// and a tall one's 1.80.
//
// The bud is a third of that and slightly wider than it is long, which is
// the proportion the folded paper one has -- a head sized to be aimed at
// rather than looked for. The stems were cut back as the bud grew, so the
// plant stands about where it stood and the flower on top of it is what got
// bigger.
const SHAPES = [
  { petals: 5, radius: 0.155, bud: 0.290, height: 0.470 },
  { petals: 4, radius: 0.133, bud: 0.242, height: 0.355 },
  { petals: 5, radius: 0.112, bud: 0.198, height: 0.275 },
];

const KINDS = PAPERS.map((papers) => {
  const out = [];
  for (const [col, edge] of papers) {
    for (const s of SHAPES) out.push(flower(s.petals, s.radius, s.bud, s.height, col, edge));
  }
  return out;
});

// The same flowers, emptied: shut, and most of the colour gone out of them.
const drained = (c) => [
  Math.round(c[0] * 0.52 + 96 * 0.48),
  Math.round(c[1] * 0.58 + 104 * 0.42),
  Math.round(c[2] * 0.52 + 92 * 0.48),
];
const SPENT = PAPERS.map((papers) => {
  const out = [];
  for (const [col, edge] of papers) {
    for (const s of SHAPES) {
      out.push(flower(s.petals, s.radius, s.bud, s.height,
                      drained(col), drained(edge), true));
    }
  }
  return out;
});

// How tall each kind's bloom stands, in fixed point, so the bird knows what
// height to hover at without asking the model.
const BLOOM_Y = SHAPES.map((s) => ((s.height + s.bud * 0.5) * TILE) | 0);

// --- where they are --------------------------------------------------------

// How near a row has to be to be worth drawing. Rows count from the far edge,
// so this is the last stretch before the craft and a little beyond it.
const NEAR_ROW = TILES_Z - 9;

// The patch field: one value per eight tiles square, so a meadow is about
// eight tiles across and most of the world is not one.
const PATCH = 2;                  // tiles per patch, as a shift
// ... and how many patches in a hundred have anything. It was 40, which put
// a meadow within sight almost everywhere and made the ground busy; 26
// leaves a quarter of the world flowering, so a meadow is somewhere you
// arrive at rather than the texture of the whole map.
const PATCH_IN = 26;
const MAX_PER_TILE = 2;

// Every flower on one tile, handed to a callback. One function, used by both
// the drawing and the bird, because a bird sipping at a flower that is not
// drawn -- or drawn where it is not -- is the kind of fault that takes an
// afternoon to find and one line to prevent.
function eachInTile(tx, tz, fn) {
  const patch = hash2(tx >> PATCH, tz >> PATCH);
  if (patch % 100 >= PATCH_IN) return;

  const h = hash2(tx, tz);
  // How many, and it is thicker in the middle of a patch than at its edge.
  const n = ((h >>> 3) % (MAX_PER_TILE + 1)) * ((patch >>> 9) % 100 < 35 ? 1 : 0)
          + ((h >>> 11) & 1);
  if (n <= 0) return;

  const tileX = (tx * TILE) | 0, tileZ = (tz * TILE) | 0;
  for (let k = 0; k < n; k++) {
    const id = hash2(tx * 3 + k, tz * 7 - k);
    const wx = (tileX + (id % TILE)) | 0;
    const wz = (tileZ + ((id >>> 8) % TILE)) | 0;
    if (isOnLaunchpad(wx, wz)) continue;
    const base = landAltitude(wx, wz);
    if (base >= SEA_LEVEL) continue;
    const biome = floraBiome(wx, wz, id);
    const kind = (id >>> 16) % KINDS[biome].length;
    fn(id, wx, base, wz, biome, kind);
  }
}

// --- what has been drunk ---------------------------------------------------
//
// A flower that has been emptied stays empty for a minute and then opens
// again, which is the only reason this can be a Map at all: without the
// regrowth it would be a list of every flower the player had ever passed,
// growing for as long as they flew.
const REGROW = 60 * 50;           // a minute, at fifty steps a second
const taken = new Map();          // id -> the tick it was emptied

export function isOpen(id, now) {
  const t = taken.get(id);
  return t === undefined || now - t > REGROW;
}

export function takeFlower(id, now) {
  taken.set(id, now);
  if (taken.size > 512) {
    for (const [k, t] of taken) if (now - t > REGROW) taken.delete(k);
  }
}

export function resetFlowers() {
  taken.clear();
}

// The nearest open flower to a point, within a radius in tiles. Used by the
// bird, which is the only thing that cares.
export function nearestFlower(px, pz, now, maxR) {
  const tx0 = px >> 24, tz0 = pz >> 24;
  let best = null;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      eachInTile((tx0 + dx) | 0, (tz0 + dz) | 0, (id, wx, base, wz, biome, kind) => {
        if (!isOpen(id, now)) return;
        // Through | 0 so the world's wrap is the arithmetic's wrap.
        const ox = ((wx - px) | 0) / TILE, oz = ((wz - pz) | 0) / TILE;
        const d = Math.hypot(ox, oz);
        if (d > maxR || (best && d >= best.d)) return;
        best = { id, x: wx, z: wz, d, bloom: (base - BLOOM_Y[kind % SHAPES.length]) | 0 };
      });
    }
  }
  return best;
}

export function flowersInRow(rd, worldZ, row, camX, camY, camZ, haze, now) {
  if (row < NEAR_ROW) return 0;
  const tz = worldZ >> 24;
  const x0 = ((camX & ~(TILE - 1)) - LANDSCAPE_X) | 0;
  let drawn = 0;

  for (let i = 0; i < TILES_X; i++) {
    const tx = ((x0 + i * TILE) | 0) >> 24;
    eachInTile(tx, tz, (id, wx, base, wz, biome, kind) => {
      const set = isOpen(id, now) ? KINDS : SPENT;
      drawModel(rd, set[biome][kind], null, wx, base, wz, camX, camY, camZ, haze, 0);
      drawn++;
    });
  }
  return drawn;
}
