// model.js -- flat-shaded polygon models.
//
// Models are built from a handful of primitives rather than written out as
// vertex tables, which keeps them legible and easy to tweak. Each model is a
// list of faces; a face is a set of vertex indices plus a flat colour.
//
// Remember that +y points DOWN, so the top of a model has a negative y.

import { TILE, matApply } from './maths.js';
import { landAltitude, SEA_LEVEL } from './landscape.js';
import { sky, litColour, emissive, skyColourAt, silhouetteDark } from './daylight.js';
import { project, projScale } from './renderer.js';

// --- model construction ----------------------------------------------------

export class Model {
  constructor() {
    this.verts = [];   // flat [x,y,z, x,y,z, ...] in fixed point
    this.faces = [];   // { idx: [...], col: [r,g,b] }
    this.height = 0;   // how far it stands above its base, fixed point
    this.radius = 0;   // rough horizontal extent, for collisions
  }

  vert(x, y, z) {
    const i = this.verts.length / 3;
    this.verts.push((x * TILE) | 0, (y * TILE) | 0, (z * TILE) | 0);
    if (-y * TILE > this.height) this.height = (-y * TILE) | 0;
    const r = Math.max(Math.abs(x), Math.abs(z)) * TILE;
    if (r > this.radius) this.radius = r | 0;
    return i;
  }

  face(idx, col) {
    this.faces.push({ idx, col });
    return this;
  }

  // A box standing on the ground, centred on the origin in x and z.
  box(w, hBottom, hTop, d, colTop, colSide) {
    const x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
    const t = -hTop, b = -hBottom;
    const v = [
      this.vert(x0, t, z0), this.vert(x1, t, z0),
      this.vert(x1, t, z1), this.vert(x0, t, z1),
      this.vert(x0, b, z0), this.vert(x1, b, z0),
      this.vert(x1, b, z1), this.vert(x0, b, z1),
    ];
    this.face([v[0], v[1], v[2], v[3]], colTop);              // top
    this.face([v[0], v[4], v[5], v[1]], shade(colSide, 1.0)); // front (-z)
    this.face([v[1], v[5], v[6], v[2]], shade(colSide, 0.78)); // right
    this.face([v[3], v[2], v[6], v[7]], shade(colSide, 0.6));  // back
    this.face([v[0], v[3], v[7], v[4]], shade(colSide, 0.88)); // left
    return this;
  }

