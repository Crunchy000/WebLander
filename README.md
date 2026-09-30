# Twilight Hover

*Twilight Hover Web Game* — the project that started as WebLander.

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
else -- the workflows, the README and the scripts themselves stay behind. It
also writes `js/build.js` with the commit the site was built from and its
date, which the title card shows under the start button (and the debug
panel's report carries), so you can tell which version a browser is
running; the copy in the repository says `dev`.

## Controls

|                  | Steer          | Full power         | Hover         | Drop fire          | Pause         |
|------------------|----------------|--------------------|---------------|--------------------|---------------|
| **Mouse**        | move it        | left button        | middle button | right button       | <kbd>Esc</kbd> |
| **Keys**         | arrows / WASD  | <kbd>Z</kbd>       | <kbd>X</kbd>  | <kbd>C</kbd>       | <kbd>P</kbd>  |
| **Pad**          | left stick     | RT or A            | LT or X       | LB or RB           | Menu          |
| **Thumb sticks** | left thumb     | right thumb up     | let the right thumb go | a third finger | the button at the top |
| **Tilt**         | lean the phone | one finger         | two fingers   | three fingers      | the button at the top |

<kbd>M</kbd> turns the sound on and off, and <kbd>F</kbd> toggles fullscreen.

### The card, settings and pause

Before a flight the title card has four pages -- **about**, **controls**
(for the device you are on), **awards** and **settings** -- and a button to
turn the sound off. Pausing brings the same card back, over the frozen world,
with **resume** and **new flight**: <kbd>Esc</kbd> or <kbd>P</kbd>, the pad's
Menu button, the pause button at the top of a touch screen, or switching away
from the tab.

Settings are kept on the device (`js/settings.js`): sound on or off; overall,
music and effects volume; how far the mouse leans the bird for a given
movement; thumb sticks or tilt on a touch screen; the picture -- sharp,
balanced or fast, the share of the display's resolution the game is drawn at,
for a machine that cannot keep up -- and clearing the best score. The
defaults are the game as it was before there were settings.

On a console the card is worked from the pad: the d-pad moves between the
controls and moves a slider, the bumpers change page, A presses, and Menu
starts or resumes.


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

**Shadow crabs** scuttle about the dry land, sideways: chunky low-poly
things, a tall faceted shell with two big white eyes on its front, heavy
block claws dark along the edges that close, and short spiky legs. The eyes
make their own light, so after dark they are what you see of them. Left alone they
wander; let the bird come down within about a tile and a half of the ground and
seven across it and one will notice -- a clatter of claws says so -- and
come at it with its claws raised, at about two tiles a second. In reach, it
stops and rears up, claws open, for about a quarter of a second before it
pinches, and only pinches if the bird is still there: that is the moment to
climb away. A pinch does not kill: it takes a sixth of a full load of
energy and throws the bird up and away, and the crab backs off for three
seconds before it will try again -- it is the energy running out that does
the killing. They never set foot on the launchpad, and none spawn within five
tiles of it, so the pad is always somewhere safe to sit and charge. Coming
down on one from above -- descending, over it, feet within half a tile of
its back -- bursts it into shadow for 60 points and bounces the bird back up.

**The king crab and the sunset** (`js/crabs.js`, `js/game.js`). With four
flames gathered the ground shakes and the king crab rises out of it beside
the last one, over sixty steps: the same crab two and a half times the
size, crimson, with a gold crown, and the last flame lifted up above him out
of reach until he is beaten. He keeps within a couple of tiles of it, comes
at the bird when it is within nine, rears for longer than a small crab
before he pinches, and a pinch takes a quarter of a full load of energy and
throws the bird further. Landing on his shell only bounces off. Three fire
bombs on him turn him over (500 points, as a trick), and the flame comes
down. Taking it -- all five, the whole bird -- runs the day on to sunset,
the sun stopping big and orange on the horizon while the sky reddens; then
climbing -- the two-tile ceiling lifted now -- six and a half tiles above
the highest ground is rising into it.
The phoenix goes up in a stream of embers as the light fills the screen,
and the flight ends on a card with the time it took and the quickest yet
(kept on the device).

**Tricks stack** (`js/tricks.js`). Each trick adds its points to a pot and
one to a multiplier (up to ten); the next has to come within four seconds
of the last -- the bar under the stack shows how long is left -- or the
stack is banked, pot times multiplier. Setting down banks it too; a crash
loses it. The same trick again in one stack is worth half what it was the
time before (never under a quarter), so variety pays.

| trick | points |
|---|---|
| loop the loop -- all the way round: Y, V or the mouse wheel, or a stick held right over | 150 |
| balloon bounce -- come down on top of a balloon; it throws you back up | 100 |
| bunting -- fly through the line strung between two balloons | 60 |
| timber -- knock over a stack of blocks, or a tree | what it is worth |
| water skim -- 0.8 s low (feet within a tile) and moving (1.2 tiles/s) over the sea; "skimming" shows while it builds | 60 |
| long skim -- two and a half seconds of it | 100 |
| close shave -- past a tree or a stack, within a third of a tile of it, quickly | 40 |
| crab squash / crab flip | 60 / 40 |
| king crab overturned | 500 |

Balloons are springy now rather than ghosts: brushing one's side nudges the
bird off it, and nothing about them can hurt you.

**Awards** (`js/achievements.js`): thirty things to tick off, kept on
the device between visits -- some a count across every flight (flip fifty
crabs, bounce off ten balloons, knock over twenty-five block towers, land on
five canoes, fly ten loops), some a single feat (three balloon bounces in
one stack, three crabs with one bomb, a x10 stack, being in the air at
midnight, overturning the king crab, reaching the sunset inside fifteen
minutes). Earning one puts its name at the foot of the screen with a
chime; the awards page on the card lists them all, ticked or not, with how
far along each count is.

**Canoes** are somewhere to set down at sea: land on one between its ends
and the bird rides along with it -- and charges, since the water it sits on
is level. Landing on one is a trick too (120).

**Fire bombs**: the phoenix can drop its own fire -- the right mouse
button, <kbd>C</kbd>, a pad's bumpers, or on a touch screen a third finger
(with both thumbs on the sticks, any finger not holding one) or, steering by
tilt, three fingers -- where one is full power and two hover. A drop of fire leaves from under the bird carrying its speed, so you
aim by flying over the place, and bursts where it lands. Every shadow crab
within about a tile and a half is thrown over onto its back, 40 points each,
and lies there waving its legs, harmless, until it is off the screen. Over
the sea it only hisses out. Each costs a fiftieth of a full load of energy,
and they come a third of a second apart.

The phoenix **starts small**: a single tail feather, no streamer, and half a full load of
energy. Five teardrop flames burn across the whole world, each about fifty
tiles further ahead of the launchpad than the last and swinging wider left
and right, the last most of the way round; each stands under a column of
light, the nearer ones visible from the pad and the rest coming into view on
the way out. Flying
through one grows the bird: a tongue of flame for its tail, a fifth more of
its streamer, and a tenth more room for energy, filled on the spot. All five
is the whole bird, six feathers with a long plume down the middle. Before launch the phoenix is itself one of these flames,
sat on the pad, and it hatches out of it at the first touch of power -- at
the start of every life. A death costs it the flame it gathered last: that
tail feather goes, and the flame burns again where it was found, to be flown
back to. A new game starts it small.

The bird runs on **energy**, not fuel. Set down anywhere the ground is
level enough to sit square on and it charges — the launchpad is simply the
best surface there is. Nectar from the paper tulips tops it up, and so does
every paper lamp gathered off the water (a twenty-fourth of a full load
each, and the bar glows as it lands). Below a fifth the meter turns red, the label flashes
and the machine starts beeping, faster and higher the less there is left; it
stops the moment you are on the ground taking charge.

Running it flat ends the life: there is no glide -- unless the bird is sat
on ground it can charge on, it burns out to embers and rises again at the
pad. Lives never run out: the phoenix always comes back, one tail feather
the smaller. Keep an eye on the bar. The height stick holds your height when it is left
centred, all the way down to the surface -- over land or the sea it never
sets you down by itself -- and landing is the stick pushed down, which at
the bottom of its travel pushes the bird down at about twice a free fall's
two tiles a second. The ground forgives anything under 1.56, so ease off
before you arrive. But a grounded craft is a stationary target, and tanks
will open fire on one the moment their turret comes to bear. Charging in the
open is a decision, not a rest.

The first **five seconds of every life are free**: getting off the pad is the
fiddliest moment in the game, so during that window you can scrape the ground,
clip a tree or come down hard without losing a ship. The HUD counts it down.

Steering is by *position*, not rate: the bearing of the stick from centre
becomes the craft's heading, and how far you push it becomes how far its nose
drops. Thrust acts along the roof, so a nose-down attitude carries you along
the heading — trading lift for speed.

**Relative steering** is the other way the sticks -- the pad's left stick
and the left thumb on the glass -- can fly, and the default (settings:
*sticks* -- *turn & pitch* or *point*). Across turns the heading, round in
2.8 seconds at full stick, and carries nine tenths of the momentum round
with it, as a banked turn does. Once the bird is moving (faster than 2.5
tiles a second along its heading), forward and back **fly the wings**: they
turn its path, nose down or nose up, at a rate set by how far the stick is
pushed -- a full turn in 2.1 seconds at the rim -- and there is no limit on
the angle. Held, that goes all the way round: back is an inside loop,
forward an outside one, and either counts as a loop the loop. The speed is
momentum: climbing costs it, diving gives it, drag is only a loop's, and
power adds a little along the path. Off a hover, forward leans the nose
down along the heading instead, up to about 75 degrees, so pushing forward
sets off rather than diving into the ground -- until the stick comes back
to the middle or goes back. Centred, the wings let go, the bird levels out
and keeps its heading -- the stay-put assist is for pointing, not for
flying. The camera does not turn with the bird, so flying towards it the
turns feel reversed, as they do for a car driven towards you. The mouse and
tilt always point.

The mouse is that stick. With the pointer captured there is no cursor, so a
ring in the bottom-right corner shows where the stick is; half a canvas
height of movement takes it from the middle to the rim, and near the middle
counts as the middle. The mouse and the keys stop just short of the rim that
starts a loop: neither can be let go of the way a pad's stick or a thumb
can, and at the rim they kept the bird looping -- flying backwards for half
of every turn. So a loop is also **a button**: <kbd>Y</kbd> on the pad,
<kbd>V</kbd>, a turn of the mouse wheel or a mouse side button. One press
flies one whole loop the way the bird is going, whatever the stick is doing
meanwhile -- which is the easy way on the pad too, where a thumb easing off
the rim during a loop (below 0.8) let go of it halfway round.

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

**The ceiling is two tiles over the ground** -- whatever ground, or sea,
is under the bird at the time -- and it is soft, and only ever takes the
climbing away. Past it the upward share of the push fades out over half a
tile (to nothing while still climbing, and to an eighth on the way back
down, too little to hold height on), so hover settles back to 2.0 and full
power holds about 2.4. The push across the ground is untouched, and so is
the push downwards at the top of a loop. Nothing brakes speed there: a
run-up and a pull into a loop carries over it on momentum -- a full-power
blast straight up from the ground coasts to about 4.4 -- and comes back
down, with nothing to stay up on. Fly off a cliff edge on hover and it sinks
at no more than a tile and a half a second to two tiles over the new ground.
The ground it is measured from is the highest of what is underfoot and
what the bird will be over in half a second and a second (up to three
tiles ahead), so the ceiling rises before a hill does. Flying under power
at a slope that rises ahead, within two and a half tiles of it, **ridge
lift** -- the air pushed up the face -- carries the bird up the slope's
angle at the speed it is going: a scripted pilot at the ceiling crashed
into the steepest slopes on one run in four without it, and on none with
it. On the flat, land or sea, the same air gives **ground effect**: on full
power, within a tile and a half of the surface, an extra push of up to a
quarter of full power (over a g) at the surface, fading to nothing at a
tile and a half, and any descent towards it cushioned. Flying forward at
0.7 of the stick used to put the bird in the sea in a second and a half;
now it rides half a tile over it. Hover is left out: it is already holding
the height it was asked for, for a skim or a landing. And **a loop is flown on the wings**: it carries its own weight, the
ceiling does not apply during one, and the speed the bird came in with is
carried round a circle that starts where it went in -- forward, up, back
over the top, down and out the way it came -- losing a little to drag and
nothing to the push, which turned with the lean had braked the climb. The
loop is as big as the run-up (its radius is the speed over the rate the
lean turns): from a standstill it stands a tile and a half tall, after a
two-second run along the water four and a half, coming out at three
quarters of the speed it went in with. The trick counts one full turn from
the entry.
The one ceiling that is never broken is the old one in world y, ten tiles
over the tallest peak: climbs into it are braked, and at it they stop.
Two things lift the two-tile one. The warm air over and round a group of
balloons, and along the bunting between them, lets the bird climb to a tile
and a bit over their tops (braked at the top of it, or a long climb up the
column shot five tiles past), so they can still be bounced on. And once the
phoenix is whole, for the sunset, the sky is open.

There is no separate turn control, because steering *is* turning. The bird
is drawn facing where it is going once it is moving -- towards you when it
flies towards the camera -- tipped nose-down by the part of its lean along
that way, and only by two fifths of it in ordinary flight (at the whole lean
a bird flying away showed its head below its tail, just as one coming
towards you does, and which way it faced could not be read; it catches up
to the whole lean past upright, so a loop still goes all the way round), so leaning back to slow down leaves it level rather than turning
it round to fly on tail first. Standing still, and in a loop, it faces its
lean. Only the picture turns; the flying is unchanged. The craft
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
| `js/crabs.js` | shadow crabs and the king crab: wander the land, pinch the bird, squash from above |
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
| `js/settings.js` | the player's settings, kept between visits |
| `js/firebombs.js` | the phoenix's dropped fire |
| `js/tricks.js` | tricks, and stacking them into combos |
| `js/achievements.js` | awards to tick off, kept between visits |
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
