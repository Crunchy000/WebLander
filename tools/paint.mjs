// paint.mjs -- the model's own colours, read off its texture and split by
// where on the plant each triangle sits rather than by what colour it is.
import fs from 'fs';
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';
const g = JSON.parse(fs.readFileSync(process.env.GEOM || 'geom.json', 'utf8'));
const tex = fs.readFileSync(process.env.TEX || 'tex0.webp').toString('base64');
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await br.newPage();
const out = await pg.evaluate(async ([url, pos, uv, idx, cut]) => {
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
  let lo = 1e9, hi = -1e9;
  for (let i = 0; i < pos.length / 3; i++) {
    lo = Math.min(lo, pos[i * 3 + 1]); hi = Math.max(hi, pos[i * 3 + 1]);
  }
  // Average each triangle over a barycentric grid, as the bird's pipeline
  // does, rather than point sampling it.
  const bins = { top: [], rest: [] };
  for (let f = 0; f < idx.length / 3; f++) {
    const p = [0, 1, 2].map((i) => idx[f * 3 + i]);
    let r = 0, gg = 0, b = 0, n = 0;
    for (let a = 0; a <= 4; a++) for (let bb = 0; bb + a <= 4; bb++) {
      const w = [a / 4, bb / 4, 1 - a / 4 - bb / 4];
      const u = w[0] * uv[p[0] * 2] + w[1] * uv[p[1] * 2] + w[2] * uv[p[2] * 2];
      const v = w[0] * uv[p[0] * 2 + 1] + w[1] * uv[p[1] * 2 + 1] + w[2] * uv[p[2] * 2 + 1];
      const col = at(u, v);
      r += col[0]; gg += col[1]; b += col[2]; n++;
    }
    const y = p.reduce((s, i) => s + pos[i * 3 + 1], 0) / 3;
    const where = (y - lo) / (hi - lo) > cut ? 'top' : 'rest';
    bins[where].push([r / n, gg / n, b / n]);
  }
  const stat = (rows) => {
    if (!rows.length) return null;
    const med = (k) => {
      const s = rows.map((c) => c[k]).sort((a, b) => a - b);
      return Math.round(s[s.length >> 1]);
    };
    // The brightest tenth as well: a baked texture carries its own shadows,
    // and the lit side is the colour the paper actually is.
    const byLum = rows.slice().sort((a, b) =>
      (b[0] + b[1] + b[2]) - (a[0] + a[1] + a[2])).slice(0, Math.max(1, rows.length / 10 | 0));
    const mean = (rowsIn, k) => Math.round(rowsIn.reduce((s, c) => s + c[k], 0) / rowsIn.length);
    return { n: rows.length, median: [med(0), med(1), med(2)],
             lit: [mean(byLum, 0), mean(byLum, 1), mean(byLum, 2)] };
  };
  return { top: stat(bins.top), rest: stat(bins.rest) };
}, ['data:image/webp;base64,' + tex, g.pos, g.uv, g.idx, Number(process.env.CUT || 0.62)]);
console.log(JSON.stringify(out));
await br.close();
