// lilies.js -- paper water lilies, set adrift on the sea.
//
// The sea had one canoe every few miles and nothing else. This puts a
// ceremony on it: dozens of folded flowers riding the same swell the water is
// drawn with, each one on its own pad, with a candle in its heart after dark
// and its light running down the surface underneath it.
//
// They were paper lanterns -- square boxes on rafts -- which is the same
// ceremony and the wrong shape for it. Everything else the bird meets is a
// folded flower now: the tulips on the ground it drinks from, and these on
// the water. A box was the odd one out, and the floating lotus is what the
// real ceremony puts on a river anyway.
//
// They are the cheapest thing in the world to draw and the most numerous, so
// the model is as small as it can be and still be a flower: a notched pad, a
// ring of six petals and a heart. Twelve triangles -- two fewer than the box
// it replaces, which had fourteen.
//
// Nothing about them can be flown into. They are on the water, the water
// already ends a flight, and a flower that could end one as well would be the
// meanest thing in the game.

import { TILE, rnd, rndSigned } from './maths.js';
import { Model, facet, shade, drawModel, silhouetteAmount } from './model.js';
import { sky } from './daylight.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { depthAt, waveLift } from './sea.js';
import { project, SCREEN_W, SCREEN_H } from './renderer.js';
import { spawn, P_FADE } from './particles.js';
import { weather } from './weather.js';

export const MAX_LILIES = 84;

// Kept inside the band the landscape is actually drawn in, so a lily spawned
// is a lily seen rather than one waiting its turn out in the dark.
const SPAWN_MIN = 4 * TILE;
const SPAWN_MAX = 23 * TILE;
const RETIRE = 32 * TILE;

// Dyed rice paper.
//
// Muted. This is a quiet game and a raft of primaries would be a fairground:
// every one of these is a colour with a good deal of paper still left in it.
// White first, because most water lilies are, and the rest are the shades a
// paper one gets dipped in.
const PAPER = [
  [238, 234, 226],   // white
  [240, 210, 218],   // blush
  [226, 162, 184],   // rose
  [244, 226, 186],   // cream
  [220, 194, 230],   // lilac
  [234, 182, 156],   // apricot
  [206, 142, 172],   // deep pink
];

// The inner ring of petals, which in a real one are smaller, paler and cupped
// round the middle. Here they are the same petals in a lighter dye: the
// camera looks down at the water, so what happens in the middle of the flower
// is most of what there is to see.
function pale(col) {
  return [
    Math.round(col[0] + (255 - col[0]) * 0.40),
    Math.round(col[1] + (255 - col[1]) * 0.40),
    Math.round(col[2] + (255 - col[2]) * 0.40),
  ];
}
const INNER = PAPER.map(pale);
const PAD   = [ 98, 140,  94];
const PAD_D = [ 72, 108,  72];
const HEART = [240, 204, 116];

// What the candle does to the paper. Not a lamp sitting on the flower: the
// petals themselves become the light, which is what a paper one does.
//
// And it comes out the colour of the paper it came through. A rose lily glows
// rose, a lilac one glows pink-gold -- which is the point of dyeing them, and
// it means the colour you picked out in daylight is still the one you are
// following after dark.
const CANDLE     = [255, 186,  86];
const CANDLE_TOP = [255, 216, 150];

function throughPaper(paper, candle, lift) {
  return [
    Math.min(255, Math.round((paper[0] * 0.40 + candle[0] * 0.60) * lift)),
    Math.min(255, Math.round((paper[1] * 0.40 + candle[1] * 0.60) * lift)),
    Math.min(255, Math.round((paper[2] * 0.40 + candle[2] * 0.60) * lift)),
  ];
}

// Reflections: a streak on the water under each one, drawn in screen space
// because that is where a reflection on a flat plane ends up anyway, and it
// costs one quad. It takes the flower's own lit colour, so a drift of them on
// the water is a row of different colours twice over.
const REFLECT_LEN = 3.0;        // multiples of the flower's height on screen

// Flying close takes one with you. The craft skims the water at a tile or
// two, so the catch is generous in both directions -- this is a thing to
// gather on the way past, not a target to line up on.
const COLLECT_R = 1.45 * TILE;      // horizontal
const COLLECT_UP = 3.2 * TILE;      // and how far above one still counts

