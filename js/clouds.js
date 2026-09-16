// clouds.js -- blocky clouds, drifting, with something behind them.
//
// They sit between the sun and the landscape, which is the only ordering that
// lets one drift across the other and still be painted over by the horizon.
//
// Each cloud is a row of columns of stacked square cells, so its outline is a
// staircase rather than a curve. That suits a game whose sun is a square and
// whose every surface is a flat facet far better than the rounded lobes this
// started as -- those read as a row of bread rolls at any size.
//
// They are also genuinely translucent rather than faked. The renderer has
// carried an alpha byte since the first commit and never used it, so turning
// blending on costs nothing anywhere else: every other colour in the game is
// opaque and blends to exactly itself.
//
// Nothing here picks a colour. A cloud is the sky it sits in, pushed towards
// whatever is lighting it, so dawn turns them pink, dusk gold and night a
// dark slate without any of it being written down. Foul weather is the one
// case that inverts, pushing them past the sky towards slate: what makes a
// sky look heavy is cloud darker than the gap it sits in.

import { sky, sun, moon, skyColourAt, SKY_BAND_2 } from './daylight.js';
import { SCREEN_W } from './renderer.js';

// Few, because they are big. A dozen of these wide enough to matter simply
// tile the sky into overcast, and where they overlap the blending compounds
// until it is opaque -- which is the opposite of sitting in the background.
const COUNT = 11;

// The band clouds live in. It stops well short of the horizon, and of the
// height the craft flies at: big clouds down there crowd the machine you are
// meant to be watching, however faint they are.
const TOP = 4, BOTTOM = SKY_BAND_2 - 36;

// They wrap through a span wider than the screen, so they have somewhere to
// come from and somewhere to go.
const SPAN = SCREEN_W + 200;

// Soft casts to hold them apart from one another. Kept faint on purpose:
// these are meant to be noticed as variety, not as coloured clouds.
const TINTS = [
  [255, 232, 214],
  [212, 226, 255],
  [238, 218, 248],
  [255, 220, 204],
  [216, 242, 238],
];

// How tall a cloud may stack, in cells.
const MAX_STACK = 4;

function makeClouds() {
  let s = 0x1b9f37;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  const out = [];
  for (let i = 0; i < COUNT; i++) {
    const cols = 4 + Math.floor(rnd() * 7);
    // Big blocks. A wide cloud now spans a good part of the screen, which it
    // can afford to because they sit so far back in the picture -- see the
    // contrast they are drawn at below.
    // Skewed small: mostly modest clouds with the occasional big one, rather
    // than a sky of uniformly enormous ones.
    const cell = 6 + rnd() * rnd() * 22;

    // A drunkard's walk up and down gives a stepped skyline with the odd
    // tower and the odd notch, which is what stops a row of blocks reading as
    // a wall.
    const heights = [];
    let h = 1 + Math.floor(rnd() * 2);
    for (let k = 0; k < cols; k++) {
      if (rnd() < 0.45) h += rnd() < 0.5 ? 1 : -1;
      h = h < 1 ? 1 : h > MAX_STACK ? MAX_STACK : h;
      heights.push(h);
    }
    // Ends taper, so a cloud finishes rather than being cut off.
    heights[0] = 1;
    heights[cols - 1] = 1;

    out.push({
      x: rnd() * SPAN,
      // Higher clouds are smaller and drift slower: the only depth cue going
      // when everything is painted on the same flat sky.
      depth: 0.35 + rnd() * 0.65,
      cols,
      cell,
      heights,
      tone: 0.84 + rnd() * 0.16,
      // Each cloud is tinted a little away from the others. Real skies are
      // not uniformly white and a dozen identical greys is the surest way to
      // make a sky look printed on.
      tint: TINTS[Math.floor(rnd() * TINTS.length)],
      tintAmt: 0.10 + rnd() * 0.20,
    });
  }
  // Far ones first, so nearer clouds pass in front.
  out.sort((a, b) => a.depth - b.depth);
  return out;
}

const CLOUDS = makeClouds();

const MOONLIT = [188, 200, 226];

const STORM = [58, 62, 74];

