// lanterns.js -- paper lanterns set adrift on the water.
//
// The sea had one canoe every few miles and nothing else. This puts a
// ceremony on it: dozens of small paper boxes on floats, riding the same
// swell the water is drawn with, lit from inside after dark and reflecting
// down the surface underneath them.
//
// They are the cheapest thing in the world to draw and the most numerous, so
// the model is as small as it can be and still be a lantern: four paper
// sides, a lid, and the raft it sits on. Six faces. Fifty of them cost less
// than one of the toy castles.
//
// Nothing about them can be flown into. They are on the water, the water
// already ends a flight, and a lantern that could end one as well would be
// the meanest thing in the game.

import { TILE, rnd, rndSigned } from './maths.js';
import { Model, facet, shade, drawModel, recolour, silhouetteAmount } from './model.js';
import { sky } from './daylight.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { depthAt, waveLift } from './sea.js';
import { project, SCREEN_W, SCREEN_H } from './renderer.js';
import { spawn, P_FADE } from './particles.js';

// Thinned from 84. A drift of eighty-four covers the water in front of you
// and the eye stops reading them as a ceremony and starts reading them as
// wallpaper; at fifty-six there is water between them and a run is something
// you fly rather than something you fall into. It is also the cheapest
// frame-time there is to buy, since every one of them is a model drawn.
export const MAX_LANTERNS = 56;

const S = 1.0;
// Kept inside the band the landscape is actually drawn in, so a lantern
// spawned is a lantern seen rather than one waiting its turn out in the dark.
const SPAWN_MIN = 4 * TILE;
const SPAWN_MAX = 23 * TILE;
const RETIRE = 32 * TILE;

// Dyed rice paper.
//
// They were three shades of cream to begin with, which is what a paper
// lantern is after dark -- the candle is doing all the work and the paper is
// only carrying it. In daylight it left a drift of fifty identical pale
// smudges on the water, with nothing to look at until dusk. Real ones are
// dyed, so these are: a coral, a rose, a saffron, a washed jade and blue, a
// lilac, and the undyed cream they started as.
//
// Muted, though. This is a quiet game and a raft of primaries would be a
// fairground. Every one of these is a colour with a good deal of paper still
// left in it.
//
// Each has a paler collar -- the lid and the top of the box, where the paper
// is folded double over the frame and no dye reaches. That is where most of
// the eye interest is, because the camera looks down: on the water it is
// mostly lids you can see.
const PAPER = [
  [236, 226, 204],   // undyed
  [226, 150, 116],   // coral
  [212, 132, 142],   // rose
  [230, 180,  98],   // saffron
  [156, 188, 170],   // jade
  [152, 176, 206],   // washed blue
  [192, 158, 194],   // lilac
];

// The collar: the lid and the fold of paper over the top of the frame, where
// the dye runs thin. A lighter version of the body rather than a white one --
// the camera looks down at the water, so a lid that loses the colour is a
// lantern that loses it.
function collar(col) {
  return [
    Math.round(col[0] + (255 - col[0]) * 0.34),
    Math.round(col[1] + (255 - col[1]) * 0.34),
    Math.round(col[2] + (255 - col[2]) * 0.34),
  ];
}
const COLLAR = PAPER.map(collar);
const RAFT   = [118,  96,  72];
const RAFT_D = [ 92,  74,  56];

// What the candle does to the paper. Not a lamp hung on the outside: the
// whole box becomes the light, which is what a paper lantern is.
//
// And it comes out the colour of the paper it came through. A rose lantern
// glows rose, a jade one glows green-gold -- which is the point of dyeing
// them, and it means the colour you picked out in daylight is still the one
// you are following after dark.
const CANDLE     = [255, 186,  86];
const CANDLE_TOP = [255, 212, 140];

function throughPaper(paper, candle, lift) {
  return [
    Math.min(255, Math.round((paper[0] * 0.40 + candle[0] * 0.60) * lift)),
    Math.min(255, Math.round((paper[1] * 0.40 + candle[1] * 0.60) * lift)),
    Math.min(255, Math.round((paper[2] * 0.40 + candle[2] * 0.60) * lift)),
  ];
}

// Reflections: a streak on the water under each one, drawn in screen space
// because that is where a reflection on a flat plane ends up anyway, and it
// costs one quad. It takes the lantern's own lit colour, so a row of them on
// the water is a row of different colours twice over.
const REFLECT_LEN = 3.0;        // multiples of the lantern's height on screen

