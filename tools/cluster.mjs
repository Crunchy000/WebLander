// cluster.mjs -- decimate a dense mesh by vertex clustering, so a scan can be
// tried at this game's budget instead of being measured and thrown away.
//
// Snap every vertex to a coarse grid, average the ones that land in the same
// cell, and drop the triangles that collapse to a line. It is the crudest
// decimator there is and the right one here: everything in this game is flat
// shaded, so a slightly wrong vertex costs nothing and a slightly wrong
// normal is the whole look.
import fs from 'fs';

const g = JSON.parse(fs.readFileSync(process.env.GEOM || 'geom.json', 'utf8'));
const { pos, uv, idx } = g;
const target = Number(process.env.TARGET || 60);

function clusterAt(n) {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < pos.length / 3; i++) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i * 3 + k]);
      hi[k] = Math.max(hi[k], pos[i * 3 + k]);
    }
  }
  const span = Math.max(...hi.map((v, k) => v - lo[k]));
  const cell = span / n;
  const key = (i) => {
    const a = Math.floor((pos[i * 3] - lo[0]) / cell);
    const b = Math.floor((pos[i * 3 + 1] - lo[1]) / cell);
    const c = Math.floor((pos[i * 3 + 2] - lo[2]) / cell);
    return a + ',' + b + ',' + c;
  };
  // One representative per cell: the mean of everything in it.
  const cells = new Map();
  for (let i = 0; i < pos.length / 3; i++) {
    const k = key(i);
    let e = cells.get(k);
    if (!e) cells.set(k, e = { x: 0, y: 0, z: 0, u: 0, v: 0, n: 0, id: cells.size });
    e.x += pos[i * 3]; e.y += pos[i * 3 + 1]; e.z += pos[i * 3 + 2];
    if (uv) { e.u += uv[i * 2]; e.v += uv[i * 2 + 1]; }
    e.n++;
  }
  const outPos = [], outUv = [];
  for (const e of cells.values()) {
    outPos.push(e.x / e.n, e.y / e.n, e.z / e.n);
    outUv.push(e.u / e.n, e.v / e.n);
  }
  const seen = new Set();
  const outIdx = [];
  for (let f = 0; f < idx.length / 3; f++) {
    const a = cells.get(key(idx[f * 3])).id;
    const b = cells.get(key(idx[f * 3 + 1])).id;
    const c = cells.get(key(idx[f * 3 + 2])).id;
    if (a === b || b === c || a === c) continue;        // collapsed to a line
    const sig = [a, b, c].slice().sort((x, y) => x - y).join(',');
    if (seen.has(sig)) continue;                        // the same facet twice
    seen.add(sig);
    outIdx.push(a, b, c);
  }
  return { pos: outPos, uv: outUv, idx: outIdx, cells: cells.size, grid: n };
}

// Walk the grid resolution up until the triangle count passes the target.
let best = null;
for (let n = 2; n <= 40; n++) {
  const r = clusterAt(n);
  const tris = r.idx.length / 3;
  if (!best || Math.abs(tris - target) < Math.abs(best.idx.length / 3 - target)) best = r;
  if (tris > target * 2.5) break;
}
console.log('grid', best.grid, 'verts', best.pos.length / 3, 'tris', best.idx.length / 3);
fs.writeFileSync(process.env.OUT || 'small.json', JSON.stringify(best));
