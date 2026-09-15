// landscape.js -- the world itself.
//
// The landscape is not stored anywhere. Its height at any point is a closed
// form sum of six sine waves, so the map is infinite, seamless and costs
// nothing to "load". The visible landscape is a fixed 13x11 grid of corners
// (12x10 tiles) that stays anchored to the camera; the world slides through
// it as you fly, which is why the horizon never moves.

import { TILE, sinLookup } from './maths.js';

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

// The visible grid.
export const TILES_X = 19;   // corners left-to-right (18 tiles)
export const TILES_Z = 17;   // corners front-to-back (16 tiles)

export const LANDSCAPE_X = (TILE * (TILES_X - 2)) / 2;          // 5.5 tiles
export const LANDSCAPE_Z_DEPTH = TILE * (TILES_Z - 1);          // 10 tiles
export const LANDSCAPE_Z = LANDSCAPE_Z_DEPTH + 10 * TILE;       // 20 tiles out

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

  // Nothing pokes out below the sea.
  if (alt > SEA_LEVEL) alt = SEA_LEVEL;

  // The launchpad is a flat plateau at the world origin. The comparison is
  // unsigned, so only the one pad at (0,0) qualifies.
  if ((x >>> 0) < LAUNCHPAD_SIZE && (z >>> 0) < LAUNCHPAD_SIZE) {
    alt = LAUNCHPAD_ALT;
  }

  return alt;
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

// Pack 4-bit r/g/b into a VIDC palette byte.
function rgbToVidc(r, g, b) {
  let byte = (((g | b) & 3) | r) & 7;
  if (r & 8) byte |= 0x10;
  byte |= (g & 0x0c) << 3;
  if (b & 4) byte |= 0x08;
  if (b & 8) byte |= 0x80;
  return byte & 0xff;
}

const colourCache = new Map();

// Work out the colour of a tile from the altitude of its corners and its
// position in the grid.
//
// `prevAlt` is the altitude of the corner to the left, which gives us the
// slope; `row` is the grid row, 1 at the horizon up to TILES_Z-1 at our feet.
// Brightness is row + slope, which lights the scene from above and slightly
// to the left, and fades the distance into shadow for free.
export function tileColour(prevAlt, alt, row) {
  let slope = (prevAlt - alt) | 0;
  if (slope < 0) slope = 0;

  let r, g, b;

  if (alt === LAUNCHPAD_ALT) {
    // Concrete.
    r = 4; g = 4; b = 4;
  } else if (alt === SEA_LEVEL && prevAlt === SEA_LEVEL) {
    // Open water.
    r = 0; g = 0; b = 4;
  } else {
    // Green from bit 3 of the altitude, red from bit 2. Because those bits
    // tumble almost randomly from one corner to the next, the ground comes
    // out mottled -- gentle green flecked with patches of red-brown dirt.
    g = ((alt & 8) >> 1) + 4;
    r = alt & 4;
    b = 0;
  }

  const bright = (row + (slope >>> 22)) | 0;
  r += bright;
  g += bright;
  b += bright;

  if (r > 15) r = 15;
  if (g > 15) g = 15;
  if (b > 15) b = 15;

  const byte = rgbToVidc(r, g, b);
  let rgb = colourCache.get(byte);
  if (rgb === undefined) {
    rgb = vidcToRgb(byte);
    colourCache.set(byte, rgb);
  }
  return rgb;
}

// The sky. The original clears to black; a very dark blue reads better on a
// modern panel without changing the character of the scene.
export const SKY_COLOUR = [0, 0, 0];
