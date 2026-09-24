// modelpass.js -- the scenery, drawn on the GPU.
//
// Everything else in this renderer is projected by hand: every vertex of
// every model is transformed, divided, coloured and written into one buffer
// in JavaScript, faces sorted back to front because there was no depth
// buffer to do it. That is most of what a frame costs, and the trees, rocks
// and buildings standing on the landscape are the largest single part of it
// -- a third of the frame's JavaScript on land, measured.
//
// They are the easiest part to hand over, too. They never move, they are
// opaque, and there are only a couple of dozen distinct shapes among the
// hundred or so in a view. So each shape goes up to the GPU once, and each
// frame sends only where each copy stands, how far into the haze it is and
// how near the camera: five numbers an instance, and one draw call per shape.
//
// The GPU does what drawModel did, in the same order: the projection that
// project() does, the sky's tint and the row's haze that litColour() does,
// and the fall to a dark silhouette close to the camera. Faces are not
// sorted, because the depth buffer the landscape pass leaves behind does
// that, pixel by pixel -- which is also what lets a hill in front hide a
// tree behind it without the tree having to be drawn at the right moment.
//
// WebGL 2 only. The instancing and the vertex array objects are core there
// and extensions on 1, and the old path is still here for anything that
// cannot run this one: drawModel, unchanged.

import { TILE } from './maths.js';
import { SCREEN_W, SCREEN_H, CENTRE_X, CENTRE_Y, FOCAL_X, FOCAL_Y, DEPTH } from './renderer.js';
import { sky, silhouetteDark, FOG_STEPS } from './daylight.js';
import { SIL_BLACK_AT } from './model.js';

const VS = `#version 300 es
in vec3 aLocal;
in vec4 aCol;
in vec3 iAt;
in vec2 iLook;
uniform vec4 uProj;
uniform vec2 uScreen;
uniform vec2 uDepth;
uniform vec3 uTint;
uniform vec3 uFog;
uniform vec3 uSil;
uniform float uBlackAt;
uniform float uPull;
out vec4 vCol;
void main() {
  // Camera-relative, in tiles, y down: the same space project() works in.
  vec3 v = aLocal + iAt;
  float z = v.z;
  // project() is screen = centre + position * focal / distance; this is the
  // same thing written in clip space, with the division left to the GPU.
  float xc = (uProj.x * 2.0 / uScreen.x - 1.0) * z + v.x * uProj.z * 2.0 / uScreen.x;
  float yc = (1.0 - uProj.y * 2.0 / uScreen.y) * z - v.y * uProj.w * 2.0 / uScreen.y;
  // Depth-tested as if it stood uPull tiles nearer than it does. See PULL.
  float zd = max(z - uPull, 0.016);
  gl_Position = vec4(xc, yc, (uDepth.x + uDepth.y / zd) * z, z);
  // litColour(): the sky's tint, then the row's haze.
  vec3 c = aCol.rgb * uTint;
  c = mix(c, uFog, iLook.x);
  // ... and the silhouette, which goes to black over the last of its range.
  float sil = iLook.y;
  float toBlack = sil <= uBlackAt ? 0.0 : (sil - uBlackAt) / (1.0 - uBlackAt);
  c = mix(c, uSil * (1.0 - toBlack), sil);
  vCol = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 vCol;
out vec4 oCol;
void main() { oCol = vCol; }`;

// How much nearer a model is tested than it stands.
//
// The painter's order had a rule for this, and it was deliberate: whatever
// stands on a tile was drawn two rows after its own ground, so it went down
// over the nearest two rows of ground quads rather than being sliced by them.
// Those quads are coarse -- a tile's worth of hillside as one flat polygon --
// and a flower on a slope, a trunk on a rise, a raft sitting just proud of
// the water, all have their feet inside the next quad forward. Tested
// honestly against that quad they lose their lower halves; the painter's
// order never let them.
//
// The same rule, as a depth: two tiles. Ground more than two tiles in front
// -- a real hill between the camera and the tree -- still hides it, exactly
// as it did when it was painted over the tree afterwards.
const PULL = 2;