  // A cone: `sides`-sided pyramid from a ring at hBottom up to a point.
  cone(radius, hBottom, hTop, sides, col) {
    const apex = this.vert(0, -hTop, 0);
    const ring = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      ring.push(this.vert(Math.cos(a) * radius, -hBottom, Math.sin(a) * radius));
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      // Light from above and to the left: faces pointing left are brighter.
      const a = ((i + 0.5) / sides) * Math.PI * 2;
      this.face([apex, ring[i], ring[j]], shade(col, 0.62 + 0.38 * (0.5 - 0.5 * Math.cos(a - 0.9))));
    }
    return this;
  }

  // A geodesic lump: rings of vertices stacked up the height, capped on top,
  // with every vertex pushed in or out a little by a hash of its own position.
  //
  // A cone made a poor boulder. A boulder is not pointed, and what reads as
  // rock is a lot of flat faces at a lot of angles catching the light
  // differently -- exactly what this renderer is good at and what a five-sided
  // cone cannot give you. The jitter is what stops it reading as a ball: it is
  // deterministic, so a rock does not shimmer as you fly past it, and `seed`
  // lets two rocks in the same clump be different rocks.
  //
  // There is no bottom cap and no bottom point. It sits on the ground on a
  // wide base, because the ground is drawn before the things standing on it
  // and anything reaching below it would be drawn straight over the top.
  geode(radius, hBottom, hTop, sides, bands, col, seed = 0) {
    // A cheap integer hash, so the lumps are stable and need no rng.
    const jog = (i, j) => {
      let h = (i * 374761393 + j * 668265263 + seed * 2246822519) | 0;
      h = (h ^ (h >>> 13)) * 1274126177;
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };

    // Latitude runs from just short of the top of a sphere to well short of
    // the bottom of one: flattish on top, widest in the middle, broad where
    // it meets the ground.
    const PHI0 = 0.42, PHI1 = 2.34;
    const rows = [];
    for (let j = 0; j <= bands; j++) {
      const t = j / bands;
      const phi = PHI0 + (PHI1 - PHI0) * t;
      const rr = Math.sin(phi) * radius;
      const y = -hTop + (hTop - hBottom) * t;
      const row = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const k = 0.82 + jog(i, j) * 0.36;
        const lift = j === 0 || j === bands ? 0 : (jog(i + 31, j) - 0.5) * 0.10;
        row.push(this.vert(Math.cos(a) * rr * k, y + lift * (hTop - hBottom),
                           Math.sin(a) * rr * k));
      }
      rows.push(row);
    }

    // Light from above and to the left, as everything else here is, plus a
    // term for how far the face is tipped towards the sky.
    const lit = (a, up) => shade(col,
      0.52 + 0.26 * (0.5 - 0.5 * Math.cos(a - 0.9)) + 0.26 * up);

    for (let j = 0; j < bands; j++) {
      const top = rows[j], bot = rows[j + 1];
      const up = Math.max(0, 1 - (j + 0.5) / bands * 1.7);
      for (let i = 0; i < sides; i++) {
        const n = (i + 1) % sides;
        const a = ((i + 0.5) / sides) * Math.PI * 2;
        this.face([top[i], bot[i], bot[n], top[n]], lit(a, up));
      }
    }
    this.face(rows[0].slice(), shade(col, 1.06));
    return this;
  }

  // A drum: a prism used for tree foliage and rocket bodies.
  drum(rTop, rBottom, hBottom, hTop, sides, col, capCol) {
    const top = [], bot = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      top.push(this.vert(Math.cos(a) * rTop, -hTop, Math.sin(a) * rTop));
      bot.push(this.vert(Math.cos(a) * rBottom, -hBottom, Math.sin(a) * rBottom));
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const a = ((i + 0.5) / sides) * Math.PI * 2;
      this.face([top[i], bot[i], bot[j], top[j]], shade(col, 0.62 + 0.38 * (0.5 - 0.5 * Math.cos(a - 0.9))));
    }
    if (capCol) this.face(top.slice(), capCol);
    return this;
  }

  // Resize the whole model about its own origin. Lets a family of models --
  // the trees, say -- be tuned from a single number instead of having every
  // dimension inside them multiplied by hand.
  scale(f) {
    for (let i = 0; i < this.verts.length; i++) this.verts[i] = (this.verts[i] * f) | 0;
    this.height = (this.height * f) | 0;
    this.radius = (this.radius * f) | 0;
    return this;
  }

  // Resize each axis separately, which is how a lump of rock becomes a slab
  // of it. The primitives are all built round a circle or a square, so on
  // their own they can only make things that are as deep as they are wide --
  // and a natural arch is the opposite of that: a thin fin of rock with a
  // hole worn through it, not a hoop.
  //
  // Only safe on the shapes whose shading is baked from the angle round the
  // model rather than from a face normal -- geodes and drums. Squashing a
  // facet-lit shape would leave its faces lit for the proportions it used to
  // have.
  scale3(fx, fy, fz) {
    for (let i = 0; i < this.verts.length; i += 3) {
      this.verts[i] = (this.verts[i] * fx) | 0;
      this.verts[i + 1] = (this.verts[i + 1] * fy) | 0;
      this.verts[i + 2] = (this.verts[i + 2] * fz) | 0;
    }
    this.height = (this.height * fy) | 0;
    this.radius = (this.radius * Math.max(fx, fz)) | 0;
    return this;
  }
}

export function shade(col, f) {
  return [
    Math.min(255, Math.round(col[0] * f)),
    Math.min(255, Math.round(col[1] * f)),
    Math.min(255, Math.round(col[2] * f)),
  ];
}

// A copy of a model with its face colours passed through a mapping. The
// vertices are shared, not copied: only the face list is rebuilt, so a lit
// variant of a part costs a few objects rather than a second copy of its
// geometry.
// `glow` marks the faces the mapping actually changed as emissive, so they
// skip the time-of-day tint when they are drawn. A navigation light has to:
// it is a light source, and running it through the same tint as the airframe
// makes it darker than the machine carrying it at precisely the hour it is
// meant to show.
export function recolour(model, fn, glow = false) {
  const out = new Model();
  out.verts = model.verts;
  out.height = model.height;
  out.radius = model.radius;
  out.faces = model.faces.map((f) => {
    const col = fn(f.col);
    if (!col) return f;
    return glow ? { idx: f.idx, col, glow: true } : { idx: f.idx, col };
  });
  return out;
}

