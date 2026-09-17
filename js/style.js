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
