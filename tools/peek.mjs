// peek.mjs -- three orthographic views of a raw mesh, flat shaded by normal,
// so we can see what a model is before deciding what to do with it.
import fs from 'fs';
import { chromium } from '/home/user/WebLander/node_modules/playwright/index.mjs';
const g = JSON.parse(fs.readFileSync(process.env.GEOM || 'geom.json', 'utf8'));
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await br.newPage({ viewport: { width: 1080, height: 380 } });
await pg.setContent('<body style="margin:0;background:#111"><canvas id=c width=1080 height=380></canvas></body>');
await pg.evaluate(([pos, idx]) => {
  const ctx = document.getElementById('c').getContext('2d');
  // Fit the mesh into the frame whatever its own scale is.
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < pos.length / 3; i++) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i * 3 + k]);
      hi[k] = Math.max(hi[k], pos[i * 3 + k]);
    }
  }
  const mid = lo.map((v, k) => (v + hi[k]) / 2);
  const span = Math.max(...hi.map((v, k) => v - lo[k])) || 1;
  const views = [
    { name: 'front (+Z)', u: 0, v: 1, d: 2, fu: 1, fv: -1 },
    { name: 'side (+X)', u: 2, v: 1, d: 0, fu: 1, fv: -1 },
    { name: 'top (+Y)', u: 0, v: 2, d: 1, fu: 1, fv: 1 },
  ];
  views.forEach((view, k) => {
    const ox = 180 + k * 360, oy = 190, S = 300 / span;
    const faces = [];
    for (let f = 0; f < idx.length / 3; f++) {
      const p = [0, 1, 2].map((i) => idx[f * 3 + i]);
      const depth = p.reduce((s, i) => s + pos[i * 3 + view.d], 0) / 3;
      const a = p.map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
      const e1 = a[1].map((v, i) => v - a[0][i]);
      const e2 = a[2].map((v, i) => v - a[0][i]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
                 e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(...n) || 1;
      const lit = Math.abs((n[0] * 0.3 + n[1] * 0.8 + n[2] * 0.5) / len);
      faces.push({ p, depth, shade: Math.round(60 + 175 * lit) });
    }
    faces.sort((a, b) => a.depth - b.depth);
    for (const fc of faces) {
      ctx.beginPath();
      fc.p.forEach((i, n) => {
        const x = ox + (pos[i * 3 + view.u] - mid[view.u]) * S * view.fu;
        const y = oy + (pos[i * 3 + view.v] - mid[view.v]) * S * view.fv;
        n ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = `rgb(${fc.shade},${fc.shade},${fc.shade})`;
      ctx.fill();
    }
    ctx.fillStyle = '#8af'; ctx.font = '14px monospace';
    ctx.fillText(view.name, ox - 60, 24);
  });
}, [g.pos, g.idx]);
await pg.locator('#c').screenshot({ path: process.env.OUT || 'peek.png' });
await br.close();
