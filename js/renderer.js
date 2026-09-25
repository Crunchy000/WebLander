// renderer.js -- a painter's-algorithm triangle batcher on WebGL 2.
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

// The buffer is 256 rows tall, always. Everything placed in pixels -- the
// horizon line at 64, the parallax ranges, the HUD along the bottom -- is
// placed in those rows, and the landscape scan reaches from 26 tiles out to
// about 10, which is what fills them. Making it taller would mean drawing
// rows nearer than 10 tiles, and the near edge of the scan is what sets how
// far behind the craft the camera rides, so that is a change to the whole
// shape of the view rather than a change to the buffer.
//
// The width is whatever the display is. A fixed 456 is 16:9, and a phone
// held sideways is nearer 19.5:9, which left a black bar down each side --
// so the buffer is cut to the shape of the screen instead. Nothing stretches:
// the focal length is fixed, so a wider buffer shows more world either side,
// exactly as widening it to 16:9 did in the first place. The landscape grid
// widens to match -- see TILES_X.
const BASE_W = 456;
const BASE_H = 256;

// ... within reason at both ends. Past about 2.5:1 the extra is all sky and
// hillside a long way from anything you are doing, and landscape triangles to
// draw for it. Below about 4:3 the frame is too narrow to hold the wider
// lines of the HUD, and a portrait phone -- which is not how this is played
// -- would ask for a slot. Outside the range it letterboxes, as it always
// did.
const MAX_ASPECT = 2.5;
const MIN_ASPECT = 4 / 3;

// The window's shape, taken the long way over the short so that a phone
// gives the same number held either way round.
//
// It used to be settled once, as the page loaded, and never again. On a
// phone that is the worst possible moment to ask: the browser's own bars are
// still showing, so the window is shorter than the screen it will be played
// on, and once they went -- going fullscreen, or scrolling them away -- the
// game kept the shape it had been given and left bars down both sides. On
// one phone that was 370 of its 2400 pixels across. Now it is asked again
// whenever the window changes; see reshape() and Renderer.begin().
function displayAspect() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 0;
  const h = typeof window !== 'undefined' ? window.innerHeight : 0;
  if (!(w > 0 && h > 0)) return BASE_W / BASE_H;
  return Math.max(w, h) / Math.min(w, h);
}

function widthFor(aspect) {
  return Math.round(BASE_H * Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect)) / 2) * 2;
}

// Live bindings: they change when the window does, and every module that
// imports them sees the new value. Anything that sizes memory by the width
// sizes it by SCREEN_W_MAX instead, which never changes.
export const SCREEN_H = BASE_H;
export let SCREEN_W = widthFor(displayAspect());
export const SCREEN_W_MAX = widthFor(MAX_ASPECT);

// Screen centre for the projection. The horizontal centre is the middle of
// the screen, but the vertical centre sits high, at y = 64 -- that is what
// tips the view down over the landscape without the camera ever rotating.
export let CENTRE_X = SCREEN_W >> 1;

// Whoever derives something from the width and keeps it registers here, and
// is told when it changes. See landscape.js.
const shapeListeners = [];
export function onScreenShape(fn) {
  shapeListeners.push(fn);
}

// Measure the window again. True if the game's width changed.
function reshape() {
  const w = widthFor(displayAspect());
  if (w === SCREEN_W) return false;
  SCREEN_W = w;
  CENTRE_X = w >> 1;
  for (const fn of shapeListeners) fn();
  return true;
}
export const CENTRE_Y = 64;

// Focal length, in pixels. It is deliberately NOT adjusted for the wider
// screen: widening the buffer at a fixed focal length shows more world either
// side rather than stretching what was already there, which is the whole
// point. The landscape grid was widened to match -- see TILES_X.
export const FOCAL_X = 512;
export const FOCAL_Y = 512;

// How much bigger than the display to draw, and it depends on the display.
//
// A display at more than one device pixel to the point is already past the
// size where an edge reads as a staircase, so it gets one to one and spends
// nothing on smoothing it further. A monitor at exactly one is not, so it
// gets half again and the browser scales it down, which is antialiasing paid
// for in fill rate -- and fill rate is cheapest exactly where it is needed,
// because a display that sparse has few pixels to fill in the first place.
//
// The bar used to be two, which was wrong in the one place it mattered. A
// console browser on a 4K television reports a ratio of 1.5 and a CSS size of
// 1280x639: one and a half is plenty to hide a staircase, but it fell on the
// low side of the test and got another half again on top, asking for 2400
// pixels across where the panel it lands on has 1920. Half as much fill again
// as the display can even show.
const supersampleFor = (dpr) => (dpr > 1.25 ? 1 : 1.5);

