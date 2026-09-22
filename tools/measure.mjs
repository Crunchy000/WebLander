// measure.mjs -- read a flower's proportions and colours off the real model,
// so the hand-built one can be corrected against it rather than guessed at.
import fs from 'fs';
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';
const g = JSON.parse(fs.readFileSync(process.env.GEOM || 'geom.json', 'utf8'));
const tex = fs.readFileSync(process.env.TEX || 'tex0.webp').toString('base64');
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await br.newPage();
const out = await pg.evaluate(async ([url, pos, uv, idx]) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const W = c.width, H = c.height;
  const at = (u, v) => {
    let x = Math.round(u * (W - 1)), y = Math.round(v * (H - 1));
    x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y));
    const i = (y * W + x) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const groups = { bloom: [], green: [], other: [] };
  const sums = { bloom: [0, 0, 0, 0], green: [0, 0, 0, 0] };
  const tri = idx.length / 3;
  for (let f = 0; f < tri; f++) {
    const p = [0, 1, 2].map((i) => idx[f * 3 + i]);
    const u = p.reduce((s, i) => s + uv[i * 2], 0) / 3;
    const v = p.reduce((s, i) => s + uv[i * 2 + 1], 0) / 3;
    const col = at(u, v);
    const [r, gg, b] = col;
    const kind = gg > r * 1.12 && gg > b * 1.12 ? 'green'
               : r > gg * 1.12 ? 'bloom' : 'other';
    const y = p.reduce((s, i) => s + pos[i * 3 + 1], 0) / 3;
    const x = p.reduce((s, i) => s + pos[i * 3], 0) / 3;
    const z = p.reduce((s, i) => s + pos[i * 3 + 2], 0) / 3;
    groups[kind].push([x, y, z]);
    if (kind !== 'other') {
      sums[kind][0] += r; sums[kind][1] += gg; sums[kind][2] += b; sums[kind][3]++;
    }
  }
  const box = (pts) => {
    if (!pts.length) return null;
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const p of pts) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]);
    }
    return { lo: lo.map((v) => +v.toFixed(3)), hi: hi.map((v) => +v.toFixed(3)),
             size: hi.map((v, k) => +(v - lo[k]).toFixed(3)), n: pts.length };
  };
  const mean = (s) => s[3] ? [0, 1, 2].map((k) => Math.round(s[k] / s[3])) : null;
  return {
    tris: tri, texture: [W, H],
    bloom: box(groups.bloom), green: box(groups.green), other: box(groups.other),
    bloomColour: mean(sums.bloom), greenColour: mean(sums.green),
  };
}, ['data:image/webp;base64,' + tex, g.pos, g.uv, g.idx]);
console.log(JSON.stringify(out, null, 1));
await br.close();