// Once taken, the flower opens: the petals fall back off the heart over about
// a third of a second, a few of them go with the wind, and the open bloom
// stays on the water for four seconds before it fades out and the slot is
// used again.
//
// The lanterns it replaces lifted off the water and climbed away into the
// sky, which was lovely and is not a thing a lily does. What the release
// became instead is the opening: the light in the middle was shut in, and now
// it is not. The petals that leave on the wind are the part that goes up.
const OPEN_FRAMES = 200;        // four seconds, all told
const OPENING = 16;             // ... of which this much is the unfolding
const FADE_FRAMES = 50;         // ... and this much is the going

// Sized against the tulips on the ground, because they are the same
// ceremony in two places and one of them was half the other. A tulip's head
// is 0.29 tiles long and 0.31 across; this bloom is now 0.29 tall and 0.58
// across, so the two flowers are the same size in the dimension you see
// from the air -- the lily is the wider one because a lily is, and the
// paper model it came off is twice as wide as it is tall.
//
// BLOOM_R is the bloom's radius and its height at once, which is not a
// coincidence: in that model the bloom's height and its widest radius are
// both 0.35, so a petal running from the middle of the base to the rim goes
// out as far as it goes up.
const PAD_R = 0.380;            // the leaf
const BLOOM_R = 0.290;          // and the flower sitting on it
const PETALS = 6;
// --- the fold --------------------------------------------------------------
//
// One flower, built three times: shut, half open and open. The petals are the
// same six triangles every time and only their tips move -- up and in for one
// that is still closed, down and out for one that has opened -- so opening is
// a swap between three tables rather than anything computed per frame.
function buildLily(paper, inner, openness) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x, y, z);

  // The pad: a six-sided leaf lying flat on the water, with one rim point
  // pulled in to the middle for the notch every lily pad has. The polygon
  // stays star-shaped about its first vertex, so fanning it into triangles is
  // still safe. Drawn with a flat shade rather than through facet(), because
  // it lies in the water plane through the model's own origin and facet()
  // decides which way a face points by where it sits relative to that origin.
  const rim = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const r = i === 3 ? PAD_R * 0.30 : PAD_R * (0.88 + ((i * 7) % 5) * 0.06);
    rim.push(v(Math.cos(a) * r, -0.004, Math.sin(a) * r));
  }
  m.face(rim, shade(PAD, 1.0));

  // Six petals, each one triangle, sharing a ring of bases around the heart.
  // Alternating dye, so the fold reads even when the light does not.
  const padY = -0.012;
  // The ring the petals stand on is nearly as wide as the rim they reach,
  // which is what the model measured too -- its cross-section runs 0.30 at
  // the base to 0.355 at the widest, so the bloom is a cup rather than a
  // cone. Narrow the base and the six petals stop touching and read as a
  // starburst of spikes instead of as a flower.
  const rb = BLOOM_R * 0.80;
  const base = [];
  for (let i = 0; i < PETALS; i++) {
    const a = (i / PETALS) * Math.PI * 2;
    base.push(v(Math.cos(a) * rb, padY, Math.sin(a) * rb));
  }
  // Alternating petals: the even ones are the outer round of a real lily --
  // long, and laid almost flat on the water once it is open -- and the odd
  // ones are the inner round, shorter and still standing up round the middle.
  // Shut, both rounds close into the same cup. It is the same six triangles
  // either way, and it is the difference between a flower and a star.
  //
  // Both rounds come off a measurement of a folded paper lily rather than a
  // guess: its bloom is 0.71 across and 0.35 tall, twice as wide as high,
  // and its cross-section widens all the way up, so the petals splay as they
  // rise rather than closing over.
  for (let i = 0; i < PETALS; i++) {
    const j = (i + 1) % PETALS;
    const a = ((i + 0.5) / PETALS) * Math.PI * 2;
    const outer = (i & 1) === 0;
    const tipR = BLOOM_R * (outer ? 1.00 + 0.50 * openness : 0.90 - 0.20 * openness);
    const tipY = padY - BLOOM_R * (outer ? 1.00 - 0.92 * openness : 1.00 - 0.25 * openness);
    const tip = v(Math.cos(a) * tipR, tipY, Math.sin(a) * tipR);
    facet(m, [base[i], base[j], tip], outer ? paper : inner);
  }

  // The heart, and the last face in the model -- which is what the lit
  // variant below looks for when it decides where the flame is.
  const hr = BLOOM_R * 0.30, hy = padY - BLOOM_R * 0.16;
  m.face([v(-hr, hy, -hr), v(hr, hy, -hr), v(hr, hy, hr), v(-hr, hy, hr)], HEART);
  return m;
}

