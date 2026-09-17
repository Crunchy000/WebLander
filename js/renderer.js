// renderer.js -- a painter's-algorithm triangle batcher on WebGL.
//
// Everything the game draws -- landscape tiles, ship, scenery, particles,
// HUD -- ends up as flat-shaded triangles in 456x256 *pixel* space. The
// projection is done on the CPU (it is only a few hundred vertices, and doing
// it here keeps it identical to the original's), so the GPU's only job is to
// fill triangles in the order it is handed them.
//
// There is no depth buffer, deliberately. The game already sorts back to
// front, and OpenGL guarantees primitives are rasterised in submission order,
// so painter's algorithm survives the port intact -- including the places
// where it is technically wrong and the original just lived with it.

export const SCREEN_W = 456;
export const SCREEN_H = 256;

// Screen centre for the projection. The horizontal centre is the middle of
// the screen, but the vertical centre sits high, at y = 64 -- that is what
// tips the view down over the landscape without the camera ever rotating.
export const CENTRE_X = 228;
export const CENTRE_Y = 64;

// Focal length, in pixels. It is deliberately NOT adjusted for the wider
// screen: widening the buffer at a fixed focal length shows more world either
// side rather than stretching what was already there, which is the whole
// point. The landscape grid was widened to match -- see TILES_X.
export const FOCAL_X = 512;
export const FOCAL_Y = 512;

const MAX_TRIS = 16384;
const FLOATS_PER_VERT = 3;   // x, y, packed rgb
const VERTS_PER_TRI = 3;

const VERT_SRC = `
attribute vec2 aPos;
attribute vec4 aCol;
varying vec4 vCol;
uniform vec2 uScale;
void main() {
  // Pixel space (0,0 top-left) -> clip space.
  gl_Position = vec4(aPos.x * uScale.x - 1.0, 1.0 - aPos.y * uScale.y, 0.0, 1.0);
  vCol = aCol;
}`;

