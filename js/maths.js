// maths.js -- fixed-point arithmetic and lookup tables.
//
// The original runs entirely on 32-bit integers with no FPU, and a good deal
// of the game's character comes from that: the landscape colours, for
// instance, are derived from the low bits of the fixed-point altitude, so
// they only look right if the arithmetic overflows and truncates in exactly
// the same way. JavaScript's bitwise operators are defined on 32-bit signed
// integers, which makes them a direct stand-in for ARM registers -- so we
// keep every world coordinate as an int32 and use `| 0` liberally.

// One landscape tile. World coordinates are 8.24 fixed point, which means the
// coordinate space wraps around every 256 tiles -- the world is a torus, and
// that is exactly how the original behaves.
export const TILE = 0x01000000;

export const HALF_TILE = TILE >> 1;

// Convert between tiles and fixed point.
export const tiles = (n) => (n * TILE) | 0;
export const toTiles = (v) => v / TILE;

// ---------------------------------------------------------------------------
// Sine table
// ---------------------------------------------------------------------------
//
// 1024 entries spanning a full turn, scaled to fill a signed 32-bit word.
// Angles are themselves int32s, so the whole 32-bit range is one revolution
// and angle arithmetic wraps for free.

export const SIN_BITS = 10;
export const SIN_SIZE = 1 << SIN_BITS; // 1024

export const SIN_TABLE = (() => {
  const t = new Int32Array(SIN_SIZE);
  for (let i = 0; i < SIN_SIZE; i++) {
    t[i] = Math.round(0x7fffffff * Math.sin((2 * Math.PI * i) / SIN_SIZE));
  }
  return t;
})();

// Look up sin() of an int32 angle, where 2^32 is a full turn. The top ten
// bits select the table entry, which is what the original's shift-and-mask
// addressing works out to.
export function sinLookup(a) {
  return SIN_TABLE[(a >>> 22) & (SIN_SIZE - 1)];
}

export function cosLookup(a) {
  return SIN_TABLE[(((a >>> 22) + (SIN_SIZE >> 2)) | 0) & (SIN_SIZE - 1)];
}

// A full turn, a quarter turn and so on, as int32 angles.
export const ANGLE_FULL    = 0x100000000; // conceptually; never stored in an int32
export const ANGLE_HALF    = -0x80000000; // == 0x80000000 as a signed int32
export const ANGLE_QUARTER = 0x40000000;

// Degrees -> int32 angle.
export const deg = (d) => (Math.round((d / 360) * 4294967296) | 0);

// ---------------------------------------------------------------------------
// Fixed-point multiply
// ---------------------------------------------------------------------------

// Multiply two 8.24 fixed-point values. Done in floating point and folded back
// to an int32: the operands here are geometry, not colour-critical bits, so
// the exact rounding does not matter and this is far quicker than emulating a
// 64-bit integer multiply.
export function fmul(a, b) {
  return (a * b) / TILE | 0;
}

// Multiply a fixed-point value by a plain number.
export function fscale(a, s) {
  return (a * s) | 0;
}

// ---------------------------------------------------------------------------
// Polar coordinates
// ---------------------------------------------------------------------------

// Convert a cartesian offset into (distance, angle). The original does this
// with a shift-and-subtract division and an arctan table so that it can fly
// the ship from the mouse position; we get the same answer from Math.hypot and
// Math.atan2, converted into the game's int32 angle units.
export function toPolar(x, y) {
  const dist = Math.hypot(x, y);
  const angle = (Math.atan2(y, x) / (2 * Math.PI)) * 4294967296;
  return { dist, angle: angle | 0 };
}

// ---------------------------------------------------------------------------
// 3x3 rotation matrices
// ---------------------------------------------------------------------------
//
// Stored row-major as a flat array of nine plain floats. The ship's matrix is
// rebuilt from scratch every frame from the current tilt, so there is no
// accumulated drift to orthonormalise away.

export function matIdentity() {
  return new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

// Build the craft's orientation from a heading and a pitch.
//
// This is the heart of the flight model, and it is worth being precise about.
// Steering does not merely lean the craft: it turns it. The direction you
// steer becomes the craft's heading, and how hard you steer becomes how far
// its nose tips down. Thrust acts along the roof, so a nose-down attitude
// pushes you along the heading -- and because the gun fires along the nose,
// aiming and flying are the same action.
//
// Columns of the matrix are the craft's own axes in world space:
//
//   model +x -> side      model -y -> roof (up)      model +z -> nose
//
// Remember +y points down, so "up" is negative y.
export function matFromAim(yaw, pitch, out = new Float64Array(9)) {
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const sp = Math.sin(pitch), cp = Math.cos(pitch);

  // nose: the heading, tipped down by pitch.
  const nx = sy * cp, ny = sp, nz = cy * cp;
  // roof: straight up, tipped forward by the same pitch, so thrust carries
  // you along the heading as the nose drops.
  const rx = sy * sp, ry = -cp, rz = cy * sp;
  // side: horizontal, square to the heading.
  const dx = cy, dy = 0, dz = -sy;

  out[0] = dx; out[1] = -rx; out[2] = nx;
  out[3] = dy; out[4] = -ry; out[5] = ny;
  out[6] = dz; out[7] = -rz; out[8] = nz;

  return out;
}

// Multiply two 3x3 matrices: applies b first, then a.
export function matMul(a, b, out = new Float64Array(9)) {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

// Rotation about the x-axis -- the axis a tilt-rotor's nacelles pivot on.
export function matRotX(t, out = new Float64Array(9)) {
  const s = Math.sin(t), c = Math.cos(t);
  out[0] = 1; out[1] = 0; out[2] = 0;
  out[3] = 0; out[4] = c; out[5] = -s;
  out[6] = 0; out[7] = s; out[8] = c;
  return out;
}

// Rotation about the y-axis, for spinning rotor blades.
export function matRotY(t, out = new Float64Array(9)) {
  const s = Math.sin(t), c = Math.cos(t);
  out[0] = c;  out[1] = 0; out[2] = s;
  out[3] = 0;  out[4] = 1; out[5] = 0;
  out[6] = -s; out[7] = 0; out[8] = c;
  return out;
}

// Transform a vector by a matrix. Operates on plain numbers; callers working
// in fixed point simply pass fixed-point components through.
export function matApply(m, x, y, z, out = [0, 0, 0]) {
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}

// ---------------------------------------------------------------------------
// Random numbers
// ---------------------------------------------------------------------------

let seedA = 0x2545f491, seedB = 0x9e3779b9;

export function seedRandom(a, b) {
  seedA = a | 0 || 0x2545f491;
  seedB = b | 0 || 0x9e3779b9;
}

// xorshift, returning a full int32.
export function rnd32() {
  let x = seedA;
  const y = seedB;
  seedA = y;
  x ^= x << 23;
  x = (x ^ (x >>> 17) ^ y ^ (y >>> 26)) | 0;
  seedB = x;
  return (x + y) | 0;
}

// Uniform float in [0, 1).
export function rnd() {
  return (rnd32() >>> 0) / 4294967296;
}

// Uniform float in [-1, 1).
export function rndSigned() {
  return rnd() * 2 - 1;
}

// Uniform integer in [0, n).
export function rndInt(n) {
  return (rnd() * n) | 0;
}

// A stable hash of two integers -- used to decide, without storing anything,
// what sits on any given tile of the infinite map.
export function hash2(x, y) {
  let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