// The tallest backing store worth asking for, in real pixels. See resize().
const MAX_DEVICE_H = 1200;

// ... and how far below that the game is allowed to drop itself when the
// machine cannot keep up. Each step is a little over half the pixels of the
// one before it.
const SCALES = [1, 0.8, 0.65, 0.5, 0.4];
const SLOW_MS = 21;             // a frame this long, a few checks running...
const FAST_MS = 13;             // ... and this short, for a good while, to go back up
const DOWN_CHECKS = 3;          // at four checks a second
const UP_CHECKS = 40;           // ... so ten seconds of comfort before trying again
// Going up and coming straight back down means that step does not hold here.
// Within this many checks of a rise, a fall makes the step above a ceiling
// and the size stops moving.
const REGRET_CHECKS = 60;

// ... unless the machine is not missing frames at all, but showing them at a
// slower cadence than sixty a second. A console browser pinned at thirty has
// a 33ms frame when everything about it is fine, and a fixed 21ms bar reads
// that as trouble and goes on taking pixels away for ever -- arriving at the
// smallest picture it is allowed to draw, still at thirty, because the cap
// was never about pixels.
//
// A cadence gives itself away by being exact. Every frame the same length,
// and that length one of the periods a display actually runs at; a machine
// that is genuinely short of fill misses frames unevenly and the spread
// between its quickest and its slowest is wide. So: tight spread and a
// recognisable period means leave it alone -- and give back any pixels that
// were taken away before it was recognised.
// Sixty, fifty and thirty a second. Twenty is not on the list and must not
// be: no display runs at it, so a machine sitting on a 50ms frame is a
// machine in trouble, and mistaking that for a cadence would leave it there.
const CADENCES = [16.67, 20, 33.33];
const CADENCE_SLOP = 2.5;
const CADENCE_TAIL = 1.3;       // ... and its slowest frames within this much of it

function lockedCadence(median, slowest) {
  for (const c of CADENCES) {
    if (Math.abs(median - c) < CADENCE_SLOP && slowest < c * CADENCE_TAIL) return c;
  }
  return 0;
}

const MAX_TRIS = 16384;
const FLOATS_PER_VERT = 4;   // x, y, depth, packed rgba
const VERTS_PER_TRI = 3;

// The one line of maths on the GPU: pixel space, origin top-left, to clip
// space. Written out twice because the two GL versions spell it differently
// -- `in`/`out` and a named output in GLSL ES 3.00, attribute/varying and
// gl_FragColor in 1.00 -- and a `#version` line has to be the first thing in
// the file, which is why these templates start hard against the backtick.
const BODY = `
  gl_Position = vec4(aPos.x * uScale.x - 1.0, 1.0 - aPos.y * uScale.y, aPos.z, 1.0);
  vCol = aCol;`;

const VERT_300 = `#version 300 es
in vec3 aPos;
in vec4 aCol;
out vec4 vCol;
uniform vec2 uScale;
void main() {${BODY}
}`;

const FRAG_300 = `#version 300 es
precision mediump float;
in vec4 vCol;
out vec4 oCol;
void main() { oCol = vCol; }`;

const VERT_100 = `
attribute vec3 aPos;
attribute vec4 aCol;
varying vec4 vCol;
uniform vec2 uScale;
void main() {${BODY}
}`;

