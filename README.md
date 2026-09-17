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
`index.html`, `css/`, `js/` and `icons/` and nothing else -- the repository
now holds a Rust crate and a flatpak manifest too, and neither belongs on the
web.

## As a desktop app

There is an optional [Tauri](https://tauri.app) shell in `src-tauri/`: a
native window with the same `js/` inside it. It adds nothing to the game and
the game knows nothing about it, so the two cannot drift apart.

```sh
npm install
npm run desktop:dev      # a window, with the assemble step run for you
npm run desktop:build    # .deb and .AppImage in src-tauri/target/release/bundle
```

Building on Linux needs the system webview and its development headers --
on Ubuntu, `libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev
libssl-dev libgtk-3-dev build-essential pkg-config file`.

### Flatpak

`flatpak/io.github.crunchy000.WebLander.yml` does not compile anything: it
unpacks the `.deb` the Tauri build has already made. Building the crate a
second time inside flatpak-builder would mean vendoring the whole cargo tree
for a binary no different from the one already sitting there.

```sh
npm run desktop:build
cp src-tauri/target/release/bundle/deb/*.deb flatpak/weblander.deb
cd flatpak
flatpak-builder --force-clean --user --install build-dir \
  io.github.crunchy000.WebLander.yml
flatpak run io.github.crunchy000.WebLander
```

The GNOME runtime is what supplies WebKitGTK 4.1, which is the webview Tauri
links against; that is the reason for choosing it over the freedesktop
runtime, which has no webview at all. The sandbox is opened just far enough
for the game: `--device=dri` for WebGL, `--device=input` for gamepads and
`--socket=pulseaudio` for the engine and the weather.

`.github/workflows/desktop.yml` does all of this on every push: bundle first,
then flatpak from the bundle it just made.

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

The craft runs on a **battery, not fuel**. Set down anywhere the ground is
level enough to sit square on and it charges — the launchpad is simply the
best surface there is. Below a fifth the meter turns red, the label flashes
and the machine starts beeping, faster and higher the less there is left; it
stops the moment you are on the ground taking charge. But a grounded craft is a stationary target, and tanks
will open fire on one the moment their turret comes to bear. Charging in the
open is a decision, not a rest.

The first **five seconds of every life are free**: getting off the pad is the
fiddliest moment in the game, so during that window you can scrape the ground,
clip a tree or come down hard without losing a ship. The HUD counts it down.

Steering is by *position*, not rate: the bearing of the stick from centre
becomes the craft's heading, and how far you push it becomes how far its nose
drops. Thrust acts along the roof, so a nose-down attitude carries you along
the heading — trading lift for speed.

**Hover does not make that trade.** It holds the craft inside 45° of lean and
divides its thrust by the cosine of it, so the share pointing at the sky stays
the same however far you are tipped over: lean on hover buys speed and costs
no height. Full thrust is the opposite and is left alone — it reaches 90°, and
past about 78° of that there is not enough lift left to hold you up. One
setting to place the craft with, one to fly it with.

The lean limit **latches on the last thrust you asked for** rather than
lasting only while the button is down. Tap hover and the craft stays a 45°
machine while you coast; tap full thrust and it is a 90° one again. Handling
that changed under you every time you eased off the power would spring its
surprise at the moment you could least afford one.

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
| `js/objects.js` | scenery models and the stateless object map |
| `js/tanks.js` | roving armour, their gunnery and their destruction |
| `js/boats.js` | shipping on the sea, and sinking it |
| `js/player.js` | faceted hull, flight physics, collisions |
| `js/particles.js` | exhaust, bullets, explosions, smoke, spray |
| `js/input.js` | mouse, keyboard, touch and tilt |
| `js/audio.js` | synthesised sound, no assets |
| `js/font.js` | 5×7 bitmap font for the HUD |
| `js/game.js` | main loop, landscape scan, HUD, game states |
| `scripts/assemble-web.mjs` | stages the playable files, for Pages and for Tauri alike |
| `src-tauri/` | the desktop shell: a window round the same web build |
| `flatpak/` | flatpak manifest, desktop entry and AppStream metadata |

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
