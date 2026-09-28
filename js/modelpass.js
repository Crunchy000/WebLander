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
import { prof } from './profile.js';
import { sky, silhouetteDark, FOG_STEPS } from './daylight.js';
import { SIL_BLACK_AT } from './model.js';

const VS = `#version 300 es
in vec3 aLocal;
in vec4 aCol;
in vec3 iAt;
in vec4 iLook;
uniform vec4 uProj;
uniform vec2 uScreen;
uniform vec2 uDepth;
uniform vec3 uTint;
uniform vec3 uFog;
uniform vec3 uSil;
uniform float uBlackAt;
uniform float uPull;
uniform mat3 uRot;
uniform float uFlame;
uniform float uTime;
out vec4 vCol;
out vec3 vLocal;
void main() {
  vLocal = aLocal;
  // Camera-relative, in tiles, y down: the same space project() works in.
  // uRot is the identity for scenery, which never turns; the one-off draws
  // (the bird) are turned by it. See drawTurned.
  vec3 v = uRot * aLocal + iAt;
  float z = v.z;
  // project() is screen = centre + position * focal / distance; this is the
  // same thing written in clip space, with the division left to the GPU.
  float xc = (uProj.x * 2.0 / uScreen.x - 1.0) * z + v.x * uProj.z * 2.0 / uScreen.x;
  float yc = (1.0 - uProj.y * 2.0 / uScreen.y) * z - v.y * uProj.w * 2.0 / uScreen.y;
  // Depth-tested as if it stood uPull tiles nearer than it does. See PULL.
  float zd = max(z - uPull, 0.016);
  gl_Position = vec4(xc, yc, (uDepth.x + uDepth.y / zd) * z, z);
  vec3 c;
  float a = iLook.w;
  if (uFlame > 0.0) {
    // Fire (the phoenix's tail and crest): lit from within like a lamp, and
    // as solid as the shape says at each corner -- nearly at the root, a
    // wisp at the tip -- flickering, each corner on a beat of its own.
    c = mix(aCol.rgb, uFog, iLook.z);
    float t = uTime * 11.0 + dot(aLocal, vec3(23.0, 31.0, 17.0));
    // uFlame is how hard it flickers: 1 for the tail and crest, less for
    // the body and wings.
    a = aCol.a * (1.0 - 0.26 * uFlame + uFlame * (0.16 * sin(t) + 0.10 * sin(t * 2.3 + 1.7)));
  } else if (aCol.a < 0.5) {
    // A face that makes its own light (alpha 0 in the shape): emissive(),
    // which is the row's haze and nothing else -- no tint, no silhouette,
    // because a lamp that dims as it comes towards you is not a lamp.
    c = mix(aCol.rgb, uFog, iLook.z);
  } else {
    // litColour(): the sky's tint, then the row's haze.
    c = mix(aCol.rgb * uTint, uFog, iLook.x);
    // ... and the silhouette, which goes to black over the last of its range.
    float sil = iLook.y;
    float toBlack = sil <= uBlackAt ? 0.0 : (sil - uBlackAt) / (1.0 - uBlackAt);
    c = mix(c, uSil * (1.0 - toBlack), sil);
  }
  // How much of it shows: 1, except for a glowing copy laid over its plain
  // original (see drawModel's fade).
  vCol = vec4(clamp(c, 0.0, 1.0), a);
}`;

