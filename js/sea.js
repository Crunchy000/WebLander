// sea.js -- the water surface: a still sea, with surf along the shore.
//
// Water takes the slope branch of the terrain palette, and slope is always
// zero at sea level, so every water tile in a row would come out the same
// colour: flat bands. What breaks them up is depth, which comes free from the
// seabed -- the terrain synthesis carried on past the point where the surface
// clamps it. It stands in for distance from shore: a point in four tiles of
// water is a long way out, a point in a hand's depth is on the beach, and the
// shallows are drawn as white water.
//
// The sea used to heave as well: two travelling waves, with whitecaps in a
// blow and the sun's glitter on the crests. It was taken out for the Xbox,
// whose browser runs the game with the JavaScript JIT off. Moving water had
// to be worked out again for every corner of every frame, where a still sea
// depends on nothing but where the tile is, and so goes in the ground pass's
// tile cache with the land (game.js).
//
// Everything here is drawing only. SEA_LEVEL is an exact sentinel in thirty
// places -- boats sit on it, splashes spawn on it, the player dies at it --
// so nothing below is allowed anywhere near landAltitude.

import { TILE } from './maths.js';
import { SEA_LEVEL, seabedAltitude } from './landscape.js';

// How far below the surface the seabed lies here, in tiles. Zero at the
// waterline, rising to about four and a half well offshore.
export function depthAt(wx, wz) {
  return (seabedAltitude(wx, wz) - SEA_LEVEL) / TILE;
}

// Where the water is shallow enough to break, and how white it is there, in
// the 4-bit units the terrain palette works in before the VIDC packing.
const SURF_DEPTH = 0.55;
const SURF_SHADE = 4.6 * 0.34;

// How much to brighten a piece of water at this point.
export function seaShade(wx, wz) {
  const depth = depthAt(wx, wz);
  return depth >= SURF_DEPTH ? 0 : (1 - depth / SURF_DEPTH) * SURF_SHADE;
}
