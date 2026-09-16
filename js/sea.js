// sea.js -- the water surface: swell, surf and glitter.
//
// The sea was the one part of the world that never moved. Water takes the
// slope branch of the terrain palette, and slope is always zero at sea level,
// so every water tile in a row came out the same colour: flat bands, and
// nothing in them changing from one frame to the next.
//
// Four things happen here, and they all hang off two numbers -- how deep the
// water is, and where it is in the swell.
//
// Depth comes free from the seabed, which is the terrain synthesis carried on
// past the point where the surface clamps it. It stands in for distance from
// shore: a point in four tiles of water is a long way out, a point in a
// hand's depth is on the beach. That one number decides both how much swell a
// point may carry and whether it is breaking, and the two are complementary --
// the taper that keeps the swell off the shoreline is exactly where the surf
// goes.
//
// Everything here is drawing only. SEA_LEVEL is an exact sentinel in thirty
// places -- boats sit on it, splashes spawn on it, the player dies at it --
// so nothing below is allowed anywhere near landAltitude.

import { TILE, hash2 } from './maths.js';
import { SEA_LEVEL, seabedAltitude } from './landscape.js';
import { sky, sun, moon } from './daylight.js';
import { weather } from './weather.js';
import { CENTRE_X, FOCAL_X } from './renderer.js';

// --- the swell -------------------------------------------------------------

// Two travelling waves crossing at an angle. The wavelengths are eleven and
// fifteen tiles: the surface is only sampled at the tile corners, so anything
// much shorter than six tiles would alias into a mess rather than reading as
// water.
//
// The phase is in world coordinates, which is what makes the parallax right
// for nothing -- the swell belongs to the sea, not to the screen, so flying
// over it moves you across it exactly as it should.
const K1X = 0.55, K1Z = 0.22, W1 = 0.018;
const K2X = -0.17, K2Z = 0.41, W2 = 0.013;

export function swell(wx, wz) {
  const x = wx / TILE, z = wz / TILE, t = sky.tick;
  return (Math.sin(x * K1X + z * K1Z + t * W1)
        + Math.sin(x * K2X + z * K2Z + t * W2)) * 0.5;
}

// How far below the surface the seabed lies here, in tiles. Zero at the
// waterline, rising to about four and a half well offshore.
export function depthAt(wx, wz) {
  return (seabedAltitude(wx, wz) - SEA_LEVEL) / TILE;
}

// Swell is held off the shallows.
//
// It is worth being clear about what this does and does not do. It does not
// stop the coastline tearing: it cannot tear. The landscape scan projects
// each corner once and both quads that meet there use the same result, so
// moving a corner moves it for everything touching it. What the taper buys is
// that the sea does not visibly slosh up the beach -- a shoreline quad ends up
// slightly tilted where the water meets the land, which is what water does,
// rather than heaving a tile of surf over dry ground.
//
// Measured across the waterline, about a third of the corners that touch land
// still move, by at most half the open-water amount.
const TAPER_IN = 0.15, TAPER_FULL = 0.80;

function taper(depth) {
  if (depth <= TAPER_IN) return 0;
  if (depth >= TAPER_FULL) return 1;
  return (depth - TAPER_IN) / (TAPER_FULL - TAPER_IN);
}

// How far the surface rises and falls, in fixed point. Small: at ten tiles
// out this is a few pixels, which is all a swell needs to read as moving.
const HEAVE = TILE * 0.075;

// The vertical offset to draw a piece of water at. Positive y is down, so a
// crest subtracts.
// A blow gets up a bigger sea. Half again at the top end, which is enough to
// notice without turning the swell into something the drone could not put a
// boat-bombing run over.
function seaState() {
  return 0.72 + 0.62 * weather.strength;
}

export function waveLift(wx, wz, depth) {
  const t = taper(depth);
  return t === 0 ? 0 : -(swell(wx, wz) * t * HEAVE * seaState()) | 0;
}

// --- surf ------------------------------------------------------------------

// Where the water is shallow enough to break. This is the band the swell has
// been tapered out of, so the two never fight over the same stretch of sea.
const SURF_DEPTH = 0.55;

function surfAt(depth) {
  return depth >= SURF_DEPTH ? 0 : 1 - depth / SURF_DEPTH;
}

// --- sun glitter -----------------------------------------------------------

// The path of broken light the sun lays across water towards the viewer.
//
// The camera never rotates, so this is worked out entirely in screen terms: a
// point at (vx, vz) sits at horizontal ratio vx/vz, the lit body sits at
// (x - CENTRE_X) / FOCAL_X, and the glitter is the band where the two agree.
// It follows the sun across the sky through the day and hands over to the
// moon at night without needing to know which is up.
const GLITTER_WIDTH = 0.42;

function glitterBand(vx, vz) {
  const lit = sun.up ? sun : moon;
  if (!lit.up || vz <= 0) return 0;
  const d = Math.abs(vx / vz - (lit.x - CENTRE_X) / FOCAL_X);
  return d >= GLITTER_WIDTH ? 0 : 1 - d / GLITTER_WIDTH;
}

// --- the one number the palette wants -------------------------------------

// How much to brighten this piece of water, in the 4-bit units the terrain
// palette works in before the VIDC packing.
const SWELL_SHADE = 1.8;
const FOAM_SHADE = 4.6;
const GLITTER_SHADE = 3.6;

// Only the top of the swell catches the light: a flat sea glitters in a
// narrow line, a rough one over a wide band, which falls out of this for
// free because the crests are what pass the threshold.
const CREST = 0.45;

// Whitecaps break higher up the swell than the glitter catches it.
const CAP_AT = 0.62;
const CAP_SHADE = 4.2;

export function seaShade(wx, wz, vx, vz, depth) {
  const w = swell(wx, wz);

  // Swell, faded out in the shallows along with the geometry.
  let lift = w * taper(depth) * SWELL_SHADE * seaState();

  // Whitecaps. In a blow the crests break in open water too, not just where
  // it is shallow enough to be surf.
  if (weather.strength > 0.34 && w > CAP_AT) {
    lift += ((w - CAP_AT) / (1 - CAP_AT))
          * ((weather.strength - 0.34) / 0.66) * CAP_SHADE;
  }

  // Surf: white water where it is shallow, arriving with the crests rather
  // than pulsing on a clock of its own.
  const surf = surfAt(depth);
  if (surf > 0) lift += surf * (0.34 + 0.66 * Math.max(0, w)) * FOAM_SHADE;

  // Glitter on the crests, along the sun's path, as bright as the sun is.
  if (w > CREST) {
    const band = glitterBand(vx, vz);
    if (band > 0) {
      lift += band * ((w - CREST) / (1 - CREST)) * GLITTER_SHADE * sky.sunStrength;
    }
  }

  return lift;
}
