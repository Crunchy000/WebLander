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
// The model is a notched pad, three rounds of petals and a heart: 38
// triangles, counted through the renderer rather than added up by hand, and a
// bare leaf is 6. They started at twelve, which was two fewer than the paper
// box they replaced and about as much flower as twelve triangles can be. The
// rounds cost the difference and are worth it -- measured over open water,
// the frame's drawing went from 1.60 / 1.71 / 1.60 ms to 1.96 / 2.01 / 2.06.
// Nearly all of that is the petals: the same measurement with the leaves
// taken out again reads 2.00 and 2.14, so the fifty-odd extra leaf models are
// close to free and the thirty petal triangles are not. If a slower machine
// ever needs the milliseconds back, the ROUNDS table is where they are.
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

// Flowers and leaves together. It was 84, all of them flowers; the leaves
// are new and the flower count had to stay where it was, because the flowers
// are what the bird gathers and thinning them would be a rule change dressed
// up as a paint job. 140 slots at 45 in a hundred leaves leaves about 77
// flowers, which is where it was.
export const MAX_LILIES = 140;
const LEAF_IN = 45;                 // ... of every hundred, a leaf on its own

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
  [126, 158, 226],   // and a blue one, which a water lily is allowed to be
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
// --- the fold --------------------------------------------------------------
//
// One flower, built three times: shut, half open and open. The petals are the
// same six triangles every time and only their tips move -- up and in for one
// that is still closed, down and out for one that has opened -- so opening is
// a swap between three tables rather than anything computed per frame.
// The pad: an eight-sided leaf lying flat on the water, with one rim point
// pulled in to the middle for the wedge notch every lily pad has. The polygon stays
// star-shaped about its first vertex, so fanning it into triangles is still
// safe. Drawn with a flat shade rather than through facet(), because it lies
// in the water plane through the model's own origin and facet() decides which
// way a face points by where it sits relative to that origin.
function pad(m, v, scale = 1) {
  const rim = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    const r = (i === 4 ? PAD_R * 0.26 : PAD_R * (0.90 + ((i * 7) % 5) * 0.05)) * scale;
    rim.push(v(Math.cos(a) * r, -0.004, Math.sin(a) * r));
  }
  m.face(rim, shade(PAD, 1.0));
}

// A leaf with nothing on it, which is most of a lily bed. Six triangles --
// a quarter of a flower -- and the thing that turns a scatter of blooms into
// water with lilies growing in it.
function buildPad(yaw, scale) {
  const m = new Model();
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const v = (x, y, z) => m.vert(x * cs - z * sn, y, x * sn + z * cs);
  pad(m, v, scale);
  return m;
}

function buildLily(paper, inner, openness, yaw) {
  const m = new Model();
  // Turned on the spot, at build time. Every one of these used to face
  // exactly the same way, which is invisible in one flower and unmistakable
  // in a drift of eighty: the notch in every pad pointed the same way. Baking
  // the turn into the table costs nothing per frame -- the alternative is a
  // matrix multiply for every vertex of every lily, every frame.
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const v = (x, y, z) => m.vert(x * cs - z * sn, y, x * sn + z * cs);

  pad(m, v);

  // Three rounds of petals, not one, and each petal a diamond rather than a
  // spike.
  //
  // It was one ring of six triangles, alternating long and short, which is a
  // crown and not a flower. A lily has round after round of petals, each
  // shorter and steeper than the one outside it, and each petal is a pointed
  // oval wide enough to overlap its neighbours. One triangle cannot be both
  // long and wide -- it tapers from its base to its tip, so a long one is a
  // spike and a field of them is a thistle. Two triangles make a diamond:
  // root, a shoulder each side at two fifths of the way out, and the tip.
  //
  // Six outer petals lying almost flat on the water, five above them at half
  // the angle, four standing nearly upright round the middle: thirty
  // triangles for the bloom against six, and the only thing in this game
  // that is worth that is the thing the whole sea is made of.
  //
  // Each round is offset half a step from the one below, so petals sit in
  // the gaps rather than stacking in line, and the shoulders are set a
  // twentieth wider than the gap between petals so the rounds close up
  // instead of showing water between them.
  //
  // The colour steps in with the rounds: the outer is the paper darkened,
  // the middle is the paper, the inner is the paper paled. Flat tone on
  // thirty triangles would be a blob; graded, the rounds separate at ten
  // pixels across.
  const padY = -0.012;
  const ROUNDS = [
    // petals, root radius, tip radius shut -> open, tip height shut -> open
    { n: 6, r0: 0.30, r1: 0.85, r2: 1.45, y1: 1.00, y2: 0.12, col: shade(paper, 0.78) },
    { n: 5, r0: 0.24, r1: 0.66, r2: 1.02, y1: 1.06, y2: 0.52, col: paper },
    { n: 4, r0: 0.18, r1: 0.46, r2: 0.62, y1: 1.10, y2: 0.88, col: inner },
  ];
  for (let k = 0; k < ROUNDS.length; k++) {
    const R = ROUNDS[k];
    const twist = ((k * 0.5) / R.n) * Math.PI * 2;
    const rootY = padY - BLOOM_R * 0.05 * k;
    const tipR = BLOOM_R * (R.r1 + (R.r2 - R.r1) * openness);
    const tipY = padY - BLOOM_R * (R.y1 + (R.y2 - R.y1) * openness);
    const half = (Math.PI / R.n) * 1.05;
    for (let i = 0; i < R.n; i++) {
      const a = (i / R.n) * Math.PI * 2 + twist;
      const sr = BLOOM_R * R.r0 + (tipR - BLOOM_R * R.r0) * 0.42;
      const sy = rootY + (tipY - rootY) * 0.42;
      const root = v(Math.cos(a) * BLOOM_R * R.r0, rootY, Math.sin(a) * BLOOM_R * R.r0);
      const left = v(Math.cos(a - half) * sr, sy, Math.sin(a - half) * sr);
      const right = v(Math.cos(a + half) * sr, sy, Math.sin(a + half) * sr);
      const tip = v(Math.cos(a) * tipR, tipY, Math.sin(a) * tipR);
      facet(m, [root, left, tip], R.col);
      facet(m, [root, tip, right], R.col);
    }
  }

  // The heart, and the last face in the model -- which is what the lit
  // variant below looks for when it decides where the flame is.
  const hr = BLOOM_R * 0.30, hy = padY - BLOOM_R * 0.16;
  m.face([v(-hr, hy, -hr), v(hr, hy, -hr), v(hr, hy, hr), v(-hr, hy, hr)], HEART);
  return m;
}

