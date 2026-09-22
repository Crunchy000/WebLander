# tools

The game has no build step and this does not change that. These are the
one-off scripts that turned `art/hummingbird.glb` into `js/origami-data.js`,
kept so the conversion can be rerun or pointed at another model rather than
being a thing that happened once on somebody's laptop.

Run them in order, from a directory with `draco3d` installed
(`npm install draco3d`), with the Playwright that this repo already uses
available for the two that need a browser:

    node decode.mjs path/to/model.glb   # Draco -> geom.json, and the textures
    node sample.mjs                     # bakes the texture -> cols.json
    SCALE=1.30 node gen.mjs             # -> data.js, the arrays to paste in

`decode.mjs` needs draco3d because the export is Draco-compressed.
`sample.mjs` needs a browser because the texture is WebP and Chromium is the
WebP decoder that was already to hand. `gen.mjs` welds the vertices, turns
the axes into this engine's, splits the mesh into a body and two wings by
where each triangle sits, and writes each wing relative to its own shoulder.

The three-view renderer used to work out which way round the model was
(`look.mjs`) and the segmentation preview (`split.mjs`) are not here: they
answered their question once and the answer is in `js/origami.js`.
