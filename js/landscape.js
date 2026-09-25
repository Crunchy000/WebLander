// landscape.js -- the world itself.
//
// The landscape is not stored anywhere. Its height at any point is a closed
// form sum of six sine waves, so the map is infinite, seamless and costs
// nothing to "load". The visible landscape is a fixed 13x11 grid of corners
// (12x10 tiles) that stays anchored to the camera; the world slides through
// it as you fly, which is why the horizon never moves.

import { TILE, sinLookup } from './maths.js';
import { SCREEN_W, SCREEN_W_MAX, FOCAL_X, onScreenShape } from './renderer.js';
import { sky, litColour, silhouetteDark } from './daylight.js';
import { groundBase, tintFor, tintLevel, TINT_STEPS } from './biome.js';
import { serene } from './style.js';

// --- world constants -------------------------------------------------------
//
// The y-axis points DOWN: smaller y means higher altitude, and y = 0 is the
// ceiling of the world. This is counter-intuitive but it is what the original
// does, and inverting it would mean re-deriving every comparison below.

export const LAND_MID_HEIGHT   = TILE * 5;          // mean ground level
export const SEA_LEVEL         = 0x05500000;        // 5.3125 tiles
export const LAUNCHPAD_ALT     = 0x03500000;        // 3.3125 tiles
export const LAUNCHPAD_SIZE    = TILE * 8;          // 8 tiles square
export const UNDERCARRIAGE_Y   = 0x00640000;        // ship centre -> feet
export const LAUNCHPAD_Y       = LAUNCHPAD_ALT - UNDERCARRIAGE_Y;

// The visible grid: a fixed slab of tiles that stays anchored to the camera
// while the world slides through it.
//
// Twenty-four tiles deep, which puts the far row thirty-four tiles out. It
// was sixteen, and twenty-six, and the extra eight are all about the join.
// Real terrain is drawn out to the far row and a flat silhouette takes over
// beyond it, and wherever that handover happens there is a line across the
// picture where lit, textured ground meets a painted band. At twenty-six
// tiles that line was close enough to see. At thirty-four it is a third
// smaller on screen, far enough out to be at the end of the haze ramp, and
// most of it is hidden behind the hills in front of it.
export const TILES_Z = 25;   // corners front-to-back (24 tiles)

export const LANDSCAPE_Z_DEPTH = TILE * (TILES_Z - 1);          // 24 tiles
export const LANDSCAPE_Z = LANDSCAPE_Z_DEPTH + 10 * TILE;       // 34 tiles out

// How many tiles either side of centre the grid must reach. It is not a
// taste: at the far row, one tile of half-width buys FOCAL_X/distance pixels
// of screen, and the grid has to carry half the buffer's width at that
// distance or the ground runs out before the corner of the frame does. It
// used to be written as a count measured at one screen width and scaled; as
// a formula it also tracks the depth, which matters because pushing the far
// row further out makes every tile of width buy fewer pixels.
//
// It follows the width, which follows the window (see renderer.js), so it is
// worked out again whenever that changes. Anything that holds a row of the
// grid in memory sizes it by TILES_X_MAX, the grid at the widest shape the
// game allows, and never has to be reallocated.
const tilesFor = (w) => 2 + 2 * Math.ceil(((w / 2) * (LANDSCAPE_Z / TILE)) / FOCAL_X);
export const TILES_X_MAX = tilesFor(SCREEN_W_MAX);
export let TILES_X = tilesFor(SCREEN_W);
export let LANDSCAPE_X = (TILE * (TILES_X - 2)) / 2;
onScreenShape(() => {
  TILES_X = tilesFor(SCREEN_W);
  LANDSCAPE_X = (TILE * (TILES_X - 2)) / 2;
});

// Every ramp that shades the ground by distance -- the haze, the brightness
// lift, the near-and-steep silhouette -- was written against a sixteen-tile
// grid and indexed by row number. Row number is not distance: deepen the grid
// and the same row is somewhere else entirely, so all three ramps would
// stretch and the whole middle distance would change tone.
//
// They are anchored to the far edge the game was tuned at instead. A tile
// eighteen tiles out is shaded exactly as it was before the grid was
// deepened, and the rows added beyond the old far edge sit at the end of
// every ramp, which is where you want them: fully hazed, so they dissolve
// into the horizon rather than arriving as a new band of colour.
const ROWS_AT_17 = 17;
const ROW_SHIFT = TILES_Z - ROWS_AT_17;

