// adapttest.mjs -- the resolution adaptor, driven by hand.
//
// The machine that caused this test was a console browser that could hold
// sixty at half size and thirty at two thirds, so the adaptor stepped up on
// the comfortable reading, found the next step too slow, stepped down, was
// comfortable again, and went round for ever -- changing the size of the
// canvas each time, which is a flicker. This drives adapt() with made-up
// readings so the loop can be seen happening, or not, without a browser.
import { Renderer } from '../js/renderer.js';

const r = Object.create(Renderer.prototype);
r.scaleAt = 0; r.want = 0; r.slow = 0; r.fast = 0; r.checks = 0; r.ceiling = 0;

const stat = (median, slowest, quick) =>
  ({ ready: true, median, slowest: slowest ?? median * 1.2, quick: quick ?? median * 0.9 });

// How the machine behaves at each step: full size is hopeless, two thirds is
// thirty a second, half is sixty.
const BEHAVIOUR = [
  stat(48, 60),            // 1.0
  stat(36, 44),            // 0.8
  stat(33.3, 35, 33),      // 0.65 -- a clean thirty, which reads as a cadence
  stat(16.7, 18, 16.5),    // 0.5
  stat(12, 14, 11.5),      // 0.4
];

const seen = [];
for (let i = 0; i < 400; i++) {
  r.scaleAt = r.want;                 // the frame applies it
  r.adapt(BEHAVIOUR[r.scaleAt]);
  seen.push(r.want);
}
const settled = seen.slice(-120);
const moves = settled.filter((v, i) => i && v !== settled[i - 1]).length;
console.log(JSON.stringify({
  firstFifty: seen.slice(0, 50).join(''),
  endsAt: seen[seen.length - 1],
  movesInTheLastThirtySeconds: moves,
  ceiling: r.ceiling,
}));
if (moves > 0) { console.error('FAIL: still moving'); process.exit(1); }
console.log('ok: settles and stays');