const FRAG_SRC = `
precision mediump float;
varying vec4 vCol;
void main() { gl_FragColor = vCol; }`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class Renderer {
  constructor(canvas) {
    const opts = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    };
    // The buffer size is set here, not in the markup. They used to be written
    // in both places, and a browser holding a cached copy of this file while
    // serving fresh HTML got a canvas one size and a viewport another: the
    // clear filled the whole buffer with sky and the drawing only covered part
    // of it, leaving a solid slab of sky colour down one side. Sizing it from
    // the same constant the viewport uses means the two cannot disagree, and a
    // stale mix now just renders a narrower picture correctly.
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;

    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    gl.useProgram(prog);

    this.aPos = gl.getAttribLocation(prog, 'aPos');
    this.aCol = gl.getAttribLocation(prog, 'aCol');
    gl.uniform2f(gl.getUniformLocation(prog, 'uScale'), 2 / SCREEN_W, 2 / SCREEN_H);

    // One interleaved buffer: two floats of position plus four bytes of
    // colour per vertex, 12 bytes in all.
    this.stride = FLOATS_PER_VERT * 4;
    this.buffer = new ArrayBuffer(MAX_TRIS * VERTS_PER_TRI * this.stride);
    this.f32 = new Float32Array(this.buffer);
    this.u8 = new Uint8Array(this.buffer);
    this.count = 0; // vertices written

    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.buffer.byteLength, gl.DYNAMIC_DRAW);

    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, this.stride, 0);
    gl.enableVertexAttribArray(this.aCol);
    gl.vertexAttribPointer(this.aCol, 4, gl.UNSIGNED_BYTE, true, this.stride, 8);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    // Blending is on, but almost nothing uses it. Every colour in the game is
    // opaque -- the alpha byte has been 255 since the first commit -- so
    // switching this on changes not one pixel of the landscape, the models or
    // the HUD. It exists for the clouds, which are the only thing in the sky
    // you are supposed to be able to see through.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.blendMode = 'over';
    this.drawn = 0;
    gl.viewport(0, 0, SCREEN_W, SCREEN_H);

    // ... and the stylesheet needs the shape of it to letterbox correctly.
    document.documentElement.style.setProperty('--screen-aspect', String(SCREEN_W / SCREEN_H));
  }

  begin(clear) {
    const gl = this.gl;
    gl.clearColor(clear[0] / 255, clear[1] / 255, clear[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.count = 0;
    this.drawn = 0;
    this.blend('over');
  }

  // Switch how the next things drawn combine with what is under them.
  //
  // 'over' is ordinary alpha compositing and is what everything uses. 'add'
  // adds the colour instead, weighted by its alpha, which is what light does:
  // two beams crossing are brighter than either, and nothing drawn additively
  // can make the picture darker. It is the only honest way to draw something
  // that is emitting rather than reflecting.
  //
  // Changing the mode means the batch so far has to be drawn before the new
  // one starts, since a draw call has one blend mode for all of it. That is
  // the whole cost: one extra draw call per switch, against a frame that
  // otherwise makes one. Order survives it -- batches are drawn in the order
  // they were closed, and a painter's algorithm only ever asked for that.
  blend(mode) {
    if (mode === this.blendMode) return;
    this.flush();
    this.count = 0;
    this.blendMode = mode;
    const gl = this.gl;
    if (mode === 'add') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  // Append one vertex. Colour components are 0-255, and so is alpha -- which
  // a colour may carry as a fourth entry, or leave out to mean opaque.
  vertex(x, y, r, g, b, a) {
    const i = this.count;
    const fi = i * FLOATS_PER_VERT;
    this.f32[fi] = x;
    this.f32[fi + 1] = y;
    const bi = i * this.stride + 8;
    this.u8[bi] = r;
    this.u8[bi + 1] = g;
    this.u8[bi + 2] = b;
    this.u8[bi + 3] = a === undefined ? 255 : a;
    this.count = i + 1;
  }

  get full() {
    return this.count + 6 > MAX_TRIS * VERTS_PER_TRI;
  }

  tri(x0, y0, x1, y1, x2, y2, col) {
    if (this.full) return;
    const r = col[0], g = col[1], b = col[2], a = col[3];
    this.vertex(x0, y0, r, g, b, a);
    this.vertex(x1, y1, r, g, b, a);
    this.vertex(x2, y2, r, g, b, a);
  }

  // A quadrilateral, given in order around its perimeter.
  quad(x0, y0, x1, y1, x2, y2, x3, y3, col) {
    if (this.full) return;
    const r = col[0], g = col[1], b = col[2], a = col[3];
    this.vertex(x0, y0, r, g, b, a);
    this.vertex(x1, y1, r, g, b, a);
    this.vertex(x2, y2, r, g, b, a);
    this.vertex(x0, y0, r, g, b, a);
    this.vertex(x2, y2, r, g, b, a);
    this.vertex(x3, y3, r, g, b, a);
  }

  // A quad with a colour at each corner. The shader has always interpolated
  // per-vertex colour -- gradientBand relies on it -- this just stops flat
  // quads being the only way to reach it.
  quadShaded(x0, y0, c0, x1, y1, c1, x2, y2, c2, x3, y3, c3) {
    if (this.full) return;
    this.vertex(x0, y0, c0[0], c0[1], c0[2], c0[3]);
    this.vertex(x1, y1, c1[0], c1[1], c1[2], c1[3]);
    this.vertex(x2, y2, c2[0], c2[1], c2[2], c2[3]);
    this.vertex(x0, y0, c0[0], c0[1], c0[2], c0[3]);
    this.vertex(x2, y2, c2[0], c2[1], c2[2], c2[3]);
    this.vertex(x3, y3, c3[0], c3[1], c3[2], c3[3]);
  }

  // A vertical gradient band. The shader already interpolates per-vertex
  // colour, so a gradient costs exactly the same as a flat quad.
  gradientBand(y0, y1, colTop, colBottom) {
    if (this.full) return;
    const [r0, g0, b0] = colTop, [r1, g1, b1] = colBottom;
    this.vertex(0, y0, r0, g0, b0);
    this.vertex(SCREEN_W, y0, r0, g0, b0);
    this.vertex(SCREEN_W, y1, r1, g1, b1);
    this.vertex(0, y0, r0, g0, b0);
    this.vertex(SCREEN_W, y1, r1, g1, b1);
    this.vertex(0, y1, r1, g1, b1);
  }

  // An axis-aligned rectangle in pixel space -- particles and HUD furniture.
  rect(x, y, w, h, col) {
    this.quad(x, y, x + w, y, x + w, y + h, x, y + h, col);
  }

  flush() {
    const gl = this.gl;
    if (this.count === 0) return;
    // Upload only the slice we actually filled.
    const view = new Float32Array(this.buffer, 0, this.count * FLOATS_PER_VERT);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, view);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    this.drawn = (this.drawn || 0) + this.count;
  }

  // Triangles in the frame, counting the ones already sent. A mid-frame blend
  // switch empties the batch, so the pending count alone would under-report.
  get triangleCount() {
    return ((this.drawn || 0) + this.count) / 3;
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

// Project a camera-relative fixed-point coordinate onto the screen.
//
// Returns false if the point is behind or too close to the camera, in which
// case the caller drops whatever it was drawing -- the original has no
// near-plane clipper either, it simply discards offending vertices, which is
// why things vanish abruptly as they pass the camera.
const NEAR = 0x00040000; // 1/64 tile

export function project(vx, vy, vz, out) {
  if (vz < NEAR) return false;
  out.x = CENTRE_X + (vx * FOCAL_X) / vz;
  out.y = CENTRE_Y + (vy * FOCAL_Y) / vz;
  return true;
}

// Scale factor for something at distance vz: how many pixels one fixed-point
// unit covers. Used to size particles and to cull offscreen work.
export function projScale(vz) {
  return vz < NEAR ? 0 : FOCAL_X / vz;
}
