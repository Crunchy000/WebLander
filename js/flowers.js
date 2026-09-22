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
// They only exist near you. A flower is about a fifth of a tile across, which
// at the far edge of the drawn landscape is a third of a pixel -- so the far
// two thirds of the rows are skipped outright rather than drawn and lost.
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
const STEM = [86, 128, 74];

// --- the shapes ------------------------------------------------------------
//
// Three folds, and all of them small. Petals radiate from the top of a short
// stem and cup upwards, which is what makes them catch the light from above
// and read as a flower rather than as a coloured speck: the underside of a
// petal is in shadow and the top is not, and at this size that difference is
// the whole of the shape.
//
// The stem is a quad rather than a pair of triangles standing at right
// angles, because it is one pixel wide and nobody is going to see round it.
const STEM_W = 0.012;

function flower(petals, radius, cup, height, col, edge) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x, y, z);

  // Stem: a thin upright, leaning a little so a patch of them is not a
  // parade ground.
  const lean = ((petals * 37) % 7 - 3) * 0.006;
  const a = v(-STEM_W, 0, 0), b = v(STEM_W, 0, 0);
  const c = v(STEM_W + lean, -height, 0), d = v(-STEM_W + lean, -height, 0);
  m.face([a, b, c, d], shade(STEM, 0.92));

  // The bloom: one triangle per petal, from a centre raised by the cup.
  const cx = lean, cy = -height;
  const centre = v(cx, cy - cup * 0.35, 0);
  const rim = [];
  for (let i = 0; i < petals; i++) {
    const t = (i / petals) * Math.PI * 2;
    rim.push(v(cx + Math.cos(t) * radius, cy - cup, Math.sin(t) * radius));
  }
  for (let i = 0; i < petals; i++) {
    const j = (i + 1) % petals;
    // Alternating tone, so the folds read even when the light does not.
    facet(m, [centre, rim[i], rim[j]], i % 2 ? col : edge);
  }
  return m;
}

// Built once per paper colour per biome: three sizes and petal counts, which
// is enough variety at a tenth of a tile across. Any more and the extra is
// invisible and the table is four times the size.
// Four or five petals, and never six. Every one of these is a handful of
// pixels and every triangle in it is charged for at full price by the
// rasteriser whether it covers four pixels or four hundred -- so a sixth
// petal is a twenty per cent tax on the whole layer for a fold nobody can
// see. The heart in the middle went the same way, for the same reason.
const SHAPES = [
  { petals: 5, radius: 0.098, cup: 0.040, height: 0.140 },
  { petals: 4, radius: 0.070, cup: 0.030, height: 0.102 },
  { petals: 5, radius: 0.056, cup: 0.042, height: 0.078 },
];

const KINDS = PAPERS.map((papers) => {
  const out = [];
  for (const [col, edge] of papers) {
    for (const s of SHAPES) out.push(flower(s.petals, s.radius, s.cup, s.height, col, edge));
  }
  return out;
});

// --- where they are --------------------------------------------------------

// How near a row has to be to be worth drawing. Rows count from the far edge,
// so this is the last stretch before the craft and a little beyond it.
const NEAR_ROW = TILES_Z - 9;

// The patch field: one value per eight tiles square, so a meadow is about
// eight tiles across and most of the world is not one.
const PATCH = 2;                  // tiles per patch, as a shift
const PATCH_IN = 40;              // ... and how many patches in a hundred have anything
const MAX_PER_TILE = 2;

export function flowersInRow(rd, worldZ, row, camX, camY, camZ, haze) {
  if (row < NEAR_ROW) return 0;
  const tz = worldZ >> 24;
  const x0 = ((camX & ~(TILE - 1)) - LANDSCAPE_X) | 0;
  let drawn = 0;

  for (let i = 0; i < TILES_X; i++) {
    const tileX = (x0 + i * TILE) | 0;
    const tx = tileX >> 24;

    // Is this a meadow at all?
    const patch = hash2(tx >> PATCH, tz >> PATCH);
    if (patch % 100 >= PATCH_IN) continue;

    const h = hash2(tx, tz);
    // How many, and it is thicker in the middle of a patch than at its edge.
    const n = ((h >>> 3) % (MAX_PER_TILE + 1)) * ((patch >>> 9) % 100 < 35 ? 1 : 0)
            + ((h >>> 11) & 1);
    if (n <= 0) continue;

    for (let k = 0; k < n; k++) {
      const hk = hash2(tx * 3 + k, tz * 7 - k);
      const wx = (tileX + (hk % TILE)) | 0;
      const wz = (worldZ + ((hk >>> 8) % TILE)) | 0;
      if (isOnLaunchpad(wx, wz)) continue;
      const base = landAltitude(wx, wz);
      if (base >= SEA_LEVEL) continue;

      const biome = floraBiome(wx, wz, hk);
      const kinds = KINDS[biome];
      drawModel(rd, kinds[(hk >>> 16) % kinds.length], null,
                wx, base, wz, camX, camY, camZ, haze, 0);
      drawn++;
    }
  }
  return drawn;
}