// Copy one model's geometry into another, offset by (dx, dy, dz) in tiles.
export function mergeAt(dst, src, dx, dy, dz) {
  const base = dst.verts.length / 3;
  const ox = (dx * TILE) | 0, oy = (dy * TILE) | 0, oz = (dz * TILE) | 0;
  for (let i = 0; i < src.verts.length; i += 3) {
    dst.verts.push(src.verts[i] + ox, src.verts[i + 1] + oy, src.verts[i + 2] + oz);
  }
  for (const f of src.faces) {
    dst.faces.push({ idx: f.idx.map((i) => i + base), col: f.col });
  }
  dst.height = Math.max(dst.height, src.height - oy);
  dst.radius = Math.max(dst.radius, src.radius + Math.max(Math.abs(ox), Math.abs(oz)));
  return dst;
}

// ---------------------------------------------------------------------------
// Facet lighting
// ---------------------------------------------------------------------------

// Light from above, a little to the left and ahead. +y is down, so "above"
// is negative.
export const LIGHT = (() => {
  const v = [-0.34, -1, 0.26];
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
})();

// Add a face shaded by its own normal, so the faceting does the work rather
// than hand-picked brightness. The normal is flipped outward where needed:
// the model is drawn without backface culling, so winding is free to be
// inconsistent.
//
// The ambient floor is deliberately high. The camera rides at the craft's own
// altitude, so the facets usually on show are the flanks and belly -- exactly
// the ones a purely directional light leaves in shadow, which against a black
// sky would reduce the whole craft to a silhouette.
export function facet(m, idx, base) {
  const v = m.verts;
  const p = (i) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  const [ax, ay, az] = p(idx[0]);
  const [bx, by, bz] = p(idx[1]);
  const [cx, cy, cz] = p(idx[2]);

  const e1 = [bx - ax, by - ay, bz - az];
  const e2 = [cx - ax, cy - ay, cz - az];
  let n = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  n = [n[0] / len, n[1] / len, n[2] / len];

  let mx = 0, my = 0, mz = 0;
  for (const i of idx) { const q = p(i); mx += q[0]; my += q[1]; mz += q[2]; }
  const k = idx.length;
  if (n[0] * (mx / k) + n[1] * (my / k) + n[2] * (mz / k) < 0) {
    n = [-n[0], -n[1], -n[2]];
  }

  const lit = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  m.face(idx, shade(base, 0.70 + 0.46 * lit));
  return m;
}

// --- model drawing ---------------------------------------------------------

const scratch = [];
const pt = { x: 0, y: 0 };

// Draw a model's faces back to front. With only a dozen or so faces per
// object a straight depth sort is cheaper than anything cleverer, and it
// copes with the concave shapes (legs, fins) that culling alone would not.
// How close a thing has to get before it stops being lit and becomes a shape,
// and how close before it is nothing but a shape. In tiles.
//
// Painter's algorithm has no answer for an object you are about to fly into.
// It is sorted by the middle of each face, so at a couple of tiles the near
// faces of a tree start swapping order with its far ones, and what you see is
// a flicker rather than a tree -- and at the same moment it is filling a
// quarter of the screen, so it is the most distracting thing on it. The style
// already answers this for the near ground and for the horizon by dropping
// to a flat dark shape, and a shape has no face order to get wrong.
// Measured rather than guessed, and the measurement moved these numbers twice.
//
// The camera rides fifteen tiles behind the craft, so "close to the camera"
// means well behind you, in the bottom of the frame -- not ahead. And the
// landscape scan stops queueing objects at a fixed range: over five hundred
// frames of low flying, the nearest object ever drawn was 8.74 tiles from the
// camera, with the population starting in earnest at nine. Nothing is ever
// drawn closer than that, which is the pop itself -- a lit, sixty-pixel tree
// simply ceases to exist as it crosses the line.
//
// The front of the view is a fixed distance, not a guess: the landscape is
// scanned from 26 tiles out down to 10, so the nearest row of ground sits
// between 9 and 10.3 tiles from the camera once the row's own slide and an
// object's jitter within its tile are counted. Nothing exists closer than
// that. So the fade reaches its end at 11.8, which puts the whole of the two
// nearest rows at flat black rather than merely nearly there, and it starts
// far enough back -- seventeen and a half tiles, around five rows -- that
// something is already on its way down by the time it is a third of the way
// up the screen. A shorter run than that reads as a switch rather than as
// depth, which is the thing it is meant to be describing.
//
// So the fade runs from seventeen and a half tiles down to just under twelve:
// by
// anything reaches the edge of what is drawn it is already a flat shape, and
// a shape leaving the bottom of the frame is a thing passing rather than a
// thing vanishing. It also puts the dark exactly where the style wants it,
// since the near ground behind it is going the same way at the same time.
//
// The last stretch of that fade goes somewhere the rest of the world does
// not: to flat black. Everything else that turns into a silhouette here --
// the horizon ranges, the near ground -- stops at a dusk-coloured dark, so it
// still sits in the picture. The things crossing the front of the view are
// the one case where that is not enough: they are enormous, they are gone a
// moment later, and half-shading them just makes a large soft grey object
// where what you want is a shape. Black is also flat by definition, so the
// facets stop existing and a tree passing the camera is one silhouette rather
// than nine polygons agreeing with each other.
const SIL_FAR = 17.5;
const SIL_NEAR = 11.8;

