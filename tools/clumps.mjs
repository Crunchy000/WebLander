// clumps.mjs -- how big a clump of flowers actually is, in tiles, measured
// as connected runs of flowering ground rather than judged from a screenshot.
const fl = await import('/home/user/WebLander/js/flowers.js');
const { TILE } = await import('/home/user/WebLander/js/maths.js');
const N = 160;                       // tiles square to sweep
const has = new Uint8Array(N * N);
for (let z = 0; z < N; z++) {
  for (let x = 0; x < N; x++) {
    const wx = ((x - N / 2) * TILE) | 0, wz = ((z - N / 2) * TILE) | 0;
    // Anything within half a tile of this tile's centre counts as this tile.
    has[z * N + x] = fl.nearestFlower(wx, wz, 0, 0.5) ? 1 : 0;
  }
}
const seen = new Uint8Array(N * N);
const sizes = [];
const stack = [];
for (let i = 0; i < N * N; i++) {
  if (!has[i] || seen[i]) continue;
  let size = 0;
  stack.push(i);
  seen[i] = 1;
  while (stack.length) {
    const j = stack.pop();
    size++;
    const x = j % N, z = (j / N) | 0;
    const near = [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]];
    for (const [nx, nz] of near) {
      if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
      const k = nz * N + nx;
      if (has[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
    }
  }
  sizes.push(size);
}
sizes.sort((a, b) => a - b);
const tiles = sizes.reduce((s, v) => s + v, 0);
const p = (q) => sizes[Math.min(sizes.length - 1, Math.round((sizes.length - 1) * q))];
console.log(JSON.stringify({
  flowering: +(100 * tiles / (N * N)).toFixed(1) + '% of the ground',
  clumps: sizes.length,
  tilesPerClump: { median: p(0.5), p90: p(0.9), biggest: sizes[sizes.length - 1] },
}));
