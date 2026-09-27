// profile.js -- where the frame's time goes, section by section.
//
// perf.js says how long a frame takes; this says what it spent the time on.
// Each part of the frame adds its milliseconds to a named section as it
// goes, and at the end of the frame every section's total is filed in a
// ring of the last WINDOW frames, from which the debug panel reads medians
// and the slow end. It is always on: a frame's worth is a couple of dozen
// clock reads, which is nothing beside what is being measured.
//
// Two caveats worth carrying into any reading of it. The clock is coarse in
// some browsers -- deliberately, against timing attacks -- so a section
// under a tenth of a millisecond reads as noise. And GL calls are timed as
// what they cost the CPU to issue, not the GPU to carry out: the GPU works
// behind, and its time turns up in the frame interval and in the wait
// probe, not here. See Renderer for those.

const WINDOW = 120;

const sections = new Map();   // name -> { cur, buf, unit }
let frames = 0;
let at = 0;

function section(name, unit) {
  let s = sections.get(name);
  if (!s) {
    s = { cur: 0, buf: new Float32Array(WINDOW), unit };
    sections.set(name, s);
  }
  return s;
}

const sortBuf = new Float32Array(WINDOW);
function pct(buf, p) {
  const count = Math.min(frames, WINDOW);
  if (!count) return 0;
  sortBuf.set(buf.subarray(0, count));
  const slice = sortBuf.subarray(0, count);
  slice.sort();
  return slice[Math.min(count - 1, Math.max(0, Math.round((count - 1) * p)))];
}

export const prof = {
  now: () => performance.now(),

  // A section to hold on to, for the places that time many times a frame
  // (a row at a time): lapTo() on it skips looking the name up each time.
  section(name) {
    return section(name, 'ms');
  },

  // ... and the same for a count.
  counter(name) {
    return section(name, '');
  },

  lapTo(s, t) {
    const n = performance.now();
    s.cur += n - t;
    return n;
  },

  // Milliseconds into a section for this frame.
  add(name, ms) {
    section(name, 'ms').cur += ms;
  },

  // Close a lap that began at `t`, charge it to `name`, and start the next.
  lap(name, t) {
    const n = performance.now();
    section(name, 'ms').cur += n - t;
    return n;
  },

  // A count for this frame, not a time: draw calls, bytes uploaded.
  count(name, v) {
    section(name, '').cur += v;
  },

  // What a section has so far this frame.
  cur(name) {
    const s = sections.get(name);
    return s ? s.cur : 0;
  },

  endFrame() {
    for (const s of sections.values()) {
      s.buf[at] = s.cur;
      s.cur = 0;
    }
    at = (at + 1) % WINDOW;
    frames++;
  },

  // Every section, median and 95th percentile, slowest first.
  table(unit = 'ms') {
    const rows = [];
    for (const [name, s] of sections) {
      if (s.unit !== unit) continue;
      rows.push({ name, median: pct(s.buf, 0.5), p95: pct(s.buf, 0.95) });
    }
    rows.sort((a, b) => b.median - a.median || b.p95 - a.p95);
    return rows;
  },

  median(name) {
    const s = sections.get(name);
    return s ? pct(s.buf, 0.5) : 0;
  },
};