// Where in that fade the target stops being the dusk dark and becomes black.
// Below this the near objects match the hills behind them, above it they
// separate from them on purpose.
const SIL_BLACK_AT = 0.55;

export function silhouetteAmount(dx, dz) {
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= SIL_FAR) return 0;
  if (d <= SIL_NEAR) return 1;
  return (SIL_FAR - d) / (SIL_FAR - SIL_NEAR);
}

const silDark = [0, 0, 0];
const silCol = [0, 0, 0];
const fadeCol = [0, 0, 0, 255];

// `fade` draws the model translucent, which is only ever used for one thing:
// laying a second, glowing copy of something over the plain one so it can
// light up gradually instead of switching on. Face colours are baked at build
// time, so a glow that comes up over a dusk has to be a blend at draw time,
// and an ordinary alpha blend of a copy over the original is exactly that
// blend -- no extra blend mode, no extra draw call.
export function drawModel(rd, model, matrix, wx, wy, wz, camX, camY, camZ,
                          fog = 0, sil = 0, fade = 1) {
  const verts = model.verts;
  const n = verts.length / 3;

  // Transform and project every vertex once.
  while (scratch.length < n * 3) scratch.push(0);
  let anyVisible = false;
  for (let i = 0; i < n; i++) {
    let px = verts[i * 3], py = verts[i * 3 + 1], pz = verts[i * 3 + 2];
    if (matrix) {
      const r = matApply(matrix, px, py, pz);
      px = r[0]; py = r[1]; pz = r[2];
    }
    const vx = (wx + px - camX) | 0;
    const vy = (wy + py - camY) | 0;
    const vz = (wz + pz - camZ) | 0;
    if (project(vx, vy, vz, pt)) {
      scratch[i * 3] = pt.x;
      scratch[i * 3 + 1] = pt.y;
      scratch[i * 3 + 2] = vz;
      anyVisible = true;
    } else {
      scratch[i * 3 + 2] = -1; // behind the camera
    }
  }
  if (!anyVisible) return;

  // Depth-sort the faces by their mean distance.
  const faces = model.faces;
  const order = [];
  for (let f = 0; f < faces.length; f++) {
    const idx = faces[f].idx;
    let depth = 0, ok = true;
    for (let k = 0; k < idx.length; k++) {
      const d = scratch[idx[k] * 3 + 2];
      if (d < 0) { ok = false; break; }
      depth += d;
    }
    if (!ok) continue;
    order.push([depth / idx.length, f]);
  }
  order.sort((a, b) => b[0] - a[0]);

  if (sil > 0.01) {
    silhouetteDark(silDark);
    // Towards black over the last part of the fade, so the closest things are
    // a flat cut-out and the ones still some way off are only dusk-dark.
    const toBlack = sil <= SIL_BLACK_AT ? 0
                  : (sil - SIL_BLACK_AT) / (1 - SIL_BLACK_AT);
    silDark[0] *= 1 - toBlack;
    silDark[1] *= 1 - toBlack;
    silDark[2] *= 1 - toBlack;
  }

  for (const [, f] of order) {
    const face = faces[f];
    const { idx } = face;
    let col = face.glow ? emissive(face.col, fog) : litColour(face.col, fog);
    if (fade < 0.999) {
      fadeCol[0] = col[0]; fadeCol[1] = col[1]; fadeCol[2] = col[2];
      fadeCol[3] = Math.round(255 * fade);
      col = fadeCol;
    }
    // A light is exempt. Everything else near the camera goes to a shape,
    // but a lamp that dims as it approaches is not a lamp -- and on a dark
    // sea the lantern on a boat is the whole of how you find her.
    if (sil > 0.01 && !face.glow) {
      // All the way at the front. Short of the front it is still a mix, so
      // an object does not snap from lit to black in one frame.
      const k = sil;
      silCol[0] = Math.round(col[0] + (silDark[0] - col[0]) * k);
      silCol[1] = Math.round(col[1] + (silDark[1] - col[1]) * k);
      silCol[2] = Math.round(col[2] + (silDark[2] - col[2]) * k);
      col = silCol;
    }
    const i0 = idx[0] * 3, i1 = idx[1] * 3, i2 = idx[2] * 3;
    if (idx.length === 3) {
      rd.tri(scratch[i0], scratch[i0 + 1], scratch[i1], scratch[i1 + 1],
             scratch[i2], scratch[i2 + 1], col);
    } else if (idx.length === 4) {
      const i3 = idx[3] * 3;
      rd.quad(scratch[i0], scratch[i0 + 1], scratch[i1], scratch[i1 + 1],
              scratch[i2], scratch[i2 + 1], scratch[i3], scratch[i3 + 1], col);
    } else {
      // Anything with more corners than that is fanned from its first vertex.
      // These are all caps -- the end of a half-round, the top of a turned
      // cylinder, the lid of a tree's foliage drum -- and they are convex, so
      // a fan is exact. Without this they were drawn as a quad of their first
      // four corners and the rest were simply dropped, which is what made the
      // arch caps look torn.
      for (let k = 1; k + 1 < idx.length; k++) {
        const a = idx[k] * 3, b = idx[k + 1] * 3;
        rd.tri(scratch[i0], scratch[i0 + 1], scratch[a], scratch[a + 1],
               scratch[b], scratch[b + 1], col);
      }
    }
  }
}


