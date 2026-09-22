// sample.mjs -- bake the base-colour texture down to one flat colour per
// face, which is the only kind of colour this renderer has.
import fs from 'fs';
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';

const g = JSON.parse(fs.readFileSync('geom.json', 'utf8'));
const webp = fs.readFileSync('tex0.webp').toString('base64');

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await br.newPage();
const out = await pg.evaluate(async ([dataUrl, uv, idx]) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const at = (u, v) => {
    // glTF UVs run top-left origin, which is the same as a canvas.
    let x = Math.round(u * (c.width - 1)), y = Math.round(v * (c.height - 1));
    x = Math.max(0, Math.min(c.width - 1, x));
    y = Math.max(0, Math.min(c.height - 1, y));
    const i = (y * c.width + x) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const cols = [];
  for (let f = 0; f < idx.length / 3; f++) {
    // Three samples pulled in towards the centroid, averaged: a single
    // centroid sample lands on a seam often enough to matter.
    let r = 0, gg = 0, b = 0;
    for (let k = 0; k < 3; k++) {
      const a = idx[f * 3 + k], b1 = idx[f * 3 + (k + 1) % 3], c1 = idx[f * 3 + (k + 2) % 3];
      const u = (uv[a * 2] * 0.6 + uv[b1 * 2] * 0.2 + uv[c1 * 2] * 0.2);
      const v = (uv[a * 2 + 1] * 0.6 + uv[b1 * 2 + 1] * 0.2 + uv[c1 * 2 + 1] * 0.2);
      const s = at(u, v);
      r += s[0]; gg += s[1]; b += s[2];
    }
    cols.push([Math.round(r / 3), Math.round(gg / 3), Math.round(b / 3)]);
  }
  return { size: [c.width, c.height], cols };
}, ['data:image/webp;base64,' + webp, g.uv, g.idx]);
await br.close();
fs.writeFileSync('cols.json', JSON.stringify(out.cols));
console.log('texture', out.size.join('x'), 'faces coloured', out.cols.length);
// A quick histogram of the palette, quantised, so we can see what it is.
const bucket = new Map();
for (const c of out.cols) {
  const k = c.map(v => Math.round(v / 32) * 32).join(',');
  bucket.set(k, (bucket.get(k) || 0) + 1);
}
console.log([...bucket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([k, n]) => `${k} x${n}`).join('   '));
