# tools

The game has no build step and this does not change that. These are the
one-off scripts that turned `art/hummingbird.glb` into `js/origami-data.js`,
kept so the conversion can be rerun or pointed at another model rather than
being a thing that happened once on somebody's laptop.

`art/hummingbird.glb` is the decimated export the game's geometry comes from
(546 triangles, Draco-compressed, 512px WebP texture). `art/hummingbird-full.glb`
is the original it was decimated from: 139,450 triangles and a 1024px PNG,
far too dense to draw but the better thing to read colour off, which is what
`sample2.mjs` does.

Run them in order, from a directory with `draco3d` installed
(`npm install draco3d`), with the Playwright that this repo already uses
available for the two that need a browser:

    node decode.mjs path/to/model.glb   # Draco -> geom.json, and the textures
    TEX=big0.png K=14 node sample2.mjs  # bakes the texture -> cols.json
    SCALE=1.30 node gen.mjs             # -> data.js, the arrays to paste in

`decode.mjs` needs draco3d because the export is Draco-compressed.
`sample2.mjs` needs a browser because Chromium was the image decoder already
to hand. It averages each triangle over a barycentric grid rather than point
sampling it, discards the samples that disagree with the rest (a UV seam, a
pixel of background), and then k-means the 546 answers down to a palette of
fourteen. `sample.mjs` is the first version, kept because it is three lines
and shows what the difference bought. `gen.mjs` welds the vertices, turns
the axes into this engine's, splits the mesh into a body and two wings by
where each triangle sits, and writes each wing relative to its own shoulder.

The three-view renderer used to work out which way round the model was
(`look.mjs`) and the segmentation preview (`split.mjs`) are not here: they
answered their question once and the answer is in `js/origami.js`.