// A lantern is a small thing: a foot or so across, against a tree a tile
// and a half tall. The first pass had them a third of a tree wide, which read
// as crates rather than as paper.
// Flying close takes one with you. The craft skims the water at a tile or
// two, so the catch is generous in both directions -- this is a thing to
// gather on the way past, not a target to line up on.
const COLLECT_R = 1.45 * TILE;      // horizontal
const COLLECT_UP = 3.2 * TILE;      // and how far above one still counts

// Once taken, a floating lantern becomes a sky lantern: it lifts away over
// three and a half seconds, gathering speed as it goes, and is gone by the
// time it is six tiles up. Nothing else in this game goes up on its own,
// which is what makes it read as a release rather than as a pickup.
const RISE_FRAMES = 180;
const RISE_SPEED = TILE * 0.008;
const RISE_GATHER = 0.022;      // how much it quickens each frame

const BOX = 0.105;              // half width
const TALL = 0.155;

function buildLantern(body, lid) {
  const m = new Model();
  const v = (x, y, z) => m.vert(x * S, y * S, z * S);
  const raft = 0.055;

  // The float: a flat square, just proud of the water.
  const r = BOX * 1.5;
  facet(m, [v(-r, -raft, -r), v(r, -raft, -r), v(r, -raft, r), v(-r, -raft, r)],
        shade(RAFT, 1.06));
  facet(m, [v(-r, 0, -r), v(r, 0, -r), v(r, 0, r), v(-r, 0, r)], RAFT_D);

  // The box: four sides and a lid. No bottom -- it is sitting on the raft,
  // and nothing is ever going to see under it.
  const t = -raft - TALL;
  const q = [
    v(-BOX, -raft, -BOX), v(BOX, -raft, -BOX), v(BOX, -raft, BOX), v(-BOX, -raft, BOX),
    v(-BOX, t, -BOX), v(BOX, t, -BOX), v(BOX, t, BOX), v(-BOX, t, BOX),
  ];
  // Four sides, two of them turned away from the light. The contrast used to
  // be a tenth, which at ten pixels across reads as one flat chip of colour;
  // a quarter is what makes it a box in daylight.
  facet(m, [q[0], q[1], q[5], q[4]], shade(body, 1.04));
  facet(m, [q[1], q[2], q[6], q[5]], shade(body, 0.78));
  facet(m, [q[2], q[3], q[7], q[6]], shade(body, 1.04));
  facet(m, [q[3], q[0], q[4], q[7]], shade(body, 0.78));
  facet(m, [q[4], q[5], q[6], q[7]], shade(lid, 1.10));
  return m;
}

const LANTERNS = PAPER.map((body, i) => buildLantern(body, COLLAR[i]));

// Lit variants: everything above the raft becomes the candle. Built once,
// sharing the vertices, and marked emissive so the time of day does not put
// its tint through a light.
const LANTERNS_LIT = LANTERNS.map((model) => recolour(model, (col, i) => null, true));
// ... and what shows through is the paper's colour carrying the flame's.
const LIT_COLOUR = PAPER.map((body) => throughPaper(body, CANDLE, 1.0));
for (let k = 0; k < LANTERNS.length; k++) {
  const src = LANTERNS[k];
  const out = LANTERNS_LIT[k];
  const side = LIT_COLOUR[k];
  const top = throughPaper(COLLAR[k], CANDLE_TOP, 1.0);
  out.faces = src.faces.map((f, i) => {
    if (i < 2) return f;                       // the raft stays wood
    const col = i === src.faces.length - 1 ? top : side;
    return { idx: f.idx, col, glow: true };
  });
}

// --- state -----------------------------------------------------------------

const lanterns = [];
for (let i = 0; i < MAX_LANTERNS; i++) {
  lanterns.push({ live: false, x: 0, z: 0, style: 0, phase: 0, spin: 0,
                  taken: 0, lift: 0 });
}

export function resetLanterns() {
  for (const l of lanterns) l.live = false;
}

export function lanternCount() {
  return lanterns.reduce((n, l) => n + (l.live ? 1 : 0), 0);
}

// Open water. One sample rather than the boats' five: a lantern is a foot
// across and does not care whether it can turn round.
function afloat(x, z) {
  return landAltitude(x, z) >= SEA_LEVEL;
}

// Lanterns are set adrift by people standing together, so they arrive in
// drifts rather than evenly spread: most of them are put down beside one that
// is already floating, and only the rest strike out on their own.
const CLUSTER = 0.65;
const CLUSTER_SPREAD = 2.2 * TILE;