// Four turns, at angles that are not a quarter of anything: a six-petal
// bloom repeats every sixty degrees, so what actually varies between these is
// where the pad's notch points.
const YAWS = [0, 1.1, 2.6, 4.2];
const PADS = YAWS.map((yaw, i) => buildPad(yaw, 0.86 + i * 0.10));

// Shut, half open, open -- indexed by how far through opening a flower is,
// then by paper colour, then by turn.
const SHUT = 0, HALF = 1, OPEN = 2;
const LILIES = [0, 0.5, 1].map((openness) =>
  PAPER.map((body, i) => YAWS.map((yaw) => buildLily(body, INNER[i], openness, yaw))));

// ... and what shows through after dark is the paper's colour carrying the
// flame's.
const LIT_COLOUR = PAPER.map((body) => throughPaper(body, CANDLE, 1.0));

// Lit variants: everything above the pad becomes the candle. Built once,
// sharing the vertices, and marked emissive so the time of day does not put
// its tint through a light.
const LILIES_LIT = LILIES.map((set) => set.map((turns, k) => turns.map((model) => {
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
})));

// --- state -----------------------------------------------------------------

const lilies = [];
for (let i = 0; i < MAX_LILIES; i++) {
  lilies.push({ live: false, leaf: false, x: 0, z: 0, style: 0, turn: 0, drift: 0, taken: 0 });
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

// They arrive in beds rather than evenly spread: most are put down beside one
// that is already floating, and only the rest strike out on their own.
//
// The spread was 2.2 tiles, which is wide enough that a "cluster" of eight
// covers most of a screen and reads as a scatter. Half that, and more of them
// clustered, makes a raft you fly the length of.
const CLUSTER = 0.78;
const CLUSTER_SPREAD = 1.1 * TILE;

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
    l.leaf = ((Math.random() * 100) | 0) < LEAF_IN;
    l.style = (Math.random() * PAPER.length) | 0;
    l.turn = (Math.random() * YAWS.length) | 0;
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

    // Close enough to gather -- and a leaf is not a flower, so there is
    // nothing on it to gather.
    if (!l.leaf && !player.dead && away < COLLECT_R &&
        (SEA_LEVEL - player.y) < COLLECT_UP) {
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

  // A leaf on its own: no bloom to open, nothing lit in it after dark, and
  // no reflection, because the light is what was reflecting.
  if (l.leaf) {
    drawModel(rd, PADS[l.turn], null, l.x, y, l.z, camX, camY, camZ, fog, sil);
    return;
  }

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
  drawModel(rd, set[l.style][l.turn], null, l.x, y, l.z, camX, camY, camZ, fog, sil, fade);
}