const MODEL_STRIDE = 16;          // three floats of position, four bytes of colour
const INST_FLOATS = 5;            // x, y, z, haze, silhouette
const MAX_INSTANCES = 4096;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('model pass shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class ModelPass {
  constructor(rd) {
    this.rd = rd;
    const gl = this.gl = rd.gl;
    this.ok = !!rd.gl2;
    if (!this.ok) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('model pass link: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    this.u = {};
    for (const name of ['uProj', 'uScreen', 'uDepth', 'uTint', 'uFog', 'uSil', 'uBlackAt', 'uPull']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    const aLocal = gl.getAttribLocation(prog, 'aLocal');
    const aCol = gl.getAttribLocation(prog, 'aCol');
    this.iAt = gl.getAttribLocation(prog, 'iAt');
    this.iLook = gl.getAttribLocation(prog, 'iLook');

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // Every shape, one after another, in one buffer that grows as shapes are
    // first asked for. Nothing is uploaded that is never drawn.
    this.shapeBytes = new ArrayBuffer(1 << 20);
    this.shapeF32 = new Float32Array(this.shapeBytes);
    this.shapeU8 = new Uint8Array(this.shapeBytes);
    this.shapeVerts = 0;
    this.shapeDirty = false;
    this.shapes = new Map();       // Model -> { first, count }
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.shapeBytes.byteLength, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aLocal);
    gl.vertexAttribPointer(aLocal, 3, gl.FLOAT, false, MODEL_STRIDE, 0);
    gl.enableVertexAttribArray(aCol);
    gl.vertexAttribPointer(aCol, 4, gl.UNSIGNED_BYTE, true, MODEL_STRIDE, 12);

    // Where each copy stands, rewritten every frame.
    this.inst = new Float32Array(MAX_INSTANCES * INST_FLOATS);
    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.iAt);
    gl.vertexAttribDivisor(this.iAt, 1);
    gl.enableVertexAttribArray(this.iLook);
    gl.vertexAttribDivisor(this.iLook, 1);

    gl.bindVertexArray(null);
    rd.restore();

    // This frame's copies, grouped by shape.
    this.groups = new Map();       // Model -> number[] of instance floats
    this.silOut = [0, 0, 0];
    this.count = 0;
  }

  // A shape's triangles, flattened: every face fanned from its first corner,
  // each corner carrying its face's colour. Done once per shape.
  shape(model) {
    let s = this.shapes.get(model);
    if (s) return s;
    const v = model.verts;
    let tris = 0;
    for (const f of model.faces) tris += f.idx.length - 2;
    const need = (this.shapeVerts + tris * 3) * MODEL_STRIDE;
    if (need > this.shapeBytes.byteLength) return null;   // full: the CPU path draws it
    const first = this.shapeVerts;
    let w = this.shapeVerts;
    const put = (i, col) => {
      const fi = w * 4;
      this.shapeF32[fi] = v[i * 3] / TILE;
      this.shapeF32[fi + 1] = v[i * 3 + 1] / TILE;
      this.shapeF32[fi + 2] = v[i * 3 + 2] / TILE;
      const bi = w * MODEL_STRIDE + 12;
      this.shapeU8[bi] = col[0];
      this.shapeU8[bi + 1] = col[1];
      this.shapeU8[bi + 2] = col[2];
      this.shapeU8[bi + 3] = 255;
      w++;
    };
    for (const f of model.faces) {
      for (let k = 1; k + 1 < f.idx.length; k++) {
        put(f.idx[0], f.col);
        put(f.idx[k], f.col);
        put(f.idx[k + 1], f.col);
      }
    }
    this.shapeVerts = w;
    this.shapeDirty = true;
    s = { first, count: w - first };
    this.shapes.set(model, s);
    return s;
  }

  // One copy of a shape: camera-relative position in fixed point, the row's
  // haze and the silhouette amount, exactly as drawModel is handed them.
  // Returns false when this pass cannot take it, so the caller can fall back.
  add(model, vx, vy, vz, fog, sil) {
    if (!this.ok || this.count >= MAX_INSTANCES) return false;
    // Anything glowing is a light, and lights are drawn by hand.
    if (model.glows === undefined) model.glows = model.faces.some((f) => f.glow);
    if (model.glows) return false;
    if (!this.shape(model)) return false;
    let list = this.groups.get(model);
    if (!list) this.groups.set(model, list = []);
    // The haze in the same steps litColour() uses, so the two paths agree.
    const q = fog > 0.01 ? Math.round(fog * FOG_STEPS) / FOG_STEPS : 0;
    list.push(vx / TILE, vy / TILE, vz / TILE, q, sil > 0.01 ? sil : 0);
    this.count++;
    return true;
  }

  // Draw everything added this frame, against the depth the landscape pass
  // left, and empty the list for the next one.
  flush() {
    if (!this.ok || this.count === 0) return;
    const rd = this.rd, gl = this.gl;
    rd.flush();
    rd.depthMode('test');

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    if (this.shapeDirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.shapeU8, 0, this.shapeVerts * MODEL_STRIDE);
      this.shapeDirty = false;
    }

    // Lay every group's copies end to end and send them up once.
    let at = 0;
    const ranges = [];
    for (const [model, list] of this.groups) {
      if (!list.length) continue;
      this.inst.set(list, at);
      ranges.push(model, at, list.length / INST_FLOATS);
      at += list.length;
      list.length = 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, at);

    gl.uniform4f(this.u.uProj, CENTRE_X, CENTRE_Y, FOCAL_X, FOCAL_Y);
    gl.uniform2f(this.u.uScreen, SCREEN_W, SCREEN_H);
    gl.uniform2f(this.u.uDepth, DEPTH.A, DEPTH.B / TILE);
    gl.uniform3f(this.u.uTint, sky.tint[0], sky.tint[1], sky.tint[2]);
    gl.uniform3f(this.u.uFog, sky.fog[0] / 255, sky.fog[1] / 255, sky.fog[2] / 255);
    silhouetteDark(this.silOut);
    gl.uniform3f(this.u.uSil, this.silOut[0] / 255, this.silOut[1] / 255, this.silOut[2] / 255);
    gl.uniform1f(this.u.uBlackAt, SIL_BLACK_AT);
    gl.uniform1f(this.u.uPull, PULL);

    // An opaque pass: nothing here is see-through.
    gl.disable(gl.BLEND);
    // And a closed one. Every shape in it has been through Model.seal(), so
    // its faces all point outward, and the ones pointing away from the camera
    // are hidden anyway -- by the near side, now, rather than by being
    // painted over. Dropping them before they are rasterised halves the
    // triangles for nothing. The winding is the one tools/culltest.mjs chose
    // for the CPU path, seen through the flip from screen to clip space.
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    let culling = false;
    for (let r = 0; r < ranges.length; r += 3) {
      const model = ranges[r];
      const shape = this.shapes.get(model);
      // Only a closed shell may lose its far side. A flower's petals and
      // leaves are single faces meant to be seen from either side.
      const solid = model.solid === true;
      if (solid !== culling) {
        if (solid) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
        culling = solid;
      }
      const byte = ranges[r + 1] * 4;
      gl.vertexAttribPointer(this.iAt, 3, gl.FLOAT, false, INST_FLOATS * 4, byte);
      gl.vertexAttribPointer(this.iLook, 2, gl.FLOAT, false, INST_FLOATS * 4, byte + 12);
      gl.drawArraysInstanced(gl.TRIANGLES, shape.first, shape.count, ranges[r + 2]);
      rd.drawn = (rd.drawn || 0) + shape.count * ranges[r + 2];
    }
    this.count = 0;

    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(null);
    rd.restore();
  }
}