// The fragment side is a flat colour -- except for paper. A model that asks
// for it (uGrain above zero: the phoenix) takes a faint grain, worked out
// from where the fragment is on the model rather than on the screen, so it
// is fixed to the paper and moves with it instead of swimming over it. Two
// scales of smooth noise: a fine tooth, and longer fibres laid along the
// sheet. Everything else passes zero and skips it.
const FS = `#version 300 es
precision highp float;
in vec4 vCol;
in vec3 vLocal;
uniform float uGrain;
uniform float uFlame;
out vec4 oCol;
float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
                 mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                 mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
  vec4 c = vCol;
  if (uGrain > 0.0) {
    float g = noise(vLocal * 48.0) * 0.55 + noise(vLocal * vec3(110.0, 110.0, 14.0)) * 0.45;
    c.rgb *= 1.0 + uGrain * (g - 0.5) * 2.0;
  }
  // Fire goes on premultiplied and a little brighter than it covers, which
  // is the glow: the colour behind is kept by less than the flame's own
  // share, so the two add up to more than either. See drawTurned.
  if (uFlame > 0.0) c = vec4(c.rgb * c.a * 1.25, c.a * 0.8);
  oCol = c;
}`;

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
const INST_FLOATS = 7;            // x, y, z, haze, silhouette, haze unstepped, fade
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
    for (const name of ['uProj', 'uScreen', 'uDepth', 'uTint', 'uFog', 'uSil', 'uBlackAt', 'uPull', 'uRot', 'uGrain', 'uFlame', 'uTime']) {
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

    // A second arrangement of the same shapes, for single draws that are
    // turned by a matrix: no per-copy attributes, whose values are set as
    // constants for each draw instead. See drawTurned.
    this.vaoOne = gl.createVertexArray();
    gl.bindVertexArray(this.vaoOne);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(aLocal);
    gl.vertexAttribPointer(aLocal, 3, gl.FLOAT, false, MODEL_STRIDE, 0);
    gl.enableVertexAttribArray(aCol);
    gl.vertexAttribPointer(aCol, 4, gl.UNSIGNED_BYTE, true, MODEL_STRIDE, 12);

    gl.bindVertexArray(null);
    rd.restore();
    this.rot = new Float32Array(9);
    this.identity = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // This frame's copies, grouped by shape: the solid ones, and the glowing
    // copies laid over them, which are drawn second and blended.
    this.groups = new Map();       // Model -> number[] of instance floats
    this.overlays = new Map();
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
    let glow = false, alpha = null;
    const put = (i, col, k) => {
      const fi = w * 4;
      this.shapeF32[fi] = v[i * 3] / TILE;
      this.shapeF32[fi + 1] = v[i * 3 + 1] / TILE;
      this.shapeF32[fi + 2] = v[i * 3 + 2] / TILE;
      const bi = w * MODEL_STRIDE + 12;
      this.shapeU8[bi] = col[0];
      this.shapeU8[bi + 1] = col[1];
      this.shapeU8[bi + 2] = col[2];
      // Alpha carries one of two things: for a flame, how solid the corner
      // is; otherwise whether the face makes its own light (0) or not.
      this.shapeU8[bi + 3] = alpha ? Math.round(alpha[k] * 255) : glow ? 0 : 255;
      w++;
    };
    for (const f of model.faces) {
      glow = f.glow === true;
      alpha = model.flame ? f.alpha : null;
      // A face may carry a colour for each corner (the phoenix's heat).
      const cs = f.cols;
      for (let k = 1; k + 1 < f.idx.length; k++) {
        put(f.idx[0], cs ? cs[0] : f.col, 0);
        put(f.idx[k], cs ? cs[k] : f.col, k);
        put(f.idx[k + 1], cs ? cs[k + 1] : f.col, k + 1);
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
  add(model, vx, vy, vz, fog, sil, fade = 1) {
    if (!this.ok || this.count >= MAX_INSTANCES) return false;
    if (!this.shape(model)) return false;
    const groups = fade >= 0.999 ? this.groups : this.overlays;
    let list = groups.get(model);
    if (!list) groups.set(model, list = []);
    // The haze in the same steps litColour() uses, so the two paths agree;
    // a light takes it unstepped, as emissive() does.
    const q = fog > 0.01 ? Math.round(fog * FOG_STEPS) / FOG_STEPS : 0;
    // A glowing copy of an open shape -- a balloon's envelope -- was laid on
    // twice by the painter's order, far side and near, and a lit envelope is
    // meant to look like that: light through paper. The depth test keeps
    // only the near side here, so it carries both layers' worth.
    let a = fade;
    if (a < 0.999 && model.solid !== true) a = a * (2 - a);
    list.push(vx / TILE, vy / TILE, vz / TILE, q, sil > 0.01 ? sil : 0,
              fog > 0.01 ? fog : 0, a >= 0.999 ? 1 : a);
    this.count++;
    return true;
  }

  // Send up any shapes first asked for since the last draw.
  upload() {
    if (!this.shapeDirty) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.shapeU8, 0, this.shapeVerts * MODEL_STRIDE);
    prof.count('upload KB', this.shapeVerts * MODEL_STRIDE / 1024);
    this.shapeDirty = false;
  }

  uniforms(pull, rot, grain = 0, flame = 0) {
    const gl = this.gl;
    gl.uniform4f(this.u.uProj, CENTRE_X, CENTRE_Y, FOCAL_X, FOCAL_Y);
    gl.uniform2f(this.u.uScreen, SCREEN_W, SCREEN_H);
    gl.uniform2f(this.u.uDepth, DEPTH.A, DEPTH.B / TILE);
    gl.uniform3f(this.u.uTint, sky.tint[0], sky.tint[1], sky.tint[2]);
    gl.uniform3f(this.u.uFog, sky.fog[0] / 255, sky.fog[1] / 255, sky.fog[2] / 255);
    silhouetteDark(this.silOut);
    gl.uniform3f(this.u.uSil, this.silOut[0] / 255, this.silOut[1] / 255, this.silOut[2] / 255);
    gl.uniform1f(this.u.uBlackAt, SIL_BLACK_AT);
    gl.uniform1f(this.u.uPull, pull);
    gl.uniformMatrix3fv(this.u.uRot, false, rot);
    gl.uniform1f(this.u.uGrain, grain);
    gl.uniform1f(this.u.uFlame, flame);
    gl.uniform1f(this.u.uTime, (sky.tick % 100000) / 50);
  }

  // One model, turned by `m` (row-major, as matFromAim and matMul make them)
  // and standing at a camera-relative fixed-point position: the bird, whose
  // body and wings were the largest single cost left on the CPU with the
  // JavaScript JIT off -- 424 faces rotated, projected, sorted and written
  // out every frame.
  //
  // It is drawn over everything painted so far, as drawModel drew it, and
  // sorts its own faces with the depth buffer rather than by hand: `fresh`
  // clears the depth first, which the first of a set of pieces asks for so
  // that the rest are tested against it and not against the landscape. The
  // landscape's depth is finished with by the time the bird is drawn.
  // Returns false when this path cannot take it, for the caller to fall back.
  drawTurned(model, m, vx, vy, vz, fresh) {
    if (!this.ok) return false;
    const shape = this.shape(model);
    if (!shape) return false;
    const rd = this.rd, gl = this.gl;
    rd.flush();
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vaoOne);
    this.upload();
    // Column-major for GLSL, from the row-major matrix drawModel applies.
    const r = this.rot;
    r[0] = m[0]; r[1] = m[3]; r[2] = m[6];
    r[3] = m[1]; r[4] = m[4]; r[5] = m[7];
    r[6] = m[2]; r[7] = m[5]; r[8] = m[8];
    this.uniforms(0, r, model.grain || 0, model.flame ? +model.flame : 0);
    gl.vertexAttrib3f(this.iAt, vx / TILE, vy / TILE, vz / TILE);
    gl.vertexAttrib4f(this.iLook, 0, 0, 0, 1);
    rd.depthMode('test');
    if (fresh) {
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
    }
    if (model.flame) {
      // Over what is already there, premultiplied, tested against the bird's
      // own depth but not written: it is see-through, and nothing behind it
      // should be hidden by it.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.drawArrays(gl.TRIANGLES, shape.first, shape.count);
    if (model.flame) {
      gl.depthMask(true);
      if (rd.blendMode === 'add') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    prof.count('draw calls', 1);
    rd.drawn = (rd.drawn || 0) + shape.count;
    gl.bindVertexArray(null);
    rd.restore();
    rd.depthMode('off');
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
    this.upload();

    // Lay every group's copies end to end and send them up once.
    let at = 0;
    const ranges = [];
    let overlaysFrom = -1;
    for (const groups of [this.groups, this.overlays]) {
      if (groups === this.overlays) overlaysFrom = ranges.length;
      for (const [model, list] of groups) {
        if (!list.length) continue;
        this.inst.set(list, at);
        ranges.push(model, at, list.length / INST_FLOATS);
        at += list.length;
        list.length = 0;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, at);
    prof.count('upload KB', at * 4 / 1024);

    this.uniforms(PULL, this.identity);

    // An opaque pass first: nothing in it is see-through.
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
      // Then the glowing copies, over the solid shapes they copy: blended,
      // and tested but not written, so each lands exactly on its original --
      // the same corners through the same arithmetic come out at the same
      // depth -- and not on anything nearer.
      if (r === overlaysFrom) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      }
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
      gl.vertexAttribPointer(this.iLook, 4, gl.FLOAT, false, INST_FLOATS * 4, byte + 12);
      gl.drawArraysInstanced(gl.TRIANGLES, shape.first, shape.count, ranges[r + 2]);
      prof.count('draw calls', 1);
      rd.drawn = (rd.drawn || 0) + shape.count * ranges[r + 2];
    }
    if (overlaysFrom >= 0 && overlaysFrom < ranges.length) {
      gl.depthMask(true);
      if (rd.blendMode === 'add') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    }
    this.count = 0;

    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(null);
    rd.restore();
  }
}