// ---------------------------------------------------------------------------
// Lamps
// ---------------------------------------------------------------------------

const lampPt = { x: 0, y: 0 };

// A light source on a vehicle: a square of colour sized by distance, with a
// dimmer square of glow around it.
//
// Lamps are emissive, so they skip the time-of-day tint entirely -- a
// navigation light is exactly as bright at midnight as at noon, which is the
// whole point of it. They still fade into the haze with distance.
export function drawLamp(rd, wx, wy, wz, camX, camY, camZ, size, col, fog = 0, glow = true) {
  if (!project((wx - camX) | 0, (wy - camY) | 0, (wz - camZ) | 0, lampPt)) return;
  const s = Math.max(1, Math.round(size * projScale((wz - camZ) | 0) * TILE));
  if (s > 40) return;                       // right on top of the camera
  const x = Math.round(lampPt.x - s / 2), y = Math.round(lampPt.y - s / 2);

  if (glow && s >= 2) {
    // The halo is the lamp colour half way to the sky behind it, which keeps
    // it reading as light spill rather than as a second, larger lamp.
    const back = skyColourAt(lampPt.y);
    const halo = [
      Math.round(col[0] * 0.45 + back[0] * 0.55),
      Math.round(col[1] * 0.45 + back[1] * 0.55),
      Math.round(col[2] * 0.45 + back[2] * 0.55),
    ];
    rd.rect(x - s, y - s, s * 3, s * 3, emissive(halo, fog));
  }
  rd.rect(x, y, s, s, emissive(col, fog));
}

// ---------------------------------------------------------------------------
// Contact shadows
// ---------------------------------------------------------------------------

const shadowPt = { x: 0, y: 0 };
const shadowRing = [];