// Shut, half open, open -- indexed by how far through opening a flower is.
const SHUT = 0, HALF = 1, OPEN = 2;
const LILIES = [0, 0.5, 1].map((openness) =>
  PAPER.map((body, i) => buildLily(body, INNER[i], openness)));

// ... and what shows through after dark is the paper's colour carrying the
// flame's.
const LIT_COLOUR = PAPER.map((body) => throughPaper(body, CANDLE, 1.0));

// Lit variants: everything above the pad becomes the candle. Built once,
// sharing the vertices, and marked emissive so the time of day does not put
// its tint through a light.
const LILIES_LIT = LILIES.map((set) => set.map((model, k) => {
  const out = new Model();
  out.verts = model.verts;
  out.height = model.height;
  out.radius = model.radius;
  const last = model.faces.length - 1;
  out.faces = model.faces.map((f, i) => {
    if (i === 0) return f;                       // the pad stays leaf
    const col = i === last ? throughPaper(INNER[k], CANDLE_TOP, 1.0) : LIT_COLOUR[k];
    return { idx: f.idx, col, glow: true };
  });
  return out;
}));

// --- state -----------------------------------------------------------------

const lilies = [];
for (let i = 0; i < MAX_LILIES; i++) {
  lilies.push({ live: false, x: 0, z: 0, style: 0, drift: 0, taken: 0 });
}

export function resetLilies() {
  for (const l of lilies) l.live = false;
}

export function lilyCount() {
  return lilies.reduce((n, l) => n + (l.live ? 1 : 0), 0);
}

// Open water. One sample rather than the boats' five: a lily is a foot across
// and does not care whether it can turn round.
function afloat(x, z) {
  return landAltitude(x, z) >= SEA_LEVEL;
}

// They are set adrift by people standing together, so they arrive in drifts
// rather than evenly spread: most of them are put down beside one that is
// already floating, and only the rest strike out on their own.
const CLUSTER = 0.65;
const CLUSTER_SPREAD = 2.2 * TILE;

function place(l, px, pz) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let x, z;
    const near = rnd() < CLUSTER ? lilies[(Math.random() * lilies.length) | 0] : null;
    if (near && near.live) {
      x = (near.x + rndSigned() * CLUSTER_SPREAD) | 0;
      z = (near.z + rndSigned() * CLUSTER_SPREAD) | 0;
    } else {
      const a = rnd() * Math.PI * 2;
      const r = SPAWN_MIN + rnd() * (SPAWN_MAX - SPAWN_MIN);
      x = (px + Math.cos(a) * r) | 0;
      z = (pz + Math.sin(a) * r) | 0;
    }
    if (!afloat(x, z)) continue;
    // A clustered one still has to be somewhere worth drawing.
    const away = Math.hypot((x - px) / TILE, (z - pz) / TILE) * TILE;
    if (away > RETIRE) continue;
    l.x = x; l.z = z;
    l.style = (Math.random() * PAPER.length) | 0;
    l.drift = 0.3 + rnd() * 0.7;
    l.taken = 0;
    l.live = true;
    return;
  }
}

