// style.js -- which visual language the game is speaking.
//
// An exploration branch. 'archimedes' is the original: a VIDC palette, its
// dither, its speckle and its hard banding, which is the thing this project
// set out to be. 'serene' is the other direction -- flat shapes, few colours,
// gradients rather than quantisation, and a deep parallax horizon, after the
// Alto's Odyssey school of minimal geometry and mood over fidelity.
//
// One flag rather than a fork of every file: the two styles share all of the
// geometry, all of the simulation and all of the input, and differ only in
// how a surface is coloured and what stands behind it.
export const STYLE = 'serene';

export const serene = () => STYLE === 'serene';

// --- the serene palette ----------------------------------------------------
//
// One transform, applied to every painted surface in the world at build time,
// which is what makes a whole scene look like it was drawn by one hand.
//
// Two things happen to a colour. Its value is posterised into a handful of
// steps, so a model is a few flat tones rather than a continuous range -- that
// is the "minimalist geometry" line of the brief, and in a flat-shaded
// renderer it is the only lever that matters. And most of its chroma is taken
// away, leaving just enough that a tree still reads as green and a block as
// red, but not enough for either to shout over the horizon behind it.
//
// The value is also squeezed into a band well short of black and white. Pure
// silhouettes suit a side-on game where nothing is in your way; here you fly
// among these things and have to judge distance to them, so they keep enough
// range to be read against the ground.
const LEVELS = 4;          // distinct tones a surface may take
const CHROMA = 0.30;       // how much of the original colour survives
const LO = 0.26, HI = 0.78;

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

export function sereneTone(col) {
  const lum = 0.30 * col[0] + 0.59 * col[1] + 0.11 * col[2];
  const q = Math.round((lum / 255) * (LEVELS - 1)) / (LEVELS - 1);
  const v = (LO + (HI - LO) * q) * 255;
  return [
    clamp(v + (col[0] - lum) * CHROMA),
    clamp(v + (col[1] - lum) * CHROMA),
    clamp(v + (col[2] - lum) * CHROMA),
  ];
}

// Paint, as this style would have mixed it. Every palette constant in the
// world goes through here at module load, so the cost is nil and there is no
// second copy of any model.
export function paint(col) {
  return serene() ? sereneTone(col) : col;
}

// --- dressing a model for where it stands ----------------------------------
//
// The same toy blocks turn up in every biome, and in the desert a red-and-blue
// tower was the only thing for miles that had not been bleached by the sun.
// Rather than a second set of models per biome -- which would be the same
// geometry three times over -- a model is re-dressed at build time: its
// colours are remapped onto a ramp belonging to the ground it stands on.
//
// Value is what carries a flat-shaded model. Every face of a block already
// differs from its neighbours by brightness alone -- that is the facet
// lighting -- so remapping brightness onto a new ramp keeps every edge, every
// corner and every roof pitch exactly as legible as it was, and only the hue
// changes. A little of the original colour is kept so a stack is still six
// distinguishable blocks rather than one lump.
function ramp(col, lo, hi, keep) {
  const lum = 0.30 * col[0] + 0.59 * col[1] + 0.11 * col[2];
  const t = Math.pow(lum / 255, 0.92);
  return [
    clamp(lo[0] + (hi[0] - lo[0]) * t + (col[0] - lum) * keep),
    clamp(lo[1] + (hi[1] - lo[1]) * t + (col[1] - lum) * keep),
    clamp(lo[2] + (hi[2] - lo[2]) * t + (col[2] - lum) * keep),
  ];
}

// Sandstone, from the shadowed underside of a mesa to its sunlit cap -- the
// same two ends the rocks out there are already drawn between, so a painted
// tower and the cliff behind it are made of the same stuff.
const SAND_LO = [84, 58, 42], SAND_HI = [226, 192, 148];

// Ice: not white. Snow in shadow is blue, and a bright white would put the
// brightest thing in a frozen scene on a toy block rather than on the sun.
const ICE_LO = [96, 118, 150], ICE_HI = [236, 244, 250];

export function sandstone(col) { return ramp(col, SAND_LO, SAND_HI, 0.16); }
export function icebound(col) { return ramp(col, ICE_LO, ICE_HI, 0.12); }