// The player sits in the middle of the landscape band, which puts the eye
// LANDSCAPE_Z_MID behind them. CAMERA_PLAYER_Z is the gap between the player
// and the *back* row of the landscape.
export const CAMERA_PLAYER_Z = (TILES_Z - 6) * TILE;            // 5 tiles
export const LANDSCAPE_Z_MID = LANDSCAPE_Z - CAMERA_PLAYER_Z;   // 15 tiles

export const SAFE_HEIGHT = (TILE * 3) / 2;   // clearance needed over scenery
export const LANDING_SPEED = 0x00080000;     // fastest survivable descent rate

// ---------------------------------------------------------------------------
// Altitude
// ---------------------------------------------------------------------------

// The six-term Fourier synthesis. Each term is a sine of an integer
// combination of x and z; the first four contribute a whole tile of height
// each and the last two half a tile, for a total range of +/- 5 tiles about
// LAND_MID_HEIGHT.
//
// Everything here is deliberately int32: the low bits of the result are later
// used as a dither pattern for the tile colours, so they have to come out the
// same way they did on an ARM2.
export function landAltitude(x, z) {
  // Build up the six angle arguments using only shifts and adds.
  const a = (x - (z << 1)) | 0;              // x - 2z

  let b = (z + (x << 1)) | 0;                // 2x + z
  b = (z + (b << 1)) | 0;                    // 4x + 3z

  const c = (b + x) | 0;                     // 5x + 3z

  let d = (z - (x << 1)) | 0;                // z - 2x
  d = ((d << 1) - x) | 0;                    // 2z - 5x
  d = (d + z) | 0;                           // 3z - 5x

  let e = (z + (x << 1)) | 0;                // 2x + z
  e = (z + (e << 2)) | 0;                    // 8x + 5z
  e = (e - x) | 0;                           // 7x + 5z

  const f = (c + (z << 3)) | 0;              // 5x + 11z
  const g = (z + (c << 1)) | 0;              // 10x + 7z

  let sum = sinLookup(a) >> 7;
  sum = (sum + (sinLookup(b) >> 7)) | 0;
  sum = (sum + (sinLookup(d) >> 7)) | 0;
  sum = (sum + (sinLookup(e) >> 7)) | 0;
  sum = (sum + (sinLookup(f) >> 8)) | 0;
  sum = (sum + (sinLookup(g) >> 8)) | 0;

  let alt = (LAND_MID_HEIGHT - sum) | 0;

  // Nothing pokes out below the sea. The unclamped value is still worth
  // having -- see seabedAltitude below -- because how far the ground carries
  // on falling past this point is exactly how deep the water is.
  if (alt > SEA_LEVEL) alt = SEA_LEVEL;

  // The launchpad is a flat plateau at the world origin. The comparison is
  // unsigned, so only the one pad at (0,0) qualifies.
  if ((x >>> 0) < LAUNCHPAD_SIZE && (z >>> 0) < LAUNCHPAD_SIZE) {
    alt = LAUNCHPAD_ALT;
  }

  return alt;
}

// The seabed: the same six-term synthesis, but without the clamp at sea level
// and without the launchpad plateau. Above water it agrees with landAltitude
// exactly; below it, it keeps going down.
//
// This is what gives the sea a depth for nothing. Depth is the one number the
// whole water surface needs: it says how far from shore a point is, which
// decides both how much swell it may carry and whether it is breaking.
export function seabedAltitude(x, z) {
  const a = (x - (z << 1)) | 0;
  let b = (z + (x << 1)) | 0;
  b = (z + (b << 1)) | 0;
  const c = (b + x) | 0;
  let d = (z - (x << 1)) | 0;
  d = ((d << 1) - x) | 0;
  d = (d + z) | 0;
  let e = (z + (x << 1)) | 0;
  e = (z + (e << 2)) | 0;
  e = (e - x) | 0;
  const f = (c + (z << 3)) | 0;
  const g = (z + (c << 1)) | 0;

  let sum = sinLookup(a) >> 7;
  sum = (sum + (sinLookup(b) >> 7)) | 0;
  sum = (sum + (sinLookup(d) >> 7)) | 0;
  sum = (sum + (sinLookup(e) >> 7)) | 0;
  sum = (sum + (sinLookup(f) >> 8)) | 0;
  sum = (sum + (sinLookup(g) >> 8)) | 0;
  return (LAND_MID_HEIGHT - sum) | 0;
}

// Is the ground here level enough to settle a craft on? Samples a ring
// around the point and measures how far the corners deviate from the middle.
// Returns the deviation in tiles; small is flat.
export function groundRoughness(x, z, radius = TILE * 0.9) {
  const mid = landAltitude(x, z);
  let worst = 0;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const h = landAltitude((x + Math.cos(a) * radius) | 0, (z + Math.sin(a) * radius) | 0);
    const d = Math.abs(h - mid);
    if (d > worst) worst = d;
  }
  return worst / TILE;
}