function place(l, px, pz) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let x, z;
    const near = rnd() < CLUSTER ? lanterns[(Math.random() * lanterns.length) | 0] : null;
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
    l.phase = rnd() * Math.PI * 2;
    l.spin = rndSigned() * 0.004;
    l.taken = 0;
    l.lift = 0;
    l.live = true;
    return;
  }
}

export function updateLanterns(player, game) {
  for (const l of lanterns) {
    if (!l.live) {
      // They arrive steadily rather than all at once, so a sea fills up as
      // you fly over it instead of appearing in one go.
      if (Math.random() < 0.10) place(l, player.x, player.z);
      continue;
    }

    // One that has been taken is on its way up and is nobody's business any
    // more: it does not drift, cannot be taken twice, and lets go at the top.
    if (l.taken) {
      l.taken--;
      l.lift += RISE_SPEED * (1 + (RISE_FRAMES - l.taken) * RISE_GATHER);
      if (!l.taken) l.live = false;
      continue;
    }

    l.phase += 0.02;

    if (!afloat(l.x, l.z)) { l.live = false; continue; }

    const dx = (l.x - player.x) / TILE, dz = (l.z - player.z) / TILE;
    const away = Math.hypot(dx, dz) * TILE;
    if (away > RETIRE) { l.live = false; continue; }

    // Close enough to gather. Height is measured from the water rather than
    // from the craft's own altitude reading, which is height above whatever
    // is under it and would be wrong over a shoal.
    if (!player.dead && away < COLLECT_R && (SEA_LEVEL - player.y) < COLLECT_UP) {
      l.taken = RISE_FRAMES;
      l.lift = 0;
      if (game) game.onLanternTaken(l.x, SEA_LEVEL, l.z);
      const warm = [255, 206, 130];
      for (let i = 0; i < 7; i++) {
        spawn(l.x, (SEA_LEVEL - TILE * 0.2) | 0, l.z,
              ((Math.random() - 0.5) * TILE * 0.02) | 0,
              (-TILE * (0.01 + Math.random() * 0.02)) | 0,
              ((Math.random() - 0.5) * TILE * 0.02) | 0,
              warm, 30 + ((Math.random() * 24) | 0), P_FADE, 1);
      }
    }
  }
}

export function lanternsInRow(zLo, zHi, out) {
  for (const l of lanterns) {
    if (!l.live) continue;
    if (l.z >= zLo && l.z < zHi) out.push(l);
  }
  return out;
}

const pt = { x: 0, y: 0 };
const reflectCol = [0, 0, 0, 0];

export function drawLantern(rd, l, camX, camY, camZ, fog = 0) {
  const heave = waveLift(l.x, l.z, depthAt(l.x, l.z));
  const y = (SEA_LEVEL + heave - l.lift) | 0;
  const sil = silhouetteAmount((l.x - camX) / TILE, (l.z - camZ) / TILE);

  // How lit they are is the game's own measure of how dark it is, so they
  // come on with the boats' lantern and the balloons' burner rather than at
  // a threshold of their own.
  const glow = sky.lamp;

  // The reflection, first, so the lantern sits on top of its own light.
  if (glow > 0.05 && sil < 0.95 && !l.taken) {
    if (project((l.x - camX) | 0, (y - camY) | 0, (l.z - camZ) | 0, pt) &&
        pt.x > -20 && pt.x < SCREEN_W + 20 && pt.y > -20 && pt.y < SCREEN_H + 20) {
      // Scale with the lantern: work out how tall it is on screen, and lay a
      // streak that many times longer down the water.
      const top = { x: pt.x, y: pt.y };
      if (project((l.x - camX) | 0, (y - TALL * S * TILE - camY) | 0, (l.z - camZ) | 0, pt)) {
        const h = Math.max(1, top.y - pt.y);
        const w = Math.max(0.8, h * 0.55);
        const len = h * REFLECT_LEN;
        const a = Math.round(124 * glow * (1 - sil));
        const glowCol = LIT_COLOUR[l.style];
        reflectCol[0] = glowCol[0]; reflectCol[1] = glowCol[1]; reflectCol[2] = glowCol[2];
        reflectCol[3] = a;
        const fade = [glowCol[0], glowCol[1], glowCol[2], 0];
        rd.quadShaded(
          top.x - w, top.y, reflectCol,
          top.x + w, top.y, reflectCol,
          top.x + w * 0.25, top.y + len, fade,
          top.x - w * 0.25, top.y + len, fade);
      }
    }
  }

  const model = glow > 0.05 ? LANTERNS_LIT[l.style] : LANTERNS[l.style];
  drawModel(rd, model, null, l.x, y, l.z, camX, camY, camZ, fog, sil);
}