const faceLit = [0, 0, 0, 0], faceDim = [0, 0, 0, 0];
const capLit = [0, 0, 0, 0], capDim = [0, 0, 0, 0];
const face = [0, 0, 0, 0], cap = [0, 0, 0, 0];

function mix(out, a, b, t) {
  out[0] = Math.round(a[0] + (b[0] - a[0]) * t);
  out[1] = Math.round(a[1] + (b[1] - a[1]) * t);
  out[2] = Math.round(a[2] + (b[2] - a[2]) * t);
  out[3] = a[3] === undefined ? 255 : Math.round(a[3] + ((b[3] === undefined ? 255 : b[3]) - a[3]) * t);
  return out;
}

export function drawClouds(rd) {
  const murk = sky.murk;
  const lit = sun.up ? sun.col : MOONLIT;

  // They belong behind everything. Big shapes at this contrast read as sky
  // rather than as objects, which is the whole point of making them larger:
  // scale carries them, not brightness.
  const alpha = Math.round(150 + 72 * murk);

  for (const c of CLOUDS) {
    const speed = (0.055 + murk * 0.10) * c.depth;
    let x = (c.x + sky.tick * speed) % SPAN;
    if (x < 0) x += SPAN;
    x -= 100;

    // Fair weather is the common case and should not be the small one.
    const scale = (0.88 + 0.42 * murk) * (0.6 + c.depth * 0.8);
    const y = TOP + (BOTTOM - TOP) * (1 - c.depth) * 0.9 + murk * 12;
    if (y > BOTTOM) continue;

    const back = skyColourAt(y);
    // A face towards the light and a face away from it. A purely vertical
    // gradient gave every cloud the same flat front whichever way the sun
    // was; lighting one flank is what gives a block its form.
    mix(faceLit, back, lit, 0.56 * c.tone);
    mix(faceDim, back, lit, 0.33 * c.tone);
    // The top of a block catches more than its side, always.
    mix(capLit, back, lit, 0.70 * c.tone);
    mix(capDim, back, lit, 0.45 * c.tone);
    // Then this cloud's own cast, over the lot.
    mix(faceLit, faceLit, c.tint, c.tintAmt);
    mix(faceDim, faceDim, c.tint, c.tintAmt);
    mix(capLit, capLit, c.tint, c.tintAmt);
    mix(capDim, capDim, c.tint, c.tintAmt);
    if (murk > 0.01) {
      mix(faceLit, faceLit, STORM, murk * 0.78);
      mix(faceDim, faceDim, STORM, murk * 0.86);
      mix(capLit, capLit, STORM, murk * 0.70);
      mix(capDim, capDim, STORM, murk * 0.80);
    }
    faceLit[3] = faceDim[3] = alpha;
    capLit[3] = capDim[3] = Math.min(255, alpha + 24);

    const src = sun.up ? sun.x : (moon.up ? moon.x : SCREEN_W / 2);
    const toSun = src < x ? -1 : 1;

    const cw = c.cell * scale;
    if (cw < 0.8) continue;                 // too far to resolve
    const lip = Math.max(1, cw * 0.34);     // the top face, seen near edge-on
    const x0 = x - (c.cols * cw) / 2;
    if (x0 > SCREEN_W + 8 || x0 + c.cols * cw < -8) continue;

    for (let i = 0; i < c.cols; i++) {
      const cx0 = x0 + i * cw, cx1 = cx0 + cw;
      if (cx1 < -8 || cx0 > SCREEN_W + 8) continue;
      const top = y - c.heights[i] * cw;

      // How much of the light this column catches, across the cloud.
      const f = c.cols < 2 ? 0.5
        : Math.max(0, Math.min(1, 0.5 + 0.5 * ((i / (c.cols - 1)) * 2 - 1) * toSun));
      mix(face, faceDim, faceLit, f);
      mix(cap, capDim, capLit, f);

      rd.quad(cx0, top + lip, cx1, top + lip, cx1, y, cx0, y, face);
      rd.quad(cx0, top, cx1, top, cx1, top + lip, cx0, top + lip, cap);
    }
  }
}