// How much unevenness a landing site may have and still be usable.
export const FLAT_ENOUGH = 0.22;

export function isOnLaunchpad(x, z) {
  return (x >>> 0) < LAUNCHPAD_SIZE && (z >>> 0) < LAUNCHPAD_SIZE;
}

// ---------------------------------------------------------------------------
// Tile colour
// ---------------------------------------------------------------------------
//
// Colours come out as a VIDC palette byte, exactly as the hardware wanted
// them, and are then expanded back to RGB. Going through the 8-bit
// bottleneck matters: the packing shares the low two bits between all three
// channels, and that quantisation is a large part of why the landscape looks
// the way it does.

// Expand a VIDC1 256-colour byte into 8-bit RGB.
//
//   bit 7 = blue hi    bit 6 = green hi   bit 5 = green lo   bit 4 = red hi
//   bit 3 = blue lo    bit 2 = red lo     bits 1-0 = tint, shared by all three
function vidcToRgb(byte) {
  const tint = byte & 3;
  const r = tint | (((byte >> 2) & 1) << 2) | (((byte >> 4) & 1) << 3);
  const g = tint | (((byte >> 5) & 1) << 2) | (((byte >> 6) & 1) << 3);
  const b = tint | (((byte >> 3) & 1) << 2) | (((byte >> 7) & 1) << 3);
  // 4 bits -> 8 bits.
  return [r * 17, g * 17, b * 17];
}

// Pack 4-bit r/g/b into a VIDC palette byte: the nearest colour the hardware
// can actually make, rather than a slice of the bits of the one we asked for.
//
// The byte is not three independent channels. Two bits of it -- the tint --
// are the bottom two bits of all three at once, and each channel gets two
// bits of its own on top. So a channel can only be tint, tint+4, tint+8 or
// tint+12, and every channel has to share the same tint.
//
// Slicing the bits picked the tint out of the low bits of whatever was asked
// for, which sawtooths: as a tile brightens through the distance ramp the
// tint climbs 0,1,2,3 and then drops back to 0 while the high bits carry, and
// all three channels fall by three at once. That is a colour step, not a
// brightness step, and it is what made a hillside sparkle as you flew at it.
// Traced down one slope, the worst single step was 101 across RGB -- a tile
// going from blue to near-white and back.
//
// Choosing the nearest entry instead costs four iterations and makes the ramp
// monotonic. The palette is untouched: the same 256 colours, the same sharing,
// the same banding. Only the rounding changes.
const packCache = new Int16Array(4096).fill(-1);

function rgbToVidc(r, g, b) {
  const key = (r << 8) | (g << 4) | b;
  const hit = packCache[key];
  if (hit >= 0) return hit;

  let bestByte = 0, bestErr = 1e9;
  for (let tint = 0; tint < 4; tint++) {
    // Per channel, the closest multiple of four above the tint.
    let err = 0;
    let kr = (r - tint + 2) >> 2; if (kr < 0) kr = 0; else if (kr > 3) kr = 3;
    let kg = (g - tint + 2) >> 2; if (kg < 0) kg = 0; else if (kg > 3) kg = 3;
    let kb = (b - tint + 2) >> 2; if (kb < 0) kb = 0; else if (kb > 3) kb = 3;
    const vr = tint + kr * 4, vg = tint + kg * 4, vb = tint + kb * 4;
    // Luminance error counts for a great deal more than the rest of it. An
    // entry that is a shade off in hue is invisible; one that is a shade off
    // in brightness makes the tile flash as the ramp walks it in.
    const dl = 0.30 * (r - vr) + 0.59 * (g - vg) + 0.11 * (b - vb);
    err = Math.abs(r - vr) + Math.abs(g - vg) + Math.abs(b - vb) + Math.abs(dl) * 6;
    if (err < bestErr) {
      bestErr = err;
      bestByte = tint
        | ((kr & 1) << 2) | ((kr >> 1) << 4)
        | ((kg & 1) << 5) | ((kg >> 1) << 6)
        | ((kb & 1) << 3) | ((kb >> 1) << 7);
    }
  }
  packCache[key] = bestByte;
  return bestByte;
}

const colourCache = new Map();

// Work out the colour of a tile from the altitude of its corners and its
// position in the grid.
//
// `prevAlt` is the altitude of the corner to the left, which gives us the
// slope; `row` is the grid row, 1 at the horizon up to TILES_Z-1 at our feet.
// Brightness is row + slope, which lights the scene from above and slightly
// to the left, and fades the distance into shadow for free.
const base = [0, 0, 0];
const tintScratch = [0, 0, 0];
const darkScratch = [0, 0, 0];

