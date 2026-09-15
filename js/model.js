// model.js -- flat-shaded polygon models.
//
// Models are built from a handful of primitives rather than written out as
// vertex tables, which keeps them legible and easy to tweak. Each model is a
// list of faces; a face is a set of vertex indices plus a flat colour.
//
// Remember that +y points DOWN, so the top of a model has a negative y.

import { TILE, matApply } from './maths.js';
import { project } from './renderer.js';

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
}

export function shade(col, f) {
  return [
    Math.min(255, Math.round(col[0] * f)),
    Math.min(255, Math.round(col[1] * f)),
    Math.min(255, Math.round(col[2] * f)),
  ];
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
const LIGHT = (() => {
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
export function drawModel(rd, model, matrix, wx, wy, wz, camX, camY, camZ) {
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

  for (const [, f] of order) {
    const { idx, col } = faces[f];
    const i0 = idx[0] * 3, i1 = idx[1] * 3, i2 = idx[2] * 3;
    if (idx.length === 3) {
      rd.tri(scratch[i0], scratch[i0 + 1], scratch[i1], scratch[i1 + 1],
             scratch[i2], scratch[i2 + 1], col);
    } else {
      const i3 = idx[3] * 3;
      rd.quad(scratch[i0], scratch[i0 + 1], scratch[i1], scratch[i1 + 1],
              scratch[i2], scratch[i2 + 1], scratch[i3], scratch[i3 + 1], col);
    }
  }
}