export function updateLilies(player, game) {
  for (const l of lilies) {
    if (!l.live) {
      // They arrive steadily rather than all at once, so a sea fills up as
      // you fly over it instead of appearing in one go.
      if (Math.random() < 0.10) place(l, player.x, player.z);
      continue;
    }

    // One that has been opened is nobody's business any more: it still goes
    // where the water takes it, but it cannot be taken twice and it gives up
    // its slot when it has finished fading.
    if (l.taken) {
      l.taken--;
      l.x = (l.x + weather.windX * l.drift) | 0;
      l.z = (l.z + weather.windZ * l.drift) | 0;
      if (!l.taken) l.live = false;
      continue;
    }

    l.x = (l.x + weather.windX * l.drift) | 0;
    l.z = (l.z + weather.windZ * l.drift) | 0;

    if (!afloat(l.x, l.z)) { l.live = false; continue; }

    const dx = (l.x - player.x) / TILE, dz = (l.z - player.z) / TILE;
    const away = Math.hypot(dx, dz) * TILE;
    if (away > RETIRE) { l.live = false; continue; }

    // Close enough to gather. Height is measured from the water rather than
    // from the craft's own altitude reading, which is height above whatever
    // is under it and would be wrong over a shoal.
    if (!player.dead && away < COLLECT_R && (SEA_LEVEL - player.y) < COLLECT_UP) {
      l.taken = OPEN_FRAMES;
      if (game) game.onLilyTaken(l.x, SEA_LEVEL, l.z);
      // Petals off the wind, and after dark a little of the candle with them.
      const paper = PAPER[l.style];
      const warm = sky.lamp > 0.05 ? LIT_COLOUR[l.style] : paper;
      for (let i = 0; i < 7; i++) {
        spawn(l.x, (SEA_LEVEL - TILE * 0.1) | 0, l.z,
              ((Math.random() - 0.5) * TILE * 0.02) | 0,
              (-TILE * (0.008 + Math.random() * 0.018)) | 0,
              ((Math.random() - 0.5) * TILE * 0.02) | 0,
              warm, 30 + ((Math.random() * 24) | 0), P_FADE, 1);
      }
    }
  }
}

export function liliesInRow(zLo, zHi, out) {
  for (const l of lilies) {
    if (!l.live) continue;
    if (l.z >= zLo && l.z < zHi) out.push(l);
  }
  return out;
}

const pt = { x: 0, y: 0 };
const reflectCol = [0, 0, 0, 0];

export function drawLily(rd, l, camX, camY, camZ, fog = 0) {
  const heave = waveLift(l.x, l.z, depthAt(l.x, l.z));
  const y = (SEA_LEVEL + heave) | 0;
  const sil = silhouetteAmount((l.x - camX) / TILE, (l.z - camZ) / TILE);

  // How lit they are is the game's own measure of how dark it is, so they
  // come on with the boats' lantern and the balloons' burner rather than at
  // a threshold of their own.
  const glow = sky.lamp;

  // Shut until it is taken, then one frame of half open on the way out.
  const since = l.taken ? OPEN_FRAMES - l.taken : 0;
  const stage = !l.taken ? SHUT : since < OPENING ? HALF : OPEN;
  // ... and it goes by fading rather than by vanishing between two frames.
  const fade = l.taken && l.taken < FADE_FRAMES ? l.taken / FADE_FRAMES : 1;

  // The reflection, first, so the flower sits on top of its own light.
  if (glow > 0.05 && sil < 0.95) {
    if (project((l.x - camX) | 0, (y - camY) | 0, (l.z - camZ) | 0, pt) &&
        pt.x > -20 && pt.x < SCREEN_W + 20 && pt.y > -20 && pt.y < SCREEN_H + 20) {
      // Scale with the flower: work out how tall it is on screen, and lay a
      // streak that many times longer down the water.
      const top = { x: pt.x, y: pt.y };
      if (project((l.x - camX) | 0, (y - BLOOM_R * TILE - camY) | 0, (l.z - camZ) | 0, pt)) {
        const h = Math.max(1, top.y - pt.y);
        const w = Math.max(0.8, h * 0.55);
        const len = h * REFLECT_LEN;
        const a = Math.round(124 * glow * (1 - sil) * fade);
        const glowCol = LIT_COLOUR[l.style];
        reflectCol[0] = glowCol[0]; reflectCol[1] = glowCol[1]; reflectCol[2] = glowCol[2];
        reflectCol[3] = a;
        const fadeOut = [glowCol[0], glowCol[1], glowCol[2], 0];
        rd.quadShaded(
          top.x - w, top.y, reflectCol,
          top.x + w, top.y, reflectCol,
          top.x + w * 0.25, top.y + len, fadeOut,
          top.x - w * 0.25, top.y + len, fadeOut);
      }
    }
  }

  const set = glow > 0.05 ? LILIES_LIT[stage] : LILIES[stage];
  drawModel(rd, set[l.style], null, l.x, y, l.z, camX, camY, camZ, fog, sil, fade);
}
