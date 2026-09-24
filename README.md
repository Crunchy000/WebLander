# WebLander

**[▶ Play it](https://crunchy000.github.io/WebLander/)**

A browser tribute to **Lander**, the flat-shaded 3D game David Braben wrote for
the Acorn Archimedes in 1987 and which shipped on the machine's application
discs.

Plain JavaScript and WebGL, no build step and no dependencies. Open the page
and fly. It works with a mouse, a keyboard, or by tilting a phone.

## Running it

ES modules need to be served over HTTP, so opening `index.html` straight off
the filesystem will not work. Any static server will do:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

Or drop the directory on any static host — GitHub Pages, Netlify, an S3
bucket. There is nothing to compile.

Pushes to `main` deploy automatically to GitHub Pages via
`.github/workflows/pages.yml`. Since there is no build step, the workflow's
useful job is to import every module for real before publishing, so a syntax
error or a bad import path fails the run rather than the site. The site it
publishes is staged by `scripts/assemble-web.mjs`, which copies out
`index.html`, `css/`, `js/`, `icons/` and `audio/` if it is there, and nothing
else -- the workflows, the README and the scripts themselves stay behind.

## Controls

|            | Steer                          | Thrust                | Hover        | Fire         |
|------------|--------------------------------|-----------------------|--------------|--------------|
| **Mouse**  | pointer position on the canvas | left button           | middle       | right        |
| **Keys**   | arrows / WASD                  | <kbd>Z</kbd> or space | <kbd>X</kbd> | <kbd>C</kbd> |
| **Phone**  | tilt the handset               | one finger, anywhere  | —            | second finger |

On a phone the screen is free of buttons: one finger anywhere fires the
engine, and putting a second finger down works the gun.

The gun points out through the ship's nose, so aiming means leaning: level
flight shoots straight ahead, and tipping forward walks the shots down into
the landscape.

## What shoots back

**Tanks** rove the land and will only fire on a craft that has set down, so
charging in the open is a decision rather than a rest.

**Shipping** carries point defence, but only just: it reaches barely a tile
past the hull, so it is not an approach you have to respect, it is a place you
cannot sit. It spools up for two thirds of a second with the mounting glowing
before it fires, and it does not kill outright — **the airframe takes three**,
and the HUD grows a `HULL` row once any of them are gone. A damaged craft
trails smoke, and trails more of it the worse it is. A vessel needs about ten
seconds of you parked on top of her to land all three.

**Radar and missile sites** are the only thing in the game that punishes
altitude, and they are rare — two on the map, trickled in slowly, so meeting
one is a route to plan rather than a tax on flying.

A site sees what its dish can see, and nothing else. Three conditions: you
have to be **above the dish itself**, **more than two tiles off the surface
under you** — ground or water, whichever is there — and the **straight line
from the dish to you has to be clear** of hills, buildings, blocks and trees
alike.

So there are three ways past. Stay under the dish, which you can judge by eye
because the dish is right there on its plinth. Or hug the surface, inside the
two tiles of clutter, which works even where the ground you are over stands
higher than the site does. Or put something between the two of you — a ridge
will do it, and so will a big enough building.

The dish swings round to face you, the plinth lamps blink faster, the
HUD reads `RADAR` and fills a bar, and about four and a half seconds later you
get `SAM LOCK` and a round that has to turn to follow you — limited homing, so
it can be made to overshoot. Break the line and the lock decays, slower than
it built, so a bob up and straight back down still costs you.
Sites are static, worth more than anything else on the map, and the rounds
still on the rails go up with them.

The craft runs on a **battery, not fuel**. Set down anywhere the ground is
level enough to sit square on and it charges — the launchpad is simply the
best surface there is. Below a fifth the meter turns red, the label flashes
and the machine starts beeping, faster and higher the less there is left; it
stops the moment you are on the ground taking charge.

Running it flat is not the end of you. **Hold hover on an empty pack and the
rotors autorotate**, capping the descent at 0.94 tiles/s against a free fall's
2.0 — and the ground forgives anything under 1.56. Dropped onto the pad from
2 tiles/s: no buttons, crashed; hover held, landed. Full thrust gets you
nothing, because asking for everything is not how you ask for a glide. The
HUD swaps `BATTERY FLAT` for `AUTOROTATE` while it is working. It saves the
landing, not the route: a long glide over a forest can still put you into a
tree, and you steer it with the stick like anything else. But a grounded craft is a stationary target, and tanks
will open fire on one the moment their turret comes to bear. Charging in the
open is a decision, not a rest.

The first **five seconds of every life are free**: getting off the pad is the
fiddliest moment in the game, so during that window you can scrape the ground,
clip a tree or come down hard without losing a ship. The HUD counts it down.

Steering is by *position*, not rate: the bearing of the stick from centre
becomes the craft's heading, and how far you push it becomes how far its nose
drops. Thrust acts along the roof, so a nose-down attitude carries you along
the heading — trading lift for speed.

**Hover does not make that trade** — it keeps the height it is at. The
sky-facing share of its thrust goes on carrying the craft's weight rather than
on gaining altitude, so leaning buys speed and costs nothing: measured over
five seconds at 0°, 19° and 45° of lean, the drift is zero tiles in all three.
Arriving at a hover from a dive is a catch, not a wall — a 1 tile/s descent
stops in about a third of a second.

Below half a tile of clearance hover goes back to being a throttle, because a
hold cannot lift a machine that is already resting on its skids; from the pad
it flies you up to about three quarters of a tile and stops there. The same
rule means ground rising under you puts the throttle back in your hand rather
than flying you into it.

So the vertical control is three-way: **full thrust climbs, hover holds,
nothing descends.** Both lean the same distance, all the way round: hover
used to be capped at 45° and barred from looping, but since it carries the
craft's weight whatever the lean, the cap bought no safety, only a machine
that handled differently depending on which power it was on.

There is no separate turn control, because steering *is* turning. The craft
swings to face wherever you are steering, and since the gun fires along the
nose, aiming and flying are one action. Centre the stick and it holds its
heading rather than snapping back.

That position-based scheme is why phone tilt fits so naturally: the original
was flown from an absolute mouse position, and a tilt sensor is the same kind
of input. Tap Start while holding the phone comfortably to set the neutral
position. Tipping the far edge of the handset down flies away from you.

### Tilt is calibrated, not guessed

Working out which way a phone is tilted from `deviceorientation` is a thicket.
`beta` and `gamma` are reported in the handset's own frame, the screen
orientation angle is defined differently across platforms, and none of it
knows how the player is actually holding the thing. Every fixed formula is a
guess that is wrong on some devices.

So the game does not guess. On first run it asks you to demonstrate two
directions — *away from me* and *to my right* — and those two vectors become
the basis it solves against:

```
B = [ right.gamma  away.gamma ]        stick = B⁻¹ · (tilt − neutral)
    [ right.beta   away.beta  ]
```

Whatever the sensor reports, whichever way up the phone is, however it is
held, the mapping comes out right because it was measured. The demonstrated
throw also sets the sensitivity, so a small flick and a big heave both give
controls that suit the person who calibrated them.

The demonstration steps capture themselves once a tilt is held still for about
half a second — tapping while holding the phone at an angle would mean looking
away from the screen at the moment it matters. Between the two demonstrations
there is a confirmation step, and a step will not capture anything until the
handset has come back near centre, so the tilt left over from the previous
answer is never read as the next one. Calibration is saved, and can be redone
from the title card.

If the device has no motion sensor, or permission is refused, steering falls
back to dragging on the screen and an on-screen thrust pad appears.

## How it works

### The landscape is a formula, not data

Ground height at any point is a closed-form sum of six sine waves:

```
altitude(x, z) = LAND_MID_HEIGHT
               - (  sin(x − 2z) + sin(4x + 3z) + sin(3z − 5x) + sin(7x + 5z)
                  + ½·sin(5x + 11z) + ½·sin(10x + 7z) )
```

Nothing is stored and nothing is generated ahead of time, so the world is
infinite and seamless, and flying costs no memory. Because world coordinates
are 8.24 fixed point, the space wraps every 256 tiles — the map is a torus.

### It is all integer arithmetic

World coordinates are int32s, and JavaScript's bitwise operators are defined
on exactly that, which makes them a direct stand-in for ARM registers. This is
not nostalgia: the tile colours are derived from the *low bits* of the
fixed-point altitude, so the ground only comes out correctly mottled —
green flecked with red-brown dirt — if the arithmetic truncates the way it did
on an ARM2. Colours are then packed into an 8-bit VIDC palette byte and
expanded back to RGB, because that quantisation (the low two bits are shared
between all three channels) is a large part of the look.

### The camera never rotates

There is no view matrix anywhere in the code. The eye sits at a fixed height —
the altitude of the tallest possible peak — and looks straight ahead. The
downward view comes entirely from the screen centre being set high, at y = 64
of 256, rather than from any rotation. Projection is just:

```
screen = centre + focal · v / z
```

The visible landscape is a fixed grid of tile corners anchored to the camera;
the world slides through it as you fly, which is why the horizon never moves
and why drawing costs the same every frame wherever you are.

### The hull

The lander is built entirely from flat panels meeting at hard angles, with a
sharp chine running round its waist where the upper and lower facets join,
swept fins at the hips and a cannon out of the nose. There is no
undercarriage — it sets down on its keel, which is why the belly reaches
exactly `UNDERCARRIAGE_Y` below the centre. It
suits the renderer: flat shading is all this thing does, so a shape made only
of flat panels reads exactly as intended, each facet catching the light
differently.

Facet colours are computed at build time from each face's own normal rather
than picked by hand, with the normal flipped outward where the winding runs
the wrong way — the model is drawn without backface culling, so winding is
otherwise free to be inconsistent. The ambient floor is set deliberately high:
the camera rides at the craft's own altitude, so the facets usually on show
are the flanks and underside, which a purely directional light would leave in
shadow and a black sky would then swallow.

### Rendering

Everything — landscape, ship, scenery, particles, HUD text — is projected on
the CPU into 320×256 pixel space and pushed into a single vertex buffer, then
drawn in one `drawArrays` call. There is no depth buffer: the game sorts back
to front and OpenGL rasterises primitives in submission order, so the
original's painter's algorithm survives the port intact. The canvas is a true
320×256 buffer scaled up with `image-rendering: pixelated`, so it looks like a
1987 monitor rather than a blurry interpolation of one.

Typical frame: about 2,000 triangles, one draw call. It holds 60fps even under
software rasterisation, so a phone GPU does not notice it.

## Layout

| File | |
|---|---|
| `js/maths.js` | fixed point, sine table, rotation matrices, hashing |
| `js/landscape.js` | the altitude formula and VIDC tile colours |
| `js/renderer.js` | WebGL batcher and the projection |
| `js/model.js` | flat-shaded polygon model primitives |
| `js/modelpass.js` | scenery drawn on the GPU: shapes uploaded once, positioned per instance |
| `js/objects.js` | scenery models and the stateless object map |
| `js/tanks.js` | roving armour, their gunnery and their destruction |
| `js/boats.js` | canoes on the sea, the one moving thing left out there |
| `js/sam.js` | radar and missile sites, and what they do to anyone flying high |
| `js/player.js` | faceted hull, flight physics, collisions |
| `js/particles.js` | exhaust, bullets, explosions, smoke, spray |
| `js/ribbon.js` | the streamer trailing the craft; a light trail after dark |
| `js/balloons.js` | balloons in pairs, and the bunting slung between them |
| `js/lanterns.js` | paper lanterns adrift on the water, lit after dark |
| `js/flowers.js` | folded paper tulips scattered over the ground, and their nectar |
| `js/ridges.js` | parallax silhouette ranges along the horizon |
| `js/style.js` | the palette transform the serene style is made of |
| `js/music.js` | the soundtrack, if there is one |
| `js/input.js` | mouse, keyboard, touch and tilt |
| `js/audio.js` | synthesised sound, no assets |
| `js/font.js` | 5×8 bitmap font for the HUD, caps and lowercase |
| `js/game.js` | main loop, landscape scan, HUD, game states |
| `scripts/assemble-web.mjs` | stages the playable files for Pages |

## Differences from the original

- **Wider landscape.** The original draws a 12×10 tile grid; this uses 18×10 so
  the far row still spans a modern screen instead of tapering to a wedge. The
  original parameterises this (it sizes its corner store from the tile count),
  so it is a supported knob rather than a change of design.
- **Fixed 50 Hz simulation**, decoupled from the display refresh, with physics
  constants retuned to suit. The original's are per-frame on fixed hardware.
- **Scenery is placed by hashing tile coordinates** rather than from a stored
  object map, to match the infinite stateless landscape. Destroyed objects are
  the only world state the game keeps.
- **Object, ship and font models are original designs** in the spirit of the
  originals, not transcriptions.
- Added: tilt and multi-touch control, synthesised audio, a saved high score,
  and a five-second grace period at the start of each life.

## Credits

*Lander* was written by **David Braben** and is copyright © D.J. Braben, 1987.

This tribute referenced
[lander.bbcelite.com](https://lander.bbcelite.com/)
**Mark Moxon**

The code in this repository is a fresh implementation in JavaScript. It
contains none of the original program's code.
