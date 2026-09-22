// sample2.mjs -- bake the texture down to one colour per facet, properly.
//
// The first pass took three point samples near each triangle's centroid,
// which is why the wings came out mottled: a point sample picks up whatever
// the generator baked into that pixel -- its own shading, its own noise, the
// edge of a UV island -- and three of them is not an average, it is three
// opinions. This averages the whole triangle, throws out the samples that
// disagree with the rest (a seam, a pixel of background), and then reduces
// the lot to a small palette, because a folded paper bird has about a dozen
// colours on it and 546 nearly-identical ones read as noise.
import fs from 'fs';
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';

const g = JSON.parse(fs.readFileSync('geom.json', 'utf8'));
const png = fs.readFileSync(process.env.TEX || 'big0.png').toString('base64');
const K = Number(process.env.K || 14);

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await br.newPage();
const raw = await pg.evaluate(async ([dataUrl, uv, idx]) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const W = c.width, H = c.height;
  const at = (u, v, out) => {
    let x = Math.round(u * (W - 1)), y = Math.round(v * (H - 1));
    x = x < 0 ? 0 : x >= W ? W - 1 : x;
    y = y < 0 ? 0 : y >= H ? H - 1 : y;
    const i = (y * W + x) * 4;
    out[0] = px[i]; out[1] = px[i + 1]; out[i === -1 ? 0 : 2] = px[i + 2];
    out[3] = px[i + 3];
  };
  const N = 6;                      // barycentric grid: 28 samples a triangle
  const cols = [];
  const s = [0, 0, 0, 0];
  for (let f = 0; f < idx.length / 3; f++) {
    const a = idx[f * 3], b = idx[f * 3 + 1], cc = idx[f * 3 + 2];
    const got = [];
    for (let i = 0; i <= N; i++) {
      for (let j = 0; i + j <= N; j++) {
        // Pulled a little towards the middle so the edge samples do not sit
        // on the seam the island was cut along.
        const w0 = (i + 0.35) / (N + 1.05), w1 = (j + 0.35) / (N + 1.05);
        const w2 = 1 - w0 - w1;
        if (w2 < 0) continue;
        const u = uv[a * 2] * w0 + uv[b * 2] * w1 + uv[cc * 2] * w2;
        const v = uv[a * 2 + 1] * w0 + uv[b * 2 + 1] * w1 + uv[cc * 2 + 1] * w2;
        at(u, v, s);
        if (s[3] > 16) got.push([s[0], s[1], s[2]]);
      }
    }
    if (!got.length) { cols.push([200, 200, 200]); continue; }
    const mean = got.reduce((m, q) => [m[0] + q[0], m[1] + q[1], m[2] + q[2]], [0, 0, 0])
                    .map((v) => v / got.length);
    // Second pass: drop whatever is a long way from the first answer.
    const keep = got.filter((q) => Math.abs(q[0] - mean[0]) + Math.abs(q[1] - mean[1])
                                 + Math.abs(q[2] - mean[2]) < 120);
    const use = keep.length > got.length * 0.35 ? keep : got;
    const m2 = use.reduce((m, q) => [m[0] + q[0], m[1] + q[1], m[2] + q[2]], [0, 0, 0])
                  .map((v) => Math.round(v / use.length));
    cols.push(m2);
  }
  return { size: [W, H], cols };
}, ['data:image/png;base64,' + png, g.uv, g.idx]);
await br.close();

// --- reduce to a palette ---------------------------------------------------
//
// k-means, seeded by spreading the starting centres as far apart as they go,
// which is what stops it converging on fourteen shades of the same orange.
const pts = raw.cols;
const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const cent = [pts[0]];
while (cent.length < K) {
  let best = null, bd = -1;
  for (const p of pts) {
    let d = Infinity;
    for (const c of cent) d = Math.min(d, dist(p, c));
    if (d > bd) { bd = d; best = p; }
  }
  cent.push(best.slice());
}
let assign = new Array(pts.length).fill(0);
for (let iter = 0; iter < 40; iter++) {
  let moved = false;
  for (let i = 0; i < pts.length; i++) {
    let bi = 0, bd = Infinity;
    for (let k = 0; k < cent.length; k++) { const d = dist(pts[i], cent[k]); if (d < bd) { bd = d; bi = k; } }
    if (assign[i] !== bi) { assign[i] = bi; moved = true; }
  }
  const sum = cent.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < pts.length; i++) {
    const s = sum[assign[i]];
    s[0] += pts[i][0]; s[1] += pts[i][1]; s[2] += pts[i][2]; s[3]++;
  }
  for (let k = 0; k < cent.length; k++) {
    if (sum[k][3]) cent[k] = [0, 1, 2].map((j) => Math.round(sum[k][j] / sum[k][3]));
  }
  if (!moved) break;
}
const out = pts.map((_, i) => cent[assign[i]]);
fs.writeFileSync('cols.json', JSON.stringify(out));
const counts = cent.map((c, k) => [c, assign.filter((a) => a === k).length]);
counts.sort((a, b) => b[1] - a[1]);
console.log('texture', raw.size.join('x'), 'faces', out.length, 'palette', K);
console.log(counts.map(([c, n]) => `${c.join(',')} x${n}`).join('  '));
