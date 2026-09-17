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