// A shadow blob on the ground.
//
// There is no depth buffer and no blending here, so this cannot be a
// translucent quad: instead it samples the ground colour underneath and
// draws a darkened version of it, which is why a shadow on grass, sand and
// concrete each come out the right hue rather than a uniform grey smear.
//
// Each rim point is placed at its own ground height, so the blob drapes over
// slopes instead of hovering as a flat disc cutting into the hillside.
export function drawGroundPatch(rd, wx, wz, radius, strength, tint, camX, camY, camZ, row, fog = 0) {
  if (strength <= 0.02 || radius <= 0) return;

  const ground = landAltitude(wx | 0, wz | 0);
  if (ground >= SEA_LEVEL) return;          // nothing to fall on out at sea

  // A patch is a film of colour laid over the ground, not a guess at what the
  // ground looks like.
  //
  // It used to work the other way: sample the tile colour under the object and
  // mix the tint into it. That sample is taken at a point that moves every
  // frame, from a function built to be noisy -- the mottle comes from low bits
  // of the altitude, and the palette packing shares its bottom two bits across
  // all three channels, so a hair of movement swings the hue. Measured over a
  // 300-frame drift at a fifth of a tile a second, the sampled colour changed
  // on 209 of 299 frames, with a worst single-frame jump of 203 across RGB.
  // That is the flicker, and no amount of smoothing the sample would have
  // fixed it, because the thing being sampled is meant to be noisy.
  //
  // Blending does the same arithmetic -- tint*a + ground*(1-a) is exactly the
  // mix that was being computed by hand -- except it does it against the real
  // pixels, so the patch cannot disagree with the ground it is lying on, and
  // it costs one fewer palette round trip per patch.
  //
  // Distance thins it rather than tinting it: haze takes contrast away, and a
  // shadow you can still pick out at the horizon is a shadow that is too dark.
  const col = [tint[0], tint[1], tint[2],
               Math.max(0, Math.round(strength * 255 * (1 - 0.8 * fog)))];
  if (col[3] <= 2) return;

  const SEG = 8;
  const LIFT = TILE * 0.012;                // just clear of the ground

  // Centre.
  if (!project((wx - camX) | 0, (ground - LIFT - camY) | 0, (wz - camZ) | 0, shadowPt)) return;
  const cx = shadowPt.x, cy = shadowPt.y;

  shadowRing.length = 0;
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    const px = (wx + Math.cos(a) * radius) | 0;
    const pz = (wz + Math.sin(a) * radius) | 0;
    const py = landAltitude(px, pz);
    if (py >= SEA_LEVEL) return;            // straddling the shoreline
    if (!project((px - camX) | 0, (py - LIFT - camY) | 0, (pz - camZ) | 0, shadowPt)) return;
    shadowRing.push(shadowPt.x, shadowPt.y);
  }

  for (let i = 0; i < SEG; i++) {
    const j = (i + 1) % SEG;
    rd.tri(cx, cy, shadowRing[i * 2], shadowRing[i * 2 + 1],
           shadowRing[j * 2], shadowRing[j * 2 + 1], col);
  }
}

// Near enough black. Not quite, because a shadow on a sunlit hillside still
// has sky light falling into it, and pure black reads as a hole.
const SHADOW_TINT = [4, 4, 10];

// How far a shadow slides away from whatever is casting it, per tile of
// height. Capped, because a sun right on the horizon would otherwise throw
// the blob clean out of the landscape row it is being drawn with.
const LEAN = 0.7;
const LEAN_MAX = 1.2;

// A contact shadow. It leans away from whichever body is up and softens right
// down overnight, when only the moon is casting.
export function drawShadow(rd, wx, wz, radius, strength, camX, camY, camZ, row, fog = 0, height = 0) {
  const s = strength * sky.sunStrength;
  if (s <= 0.02) return;
  let lean = sky.sunOffX * (height / TILE) * LEAN;
  if (lean > LEAN_MAX) lean = LEAN_MAX; else if (lean < -LEAN_MAX) lean = -LEAN_MAX;
  drawGroundPatch(rd, (wx + lean * TILE) | 0, wz, radius, s * 0.72,
                  SHADOW_TINT, camX, camY, camZ, row, fog);
}

// The pool a downward-facing lamp throws. The same geometry as a shadow, but
// mixed towards warm white instead of towards black.
const POOL_TINT = [255, 236, 176];

export function drawLightPool(rd, wx, wz, radius, strength, camX, camY, camZ, row, fog = 0) {
  if (strength <= 0.02) return;
  drawGroundPatch(rd, wx, wz, radius, Math.min(0.85, strength),
                  POOL_TINT, camX, camY, camZ, row, fog);
}
