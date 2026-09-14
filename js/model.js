// model.js -- flat-shaded polygon models.
//
// Models are built from a handful of primitives rather than written out as
// vertex tables, which keeps them legible and easy to tweak. Each model is a
// list of faces; a face is a set of vertex indices plus a flat colour.
//
// Remember that +y points DOWN, so the top of a model has a negative y.

import { TILE } from './maths.js';

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