export function tileColour(prevAlt, alt, row, wx, wz, lift = 0) {
  let slope = (prevAlt - alt) | 0;
  if (slope < 0) slope = 0;

  let r, g, b;

  if (alt === LAUNCHPAD_ALT) {
    // Concrete.
    r = 4; g = 4; b = 4;
  } else {
    // What colour the ground is depends on where in the world it is, but not
    // on how it is made: every biome mottles itself from bits 2 and 3 of the
    // altitude, exactly as the temperate ground always did. Those bits tumble
    // almost randomly from one corner to the next, and that is what gives the
    // landscape its speckle -- the biome only decides what it is speckled
    // with. Blending happens here, before the palette, so the quantisation
    // dithers the borders for nothing.
    const wet = alt === SEA_LEVEL && prevAlt === SEA_LEVEL;
    groundBase(wx, wz, alt, wet, base);
    r = base[0]; g = base[1]; b = base[2];
    if (serene() && !wet) {
      // The speckle comes from bits 2 and 3 of the altitude. Sampling both
      // ways round and taking the middle is the cheapest way to have the
      // biome's colour without the noise it is normally carried in.
      groundBase(wx, wz, alt & ~12, false, base);
      const lo0 = base[0], lo1 = base[1], lo2 = base[2];
      groundBase(wx, wz, alt | 12, false, base);
      r = (lo0 + base[0]) / 2; g = (lo1 + base[1]) / 2; b = (lo2 + base[2]) / 2;
    }
    // Swell, surf and glitter all arrive as one brightness offset, worked out
    // by sea.js where the camera is known. Adding it here, before the
    // packing, means the quantisation dithers the wave for nothing.
    if (lift !== 0) { r += lift; g += lift; b += lift; }
  }

  // The other visual language: no palette, no quantisation, no speckle. The
  // ground is one flat tone per facet, lifted smoothly by distance and slope,
  // which is what "minimalist geometry" comes down to in a renderer that only
  // ever draws flat facets anyway. The mottle is deliberately averaged out --
  // it is the single largest source of visual noise here, and noise is the
  // one thing this style has no use for.
  if (serene() && alt !== LAUNCHPAD_ALT) {
    const bare = (row - ROW_SHIFT + (slope >>> 21)) / 15;
    const lift = Math.min(1, Math.max(0, bare));
    const rgbS = [
      Math.round(Math.min(255, (r * 17) + (252 - r * 17) * lift * 0.62)),
      Math.round(Math.min(255, (g * 17) + (248 - g * 17) * lift * 0.62)),
      Math.round(Math.min(255, (b * 17) + (250 - b * 17) * lift * 0.62)),
    ];
    // Near, steep ground goes to silhouette.
    //
    // A hill close ahead used to be the worst thing on screen: the scan hits
    // it at a glancing angle, the near rows are enormous, and a face that
    // should read as a wall arrives as a few huge facets flickering between
    // shades -- which looked like a fault rather than a hill. The style
    // already answers this question further away, with the flat dark ranges
    // along the horizon, so the near ground gives the same answer: it stops
    // being lit and becomes a shape.
    //
    // It needs both conditions. Near and flat is the ground you are about to
    // land on and has to stay readable; steep and far is a hill you are
    // looking at across a valley and has its own haze. Near AND steep is the
    // one that was breaking, and the one worth turning into a silhouette.
    // Steepness is measured off the raw rise, not the shift the brightness
    // ramp uses. That shift quantises to quarter-tiles, and this landscape is
    // gentler than that almost everywhere -- measured over forty thousand
    // tiles, the ninetieth percentile of rise is 0.175 of a tile and the
    // ninety-ninth is 0.418, so a quarter-tile step reads zero for 94% of the
    // ground and the effect would never once have fired. Saturating at 0.35
    // puts the top few per cent of faces at full silhouette, which is what
    // "a hill close ahead" means.
    const near = Math.max(0, (row - 1 - ROW_SHIFT) / (ROWS_AT_17 - 2));
    const steep = Math.min(1, (slope / TILE) / 0.35);
    const sil = near * near * steep;
    if (sil > 0.01) {
      // The same dark the ranges use, warm by day and cool by night, so the
      // foreground and the horizon are speaking the same language.
      silhouetteDark(darkScratch);
      const dr = darkScratch[0], dg = darkScratch[1], db = darkScratch[2];
      const k = sil * 0.88;
      rgbS[0] = Math.round(rgbS[0] + (dr - rgbS[0]) * k);
      rgbS[1] = Math.round(rgbS[1] + (dg - rgbS[1]) * k);
      rgbS[2] = Math.round(rgbS[2] + (db - rgbS[2]) * k);
    }

    const lvl = tintLevel(wx, wz);
    if (lvl !== TINT_STEPS) {
      tintFor(lvl, tintScratch);
      rgbS[0] = Math.min(255, Math.round(rgbS[0] * tintScratch[0]));
      rgbS[1] = Math.min(255, Math.round(rgbS[1] * tintScratch[1]));
      rgbS[2] = Math.min(255, Math.round(rgbS[2] * tintScratch[2]));
    }
    return litColour(rgbS, fogForRow(row));
  }

  let bright = (row - ROW_SHIFT + (slope >>> 22)) | 0;

  // The distance ramp brightens all three channels by the same amount, and
  // used to be free to push them past the top of the range, where they
  // clipped one at a time. A tile whose leading channel clipped first lost
  // its colour and went white while its neighbours, a shade less steep, did
  // not -- so a hillside sparkled as you flew at it, tile by tile, which is
  // the thing that reads as flickering colour rather than as shading.
  //
  // Land takes only the ramp it has room for, so the gap between the channels
  // -- which is the colour -- survives intact. Measured over two thousand
  // sloped tiles walked through every row: 14.4% of steps moved the hue
  // before, 1.5% after, and the average sideways move in colour fell from
  // 12.8 to 1.2.
  //
  // Water keeps the whole ramp. Driving the sea into the ceiling is exactly
  // what gives it its stripes, and the stripes are the point.
  if (!(alt === SEA_LEVEL && prevAlt === SEA_LEVEL)) {
    const head = 15 - Math.max(r, Math.max(g, b));
    if (bright > head) bright = head < 0 ? 0 : head;
  }

  r = (r + bright) | 0;
  g = (g + bright) | 0;
  b = (b + bright) | 0;

  if (r > 15) r = 15;
  if (g > 15) g = 15;
  if (b > 15) b = 15;
  if (r < 0) r = 0;
  if (g < 0) g = 0;
  if (b < 0) b = 0;

  const byte = rgbToVidc(r, g, b);
  let rgb = colourCache.get(byte);
  if (rgb === undefined) {
    rgb = vidcToRgb(byte);
    colourCache.set(byte, rgb);
  }

  // The biome's own tint, laid over the palette so it survives the clipping
  // that the row brightness causes. Keyed on the quantised climate, so the
  // cache holds at most seventeen variants of each palette entry.
  const level = tintLevel(wx, wz);
  if (level !== TINT_STEPS) {
    const key = byte | ((level + 1) << 9);
    let tinted = colourCache.get(key);
    if (tinted === undefined) {
      tintFor(level, tintScratch);
      tinted = [
        Math.min(255, Math.round(rgb[0] * tintScratch[0])),
        Math.min(255, Math.round(rgb[1] * tintScratch[1])),
        Math.min(255, Math.round(rgb[2] * tintScratch[2])),
      ];
      colourCache.set(key, tinted);
    }
    rgb = tinted;
  }

  // Time of day and haze, both applied after the palette so the quantisation
  // still happens on the real colour. Row 1 is the far edge and TILES_Z-1 is
  // underfoot; squaring the ramp keeps the near ground clean and piles the
  // haze into the distance, which is how aerial perspective actually behaves.
  return litColour(rgb, fogForRow(row));
}

// How much of a landscape row is lost to haze. Weather thickens it: murk
// pushes the far rows towards solid and brings the near ones in as well, which
// is what shrinks the world in bad visibility.
export function fogForRow(row) {
  const t = Math.min(1, 1 - (row - 1 - ROW_SHIFT) / (ROWS_AT_17 - 2));
  const reach = FOG_MAX + (1 - FOG_MAX) * sky.murk * 0.85;
  return Math.max(0, Math.min(1, reach * t * (t + sky.murk * (1 - t))));
}

// The sky, and the haze that distant land fades into, now live in
// daylight.js because they change with the hour. The one thing that does not
// change is the relationship: the haze colour is always the sky colour at the
// horizon. That is the whole trick, because it makes far-off ground dissolve
// into the sky rather than ending at a hard line, which also hides the edge
// of the fixed landscape grid -- and it has to hold at noon and at midnight
// alike.
export { sky } from './daylight.js';

// How much of the far edge is lost to haze. Enough to soften the grid edge,
// not so much that the landscape turns to soup.
export const FOG_MAX = 0.62;
