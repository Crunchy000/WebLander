// split2.mjs -- pull one flower out of a bouquet. The scan is two tulips
// crossed over each other; the game needs one.
import fs from 'fs';
const g = JSON.parse(fs.readFileSync(process.env.GEOM || 'geom.json', 'utf8'));
const { pos, uv, idx } = g;
const n = pos.length / 3;

// Weld by position first: an exported mesh splits a vertex per UV island, so
// index adjacency alone would find far more components than there are.
const key = (i) => [0, 1, 2].map((k) => Math.round(pos[i * 3 + k] * 2000)).join(',');
const weld = new Map(), rep = new Int32Array(n);
for (let i = 0; i < n; i++) {
  const k = key(i);
  if (!weld.has(k)) weld.set(k, i);
  rep[i] = weld.get(k);
}
const parent = new Int32Array(n);
for (let i = 0; i < n; i++) parent[i] = i;
const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
for (let f = 0; f < idx.length / 3; f++) {
  const a = rep[idx[f * 3]], b = rep[idx[f * 3 + 1]], c = rep[idx[f * 3 + 2]];
  join(a, b); join(b, c);
}
const groups = new Map();
for (let f = 0; f < idx.length / 3; f++) {
  const r = find(rep[idx[f * 3]]);
  groups.set(r, (groups.get(r) || 0) + 1);
}
const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1]);
console.log('components', sorted.length, 'largest', sorted.slice(0, 6).map(([, c]) => c).join(' '));

const pick = sorted[Number(process.env.PART || 0)][0];
const map = new Map(), outPos = [], outUv = [], outIdx = [];
for (let f = 0; f < idx.length / 3; f++) {
  if (find(rep[idx[f * 3]]) !== pick) continue;
  for (let k = 0; k < 3; k++) {
    const i = idx[f * 3 + k];
    if (!map.has(i)) {
      map.set(i, outPos.length / 3);
      outPos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      if (uv) outUv.push(uv[i * 2], uv[i * 2 + 1]);
    }
    outIdx.push(map.get(i));
  }
}
console.log('part', process.env.PART || 0, 'tris', outIdx.length / 3, 'verts', outPos.length / 3);
fs.writeFileSync(process.env.OUT || 'part.json', JSON.stringify({ pos: outPos, uv: outUv, idx: outIdx }));
