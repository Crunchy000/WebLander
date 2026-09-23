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

## Reading a model you are not going to draw

`art/hummingbird.glb` could be drawn: 546 triangles, once a frame.
`art/tulip.glb` and `art/waterlily.glb` could not. Both arrived at about 14,700
triangles, and the game draws 67 flowers and 84 lilies in a view -- so
whatever geometry comes out of them has to cost about a dozen triangles, not
fourteen thousand.

The second set of scripts is for that case: take the measurements off the
scan, and build the small model to match.

    node peek.mjs                       # three flat-shaded views -- what is it?
    GEOM=x.json node split2.mjs         # one flower out of a bouquet of two
    TARGET=60 node cluster.mjs          # decimate, to see whether it survives
    node measure.mjs                    # bounds, and cross-section by height
    CUT=0.62 node paint.mjs             # the texture's own colours, by part

`cluster.mjs` is the decimator, and its answer for these two models was no.
Vertex clustering keeps a shape only while every feature is bigger than a
cell, and a tulip is a 0.3-wide bud on a 0.02-thick stem: at 219 triangles --
already seventeen times this game's budget for a flower -- the stem is gone,
the leaf has merged into it and the bud is a lump. A quadric edge-collapse
decimator would do better, and would still be spending 200 triangles on
something 20 pixels tall.

So `measure.mjs` and `paint.mjs` are what these models are actually for.
Between them they set the tulip's bud proportions and the lily's bloom and
cup in `js/flowers.js` and `js/lilies.js`, and the scarlet in the tulip
palette is `paint.mjs`'s answer for the bud, lifted into this palette's
range. The numbers are quoted in the comments where they are used.

## Where the frame goes

Two scripts, because there are two budgets and they behave nothing alike.

    node attrib.mjs                     # triangles by layer, at one spot
    SCENE=water PHASE=0.88 node attrib.mjs
    ROWS=256 node fill.mjs              # frames per second at a given size

`attrib.mjs` switches layers off one at a time through `window.__layers`,
which `Game.draw` consults, and counts the triangles that go missing. It
counts rather than times: the counts add up to the whole frame and repeat
exactly, while the milliseconds do not -- the GL queue drains between draws,
so a timing run picks up whatever the queue was already carrying, and the
parts come out summing to three times the whole.

`fill.mjs` flies the same thirty seconds at a given backing-store height.
On a machine without a GPU this is the measurement that matters, and it is
also the one that says least about a phone: SwiftShader rasterises in
software, so frames per second here tracks pixel count almost exactly, while
the thing a phone GPU is good at is precisely filling pixels.

## Checking a renderer change

    node culltest.mjs                   # same frame with and without culling
    node perfshot.mjs                   # the readout, and the console line

`culltest.mjs` renders the busiest stand of trees it can find twice, counts
the triangles each way and writes both frames out; the diff between them is
what says whether dropping the far side of a closed model is safe. It is how
the winding sign in `model.js` was chosen: one sign leaves 43,000 pixels
different, the other 618 out of 378,000, and only the second one is the
picture the game had before.

## The resolution adaptor

    node adapttest.mjs                  # the decision itself, no browser
    node adapt.mjs                      # a machine that cannot keep up
    node capped.mjs                     # ... and one that simply shows 30 a second

Two cases that have to end differently. `adapt.mjs` watches the backing
store on this container, which has no GPU: it should walk down a step at a
time and settle where the frames come in on time. `capped.mjs` wraps
requestAnimationFrame in a 33ms slot, the way a console browser locked to
thirty does, and the backing store should not move at all -- a cadence is not
a machine in trouble, and no amount of taking pixels away turns thirty into
sixty.

## How big is a clump?

    node clumps.mjs

Sweeps 160 tiles square, asks the flower layer whether each tile has
anything on it, and measures the connected runs. A screenshot cannot answer
this -- the meadow harness finds the thickest patch in the world by
construction, so every picture it takes looks like a field. The runs say
what the ground actually does: median 1 tile, ninetieth percentile 3,
biggest 12, over 5.6 per cent of the ground.

`adapttest.mjs` drives `adapt()` by hand against a made-up machine that holds
sixty at half size and exactly thirty at two thirds -- the shape of console
browser that made the adaptor step up on the comfortable reading, find the
step above too slow, step down, and go round for ever, resizing the canvas
each time. It asserts that the size stops moving.