const FRAG_100 = `
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
      // Off, and measured rather than assumed. Thirty seconds of flying at
      // 419 rows: 1750 frames without multisampling, 992 with it. The same
      // 419 rows drawn at one and a half times and scaled down -- two and a
      // quarter times the pixels, which is more work than 4x multisampling
      // asks for -- came back at 956. So multisampling costs about what
      // supersampling costs and buys less, and neither is free.
      //
      // Those numbers are software rendering: this machine has no GPU, and
      // filling pixels is the one thing that costs a real one almost nothing.
      // They are the right way round for choosing between the two and the
      // wrong way round for guessing at a phone.
      antialias: false,
      // A depth buffer, which this renderer went without for its whole life:
      // painter's order was enough while everything was drawn back to front
      // by hand. It is here so that things drawn on the GPU can be hidden by
      // the landscape the CPU painted -- see depthMode() for how the two
      // agree without the painted picture changing at all.
      depth: true,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    };
    this.canvas = canvas;
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;

    // WebGL 2 where there is one, WebGL 1 where there is not. Nothing here
    // needs 2 -- it is flat triangles and one uniform -- but it is what every
    // browser that matters has shipped for years, it gives the vertex array
    // object that holds the attribute layout instead of leaving it on the
    // global state, and it takes a length on bufferSubData, so the upload no
    // longer builds a throwaway typed-array view every time it draws. The 1
    // path stays because it costs four lines and an old phone is exactly the
    // sort of thing this game is for.
    const gl = canvas.getContext('webgl2', opts)
            || canvas.getContext('webgl', opts)
            || canvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    this.gl2 = typeof WebGL2RenderingContext !== 'undefined'
            && gl instanceof WebGL2RenderingContext;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, this.gl2 ? VERT_300 : VERT_100));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, this.gl2 ? FRAG_300 : FRAG_100));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    gl.useProgram(prog);

    this.aPos = gl.getAttribLocation(prog, 'aPos');
    this.aCol = gl.getAttribLocation(prog, 'aCol');
    this.uScale = gl.getUniformLocation(prog, 'uScale');
    gl.uniform2f(this.uScale, 2 / SCREEN_W, 2 / SCREEN_H);

    // One interleaved buffer: two floats of position plus four bytes of
    // colour per vertex, 12 bytes in all.
    this.stride = FLOATS_PER_VERT * 4;
    this.buffer = new ArrayBuffer(MAX_TRIS * VERTS_PER_TRI * this.stride);
    this.f32 = new Float32Array(this.buffer);
    this.u8 = new Uint8Array(this.buffer);
    this.count = 0; // vertices written

    // On 2, the attribute layout below is recorded in a vertex array object,
    // which stays bound for the life of the page. On 1 it lives on the
    // context's default state, which amounts to the same thing here since
    // nothing else ever binds a buffer.
    if (this.gl2) {
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
    }

    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.buffer.byteLength, gl.DYNAMIC_DRAW);

    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, this.stride, 0);
    gl.enableVertexAttribArray(this.aCol);
    gl.vertexAttribPointer(this.aCol, 4, gl.UNSIGNED_BYTE, true, this.stride, 12);

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
    // Whether anything in the batch being built is actually see-through.
    // Blending is a per-pixel read of what is already there, and for a batch
    // of opaque triangles that read is thrown away -- so the batch is drawn
    // with it switched off. Nothing about the picture changes, because
    // blending an opaque colour over anything gives the opaque colour.
    this.batchAlpha = false;
    this.blendOn = true;
    this.z = 1;
    this.depthState = 'off';
    this.drawn = 0;
    // Where the adaptor has got to, and how long it has been wanting to move.
    this.scaleAt = 0;
    this.want = 0;
    this.slow = 0;
    this.fast = 0;
    this.checks = 0;
    this.ceiling = 0;           // the largest picture still allowed
    // ... and the stylesheet needs the shape of it to letterbox correctly.
    document.documentElement.style.setProperty('--screen-aspect', String(SCREEN_W / SCREEN_H));

    this.resize();
    // A change of size is noted here and made at the top of the next frame
    // (see begin), for the same reason the adaptor's are: resizing a canvas
    // empties it, and one that is emptied after it was drawn is shown
    // blank. The window is watched as well as the canvas, because a window
    // that only gets wider may not change the canvas at all -- it is held
    // to the game's shape -- and that is exactly the case where the shape
    // wants changing.
    this.stale = false;
    const note = () => { this.stale = true; };
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(note);
      this.ro.observe(canvas);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', note);
      window.addEventListener('orientationchange', note);
      document.addEventListener('fullscreenchange', note);
      window.visualViewport?.addEventListener('resize', note);
    }
  }

  // How many real pixels the drawing lands in.
  //
  // This is not the same question as how big the game's buffer is, and
  // conflating the two is what made everything look like it was carved out of
  // Lego. SCREEN_W by SCREEN_H -- 586 by 256 -- is the space the game is
  // written in: every model, every font glyph, every HUD position and every
  // tuning number is in those units, and none of that changes here. But the
  // canvas's backing store was also 586 by 256, stretched up to the display
  // by the browser with image-rendering: pixelated, so a triangle edge that
  // crossed the screen at a shallow angle came out as a staircase with steps
  // eight device pixels tall.
  //
  // There was never any need for that. Nothing in this renderer is a bitmap:
  // it is flat triangles in a coordinate space, and the one uniform that maps
  // that space into clip space has no resolution in it at all. Rasterise the
  // same triangles into a backing store the size of the display and the same
  // picture arrives sharp, at the same cost in vertices and the same cost in
  // everything the game does before it gets here.
  //
  // Capped, because a phone reporting a device pixel ratio of four and a
  // browser happily handing out a 3376-pixel-wide buffer with multisampling
  // on top of it is a lot of fill for a machine that is also flying the game.
  // Twelve hundred rows is past the point where more of them shows.
  resize() {
    const canvas = this.canvas;
    const cssH = canvas.clientHeight || SCREEN_H;
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const step = SCALES[this.scaleAt || 0];
    let h = Math.round(cssH * Math.min(dpr, 3) * supersampleFor(dpr) * step);
    if (h > MAX_DEVICE_H) h = MAX_DEVICE_H;
    if (h < SCREEN_H) h = SCREEN_H;
    const w = Math.round(h * (SCREEN_W / SCREEN_H));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  // Give ground, and take it back.
  //
  // What a machine can fill is not a thing this code can know in advance --
  // the same browser on the same screen is a different machine on a console,
  // a laptop on battery and a phone in a case -- so it is measured instead.
  // Handed the recent median frame time a few times a second, this walks the
  // backing store down a step when the frames are long and back up when they
  // are comfortably short, with the two thresholds far enough apart that it
  // settles rather than oscillates.
  //
  // Nothing about the game changes with it. The world is still drawn in the
  // same 586x256 coordinate space; only the number of real pixels it lands
  // in moves, so a step down costs sharpness and nothing else.
  adapt(stat) {
    // A backgrounded tab reports frames seconds long; that is not a machine
    // struggling, it is a machine not being asked.
    if (!stat || !stat.ready || stat.median > 250) return;
    const at = this.want === undefined ? (this.scaleAt || 0) : this.want;
    const locked = lockedCadence(stat.median, stat.slowest) !== 0;
    this.cadence = locked ? stat.median : 0;
    this.checks = (this.checks || 0) + 1;

    if (!locked && stat.median > SLOW_MS) {
      this.fast = 0;
      if (++this.slow >= DOWN_CHECKS && at < SCALES.length - 1) {
        this.slow = 0;
        // Coming down again soon after going up means the step above this
        // one does not hold on this machine. Remember it and stop offering
        // it: a picture that flickers between two sizes is worse than
        // either of them, and this is where that flicker comes from.
        if (this.checks - (this.wentUpAt || -1e9) < REGRET_CHECKS) this.ceiling = at + 1;
        this.want = at + 1;
      }
    } else if (locked || stat.median < FAST_MS) {
      this.slow = 0;
      if (++this.fast >= UP_CHECKS && at > (this.ceiling || 0)) {
        this.fast = 0;
        this.wentUpAt = this.checks;
        this.want = at - 1;
      }
    } else {
      this.slow = 0;
      this.fast = 0;
    }
  }

  // What the adaptor has settled on, for the readout.
  get scale() {
    return SCALES[this.scaleAt || 0];
  }

  begin(clear) {
    const gl = this.gl;
    // Any change of size happens here, at the top of a frame, and never
    // between one being drawn and being shown. Resizing a canvas throws its
    // contents away, so a resize after the drawing hands the compositor an
    // empty buffer -- one white frame, which is the flicker.
    let size = false;
    if (this.want !== undefined && this.want !== this.scaleAt) {
      this.scaleAt = this.want;
      size = true;
    }
    // The window has changed. If the game's shape has too, the projection
    // and the stylesheet need telling before the canvas is measured, so
    // that the measurement is of the new shape.
    if (this.stale) {
      this.stale = false;
      if (reshape()) {
        gl.useProgram(this.prog);
        gl.uniform2f(this.uScale, 2 / SCREEN_W, 2 / SCREEN_H);
        document.documentElement.style.setProperty('--screen-aspect', String(SCREEN_W / SCREEN_H));
      }
      size = true;
    }
    if (size) this.resize();
    gl.clearColor(clear[0] / 255, clear[1] / 255, clear[2] / 255, 1);
    // Depth writes have to be on for a depth clear to happen at all.
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.depthState = undefined;
    this.depthMode('off');
    this.z = 1;
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
    this.blendMode = mode;
    const gl = this.gl;
    if (mode === 'add') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  // Put the GL state back the way this renderer left it, after something else
  // -- the GPU model pass -- has used the context for a while. The program,
  // the attribute layout and the buffer it reads from are the renderer's;
  // blending is whatever the other pass left, so it is marked unknown and
  // the next batch sets it.
  restore() {
    const gl = this.gl;
    gl.useProgram(this.prog);
    if (this.gl2) gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    this.blendOn = !this.blendOn;
    const want = this.blendMode === 'add' || this.batchAlpha;
    if (want) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    this.blendOn = want;
  }

  // How the depth buffer takes part in what is drawn next.
  //
  // 'off'   -- not at all. The sky, the horizon, the overlays: all of it is
  //            painter's order and nothing else, as it always was.
  // 'paint' -- every fragment passes, and each one writes its depth. This is
  //            the landscape pass. The picture comes out exactly as painter's
  //            order makes it, because nothing is ever rejected -- but the
  //            buffer is left holding, at every pixel, the depth of whatever
  //            was painted there last, which in a correct painter's order is
  //            the nearest surface. That is what the GPU-drawn models test
  //            against afterwards.
  // 'test'  -- the ordinary thing: nearer wins.
  //
  // Like blend(), a change of mode closes the batch; order survives it.
  depthMode(mode) {
    if (mode === this.depthState) return;
    this.flush();
    this.depthState = mode;
    const gl = this.gl;
    if (mode === 'off') {
      gl.disable(gl.DEPTH_TEST);
    } else {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(mode === 'paint' ? gl.ALWAYS : gl.LEQUAL);
      gl.depthMask(true);
    }
  }

  // Append one vertex. Colour components are 0-255, and so is alpha -- which
  // a colour may carry as a fourth entry, or leave out to mean opaque.
  vertex(x, y, r, g, b, a, z = this.z) {
    const i = this.count;
    const fi = i * FLOATS_PER_VERT;
    this.f32[fi] = x;
    this.f32[fi + 1] = y;
    this.f32[fi + 2] = z;
    const bi = i * this.stride + 12;
    this.u8[bi] = r;
    this.u8[bi + 1] = g;
    this.u8[bi + 2] = b;
    const alpha = a === undefined ? 255 : a;
    this.u8[bi + 3] = alpha;
    if (alpha < 255) this.batchAlpha = true;
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

  // The same two, with a depth at every corner. Everything else takes the
  // renderer's current depth, `z`, which a caller sets once for a run of
  // flat things lying at one distance -- a shadow, a reflection, a row.
  triZ(x0, y0, z0, x1, y1, z1, x2, y2, z2, col) {
    if (this.full) return;
    const r = col[0], g = col[1], b = col[2], a = col[3];
    this.vertex(x0, y0, r, g, b, a, z0);
    this.vertex(x1, y1, r, g, b, a, z1);
    this.vertex(x2, y2, r, g, b, a, z2);
  }

  quadZ(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, col) {
    if (this.full) return;
    const r = col[0], g = col[1], b = col[2], a = col[3];
    this.vertex(x0, y0, r, g, b, a, z0);
    this.vertex(x1, y1, r, g, b, a, z1);
    this.vertex(x2, y2, r, g, b, a, z2);
    this.vertex(x0, y0, r, g, b, a, z0);
    this.vertex(x2, y2, r, g, b, a, z2);
    this.vertex(x3, y3, r, g, b, a, z3);
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
    // Upload only the slice we actually filled. WebGL 2 takes the length as an
    // argument; WebGL 1 has to be handed a view of the right size, which means
    // allocating one per draw.
    // An additive batch is blending by definition; an 'over' batch only
    // needs it if something in it carries alpha.
    const wantBlend = this.blendMode === 'add' || this.batchAlpha;
    if (wantBlend !== this.blendOn) {
      if (wantBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
      this.blendOn = wantBlend;
    }
    const floats = this.count * FLOATS_PER_VERT;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (this.gl2) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, floats);
    else gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(this.buffer, 0, floats));
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    // Those vertices have been handed over, so the batch starts again from
    // empty. It used to be left standing and cleared by whoever called --
    // blend() did, begin() did, and the end-of-frame flush did not, so
    // triangleCount added the last batch to itself and every figure taken
    // after a frame was drawn came out that much too high.
    this.drawn = (this.drawn || 0) + this.count;
    this.count = 0;
    this.batchAlpha = false;
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

// View distance to depth, the same way a perspective matrix would do it --
// affine in 1/distance, which is what makes a depth worked out at a corner on
// the CPU interpolate across a painted triangle exactly as the GPU would
// interpolate the same corner's depth for itself. Near is the projection's own
// near plane; far is well past the back of the landscape, so nothing that is
// drawn with depth can fall off the end of it.
const DEPTH_FAR = 64 * 0x01000000;
const DEPTH_A = (DEPTH_FAR + 0x00040000) / (DEPTH_FAR - 0x00040000);
const DEPTH_B = (-2 * DEPTH_FAR * 0x00040000) / (DEPTH_FAR - 0x00040000);
export function depthOf(vz) {
  if (vz <= 0x00040000) return -1;
  const d = DEPTH_A + DEPTH_B / vz;
  return d > 1 ? 1 : d;
}
export const DEPTH = { A: DEPTH_A, B: DEPTH_B, NEAR: 0x00040000, FAR: DEPTH_FAR };

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
