// gen.mjs -- turn the decoded origami hummingbird into a module this engine
// can draw: welded vertices in tiles, one baked colour per face, split into
// the three pieces that have to move independently.
import fs from 'fs';

const g = JSON.parse(fs.readFileSync('geom.json', 'utf8'));
const cols = JSON.parse(fs.readFileSync('cols.json', 'utf8'));
const pos = g.pos, idx = g.idx, nf = idx.length / 3;

const SCALE = Number(process.env.SCALE || 1.30);
const Y_CUT = 0.05, Z_CUT = 0.03;

// glTF is Y-up with the bird's nose at -x and its span along z. This engine
// is y-down with the nose at +z and the span along x. Written out as a map so
// the handedness is preserved (determinant +1) rather than mirrored.
const toGame = (x, y, z) => [-z * SCALE, -y * SCALE, -x * SCALE];

// Weld: the export has 817 points for 273 positions.
const keyOf = (i) => [0, 1, 2].map((k) => Math.round(pos[i * 3 + k] * 4096)).join(',');
const weld = new Map();
const wid = new Int32Array(pos.length / 3);
const wpos = [];
for (let i = 0; i < pos.length / 3; i++) {
  const k = keyOf(i);
  if (!weld.has(k)) { weld.set(k, wpos.length); wpos.push([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]); }
  wid[i] = weld.get(k);
}

// Which piece each face belongs to, and the two wing pivots.
const part = [], cen = [];
for (let f = 0; f < nf; f++) {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < 3; k++) { const i = idx[f * 3 + k]; x += pos[i * 3]; y += pos[i * 3 + 1]; z += pos[i * 3 + 2]; }
  x /= 3; y /= 3; z /= 3; cen.push([x, y, z]);
  part.push(y > Y_CUT && Math.abs(z) > Z_CUT ? (z > 0 ? 1 : 2) : 0);
}

// A wing pivots about its root: the part of it nearest the centre plane.
const pivot = [null, null, null];
for (const p of [1, 2]) {
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (let f = 0; f < nf; f++) {
    if (part[f] !== p) continue;
    for (let k = 0; k < 3; k++) {
      const i = idx[f * 3 + k];
      if (Math.abs(pos[i * 3 + 2]) > 0.07) continue;      // root vertices only
      sx += pos[i * 3]; sy += pos[i * 3 + 1]; sz += pos[i * 3 + 2]; n++;
    }
  }
  pivot[p] = n ? [sx / n, sy / n, sz / n] : [0, 0, 0];
}

// Lowest point in game y, so the bird can be stood on the ground.
let lowest = -1e9;
for (const v of wpos) { const q = toGame(v[0], v[1], v[2]); if (q[1] > lowest) lowest = q[1]; }

const pieces = [
  { name: 'BODY', p: 0, origin: [0, 0, 0] },
  { name: 'WING_R', p: 1, origin: pivot[1] },
  { name: 'WING_L', p: 2, origin: pivot[2] },
];

const num = (v) => {
  const s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

let out = '';
const meta = [];
for (const piece of pieces) {
  const used = new Map(); const verts = []; const faces = [];
  const og = toGame(piece.origin[0], piece.origin[1], piece.origin[2]);
  for (let f = 0; f < nf; f++) {
    if (part[f] !== piece.p) continue;
    const tri = [];
    for (let k = 0; k < 3; k++) {
      const w = wid[idx[f * 3 + k]];
      if (!used.has(w)) {
        const q = toGame(wpos[w][0], wpos[w][1], wpos[w][2]);
        used.set(w, verts.length);
        verts.push([q[0] - og[0], q[1] - og[1], q[2] - og[2]]);
      }
      tri.push(used.get(w));
    }
    faces.push([...tri, ...cols[f]]);
  }
  const wrap = (arr, per) => {
    const flat = arr.flat().map(num);
    const lines = [];
    for (let i = 0; i < flat.length; i += per) lines.push('  ' + flat.slice(i, i + per).join(', ') + ',');
    return lines.join('\n');
  };
  out += `const ${piece.name}_V = [\n${wrap(verts, 12)}\n];\n`;
  out += `const ${piece.name}_F = [\n${wrap(faces, 12)}\n];\n\n`;
  meta.push({ name: piece.name, verts: verts.length, faces: faces.length, origin: og });
}
fs.writeFileSync('data.js', out);
fs.writeFileSync('meta.json', JSON.stringify({ meta, lowest, scale: SCALE }, null, 1));
console.log(JSON.stringify({ meta, lowest: +lowest.toFixed(3), bytes: out.length }, null, 1));
