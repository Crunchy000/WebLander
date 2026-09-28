// game.js -- the main loop: draw the world, fly the ship, keep the score.

import { TILE, rndInt, rnd } from './maths.js';
import {
  landAltitude, tileColour, fogForRow, SEA_LEVEL, LAUNCHPAD_ALT,
  TILES_X, TILES_X_MAX, TILES_Z, LANDSCAPE_X, LANDSCAPE_Z, LANDSCAPE_Z_MID,
  UNDERCARRIAGE_Y,
} from './landscape.js';
import {
  sky, sun, moon, STARS, advanceDay, skyColourAt, SKY_BAND_1, SKY_BAND_2, beacon,
  lightGen,
} from './daylight.js';
import { drawRidges, drawNearGround, drawHorizonHaze, backdropAt } from './ridges.js';
import { flowersInRow, nearestFlower, takeFlower, resetFlowers } from './flowers.js';
import { sampleRibbon, drawRibbon, resetRibbon, setRibbonLength } from './ribbon.js';
import {
  FLAME_COUNT, resetFlames, restoreFlame, updateFlames, flamesInRow, drawFlame, drawBeacons,
} from './flames.js';
import { serene } from './style.js';
import { seaShade } from './sea.js';
import { updateWeather, drawWeather, resetWeather, weather, SNOW } from './weather.js';
import { drawClouds } from './clouds.js';
import { project, depthOf, SCREEN_W, SCREEN_H, CENTRE_X, CENTRE_Y, FOCAL_X, FOCAL_Y, DEPTH } from './renderer.js';
import { ModelPass } from './modelpass.js';
import { drawTouchStick } from './stick.js';
import { prof } from './profile.js';

// Sections timed a row at a time, held rather than looked up by name.
const P_SCENERY = prof.section('scenery');

// What the landscape pass knows about each tile, kept from frame to frame.
//
// Everything the ground pass asked of a tile was worked out again every
// frame: its height (six table lookups), whether anything stands on it (a
// hash, a biome and a height), and its colour (the biome palette blended
// three ways, a tint, the light). None of that changes while the tile is in
// view -- the camera sliding along does not move the ground -- except the
// colour, when the tile moves to another row or the light changes. Measured
// with the JavaScript JIT off, as the Xbox's sandboxed browser runs it, the
// colour alone was 4.5ms of every thousand tiles and the ground pass 8ms a
// frame; a JIT hides nearly all of it, which is why it never showed before.
//
// Direct-mapped on the tile's world coordinates, 64 by 64, which is more
// than the grid ever shows. An entry is good while its coordinates match;
// its object while objectsVersion has not moved; its colour while the row
// and lightGen are the ones it was worked out for. Water goes in with the
// land: the sea is still, so its surf depends only on where the tile is.
const TC = 64, TC_MASK = TC - 1;
const tcX = new Int32Array(TC * TC).fill(0x7fffffff);
const tcZ = new Int32Array(TC * TC);
const tcAlt = new Int32Array(TC * TC);
const tcObj = new Int16Array(TC * TC + 1);
const tcObjVer = new Int32Array(TC * TC).fill(-1);
const tcRow = new Int16Array(TC * TC).fill(-1);
const tcGen = new Int32Array(TC * TC).fill(-1);
const tcCol = new Array(TC * TC).fill(null);
// Where the tile's object stands and what it is drawn as: its offset within
// the tile, the ground height there, and its model for the biome. All of
// them follow from the tile and its type, so they are worked out with the
// object and kept with it. One slot past the end is a spare, for flushObjects.
const tcWx = new Int32Array(TC * TC + 1);
const tcWz = new Int32Array(TC * TC + 1);
const tcBase = new Int32Array(TC * TC + 1);
const tcBiome = new Int8Array(TC * TC + 1);
const tcModel = new Array(TC * TC + 1).fill(null);
function placeObject(tci, tx, tz, type) {
  const [jx, jz] = objectOffset(tx, tz);
  const wx = ((tx * TILE) | 0) + jx;
  const wz = ((tz * TILE) | 0) + jz;
  const biome = biomeAt(tx, tz);
  tcWx[tci] = wx; tcWz[tci] = wz;
  tcBase[tci] = landAltitude(wx, wz);
  tcBiome[tci] = biome;
  tcModel[tci] = modelFor(type, biome);
}

const P_FLOWERS = prof.section('flowers');
const P_LANTERNS = prof.section('lanterns');
import { Player, GRAVITY_START, CHARGE_MAX, HULL_HITS, AIRFRAME } from './player.js';
import { drawModel, drawShadow, drawLightPool, silhouetteAmount } from './model.js';
import { setFireLevel } from './origami.js';
import {
  MODELS, OBJ_SCORE, objectAt, objectOffset, destroyObject, isWreck,
  isBlocks, isNatural, structureIndex, resetObjects, modelFor, biomeAt,
  objectsVersion,
} from './objects.js';
import { topple, updateBlocks, drawPile, pileAt } from './blocks.js';
import {
  updateBalloons, drawBalloon, drawFarBalloons, balloonsInRow, resetBalloons,
} from './balloons.js';
import {
  updateLanterns, drawLantern, lanternsInRow, resetLanterns,
} from './lanterns.js';
import {
  updateParticles, drawParticles, resetParticles, particleData,
  spawnExplosion, spawnSparks, spawnSmoke, particleCount, P_BULLET,
} from './particles.js';
import { drawText, drawTextCentred, textWidth } from './font.js';
import {
  resetTanks,
} from './tanks.js';
import {
  updateBoats, drawBoat, boatsInRow, boatHit, boatBlast, resetBoats, BOAT_SCORE,
} from './boats.js';
import { updateCrabs, drawCrab, crabsInRow, resetCrabs, CRAB_SCORE } from './crabs.js';

export const STATE = { TITLE: 0, PLAYING: 1, DYING: 2, GAMEOVER: 3 };

// What the screen says about each way of losing a craft.
//
// This used to be a chain of conditionals ending in CRASHED, which meant any
// cause nobody had thought to add reported itself as flying into the ground.
// Point defence and missiles both did exactly that. The fallback now prints
// whatever cause it was handed instead: a new one turning up unlabelled is a
// thing you notice, where a new one claiming to be a crash is not.
const DEATH_MESSAGE = {
  crash: 'a heavy landing',
  sea: 'down in the water',
  shelled: 'shot down',
  beam: 'hull breached',
  missile: 'missile hit',
  spent: 'burnt out -- rising again',
};


// What a lantern is worth, and how long a run may pause before it is over.
// Two seconds is long enough to line up the next one and short enough that
// the run has to be flown rather than wandered.
const LANTERN_SCORE = 10;
// A flame of the phoenix's.
const FLAME_SCORE = 150;
// ... and what one gives the bird: a twenty-fourth of a full load, about six
// seconds of hovering. Less than a flower's, because a lantern is flown
// through rather than crept up on and held, and there are dozens on the
// water -- a line of them is a real top-up, one is a sip.
const LANTERN_ENERGY = CHARGE_MAX / 24;
// What a shadow crab's pinch takes: a sixth of a full load, about a quarter
// of what a bird with no flames yet can hold at all -- enough to hurt, not
// enough that one on its own ends a full bird.
const PINCH_ENERGY = CHARGE_MAX / 6;

// Nectar. Half a second of holding station buys a fourteenth of the pack,
// which is about ten seconds of hovering -- so a meadow pays for the time
// spent crossing it and a little over, and a long flight between two of them
// still has to be planned.
const NECTAR_SCORE = 12;
const NECTAR = CHARGE_MAX / 14;
const SIP_REACH = 0.62;            // tiles, horizontally
const SIP_ABOVE = 1.15;            // ... and how far above the bloom
const SIP_SPEED = 0x01000000 * 0.03;
const SIP_FRAMES = 26;             // just over half a second
const NECTAR_RUN_GAP = 6 * 50;     // and six seconds between flowers keeps a run
const LANTERN_RUN_GAP = 100;


// The game runs on a fixed 50Hz step regardless of how often the display
// refreshes, so the physics constants -- which are all per-frame, as they were
// on hardware with a fixed frame rate -- behave identically everywhere.
export const STEP_MS = 20;

// Where the charge meter turns red, and how fast it complains about it. One
// number for the bar and the beeps both, so what you see and what you hear
// can never disagree about when the battery is low.
const LOW_CHARGE = 0.22;
const WARN_SLOW = 60;    // frames between beeps as it first turns red
const WARN_FAST = 15;    // ... and with the last of it

// Somewhere to put the colour behind whichever body is up.
const backTop = [0, 0, 0], backBottom = [0, 0, 0];

// One step of a corona: a square stepped from whatever is behind it towards
// the body's own colour.
//
// Shaded top to bottom rather than filled flat, because what is behind it is
// not one colour. Low in the frame a body straddles the horizon, with sky
// above the line and the haze of the far plain below it, and a square mixed
// against a single sample of that reads as a pale box sitting on the sky
// instead of as glow.
// The sun and the moon go down behind the ground, and the ground runs flat
// all the way to the horizon, which is eye level: nothing of them below that
// line can be seen. They are drawn onto the far plain that stands in for the
// country beyond the hills, and it used to be only the hills that hid them
// -- so wherever there were none, over a distant sea or through the gap
// under a ridge, a sliver of a low sun showed below the skyline, in front of
// the ground. Everything of theirs is cut off at the horizon now.
function corona(rd, cx, cy, w, col, mix) {
  const x0 = Math.round(cx - w / 2), y0 = Math.round(cy - w / 2);
  const y1 = Math.min(y0 + w, CENTRE_Y);
  if (y1 <= y0) return;
  const a = mixCol(backdropAt(y0, backTop), col, mix);
  const b = mixCol(backdropAt(y1, backBottom), col, mix);
  rd.quadShaded(x0, y0, a, x0 + w, y0, a, x0 + w, y1, b, x0, y1, b);
}

// A rectangle of a body, cut off at the horizon. See corona.
function rectAbove(rd, x, y, w, h, col) {
  const hh = Math.min(h, CENTRE_Y - y);
  if (hh > 0) rd.rect(x, y, w, hh, col);
}

export class Game {
  constructor(renderer, input, audio) {
    this.rd = renderer;
    // The scenery is drawn on the GPU where it can be (see modelpass.js).
    // ?cpumodels puts it back on the old path, which is how the two are
    // compared frame for frame.
    this.models = new ModelPass(renderer);
    const gpu = !(typeof location !== 'undefined' && /[?&]cpumodels\b/.test(location.search));
    // drawModel looks for it here, and hands over what it can.
    renderer.instancer = gpu && this.models.ok ? this.models : null;
    renderer.modelPass = this.models;
    this.input = input;
    this.audio = audio;

    this.player = new Player();
    this.highScore = loadHighScore();
    this.state = STATE.TITLE;

    // Scratch buffers for the landscape scan, allocated once.
    this.rowX = new Float64Array(TILES_X_MAX);
    this.rowY = new Float64Array(TILES_X_MAX);
    this.rowOk = new Uint8Array(TILES_X_MAX);
    this.rowAlt = new Int32Array(TILES_X_MAX);
    this.prevX = new Float64Array(TILES_X_MAX);
    this.prevY = new Float64Array(TILES_X_MAX);
    this.prevOk = new Uint8Array(TILES_X_MAX);

    // Objects waiting to be drawn, staggered behind the landscape.
    this.rowWorldZ = new Int32Array(TILES_Z + 2);
    this.rowDepth = new Float32Array(TILES_Z + 2);
    this.pending = Array.from({ length: TILES_Z + 2 }, () => []);
    this.pendingBoats = Array.from({ length: TILES_Z + 2 }, () => []);
    this.pendingBalloons = Array.from({ length: TILES_Z + 2 }, () => []);
    this.pendingLanterns = Array.from({ length: TILES_Z + 2 }, () => []);
    this.pendingFlames = Array.from({ length: TILES_Z + 2 }, () => []);
    this.pendingCrabs = Array.from({ length: TILES_Z + 2 }, () => []);
    this.warnTick = 0;

    this.newGame();
    this.state = STATE.TITLE;
  }

  newGame() {
    this.score = 0;
    this.gravity = GRAVITY_START;
    this.message = null;
    this.messageTimer = 0;
    resetObjects();
    resetParticles();
    resetRibbon();
    resetTanks();
    resetBoats();
    resetBalloons();
    resetLanterns();
    resetWeather();
    resetFlowers();
    resetFlames();
    resetCrabs();
    this.flames = 0;
    this.flameOrder = [];
    this.grow();
    this.player.reset();
    this.input.newFlight();
    this.state = STATE.PLAYING;
  }

  // --- the phoenix's flames ------------------------------------------------
  //
  // The bird starts small -- one tail feather, no streamer, half a load of
  // energy -- and every one of the five flames it gathers adds to all
  // three: a tongue of the tail, a fifth of the streamer, a tenth of a full
  // load of room for energy. All five is the whole bird. A death costs it the last one (see
  // respawn); a new game starts it small again.
  grow() {
    const n = this.flames;
    setFireLevel(1 + n);
    setRibbonLength(n / FLAME_COUNT);
    this.player.chargeCap = Math.round(CHARGE_MAX * (0.5 + 0.5 * n / FLAME_COUNT));
  }

  onFlameTaken(k) {
    this.flames = Math.min(FLAME_COUNT, this.flames + 1);
    (this.flameOrder || (this.flameOrder = [])).push(k);
    this.grow();
    // Taking a flame fills the bird to its new size.
    this.player.charge = this.player.chargeCap;
    this.energyFlash = 30;
    this.addScore(FLAME_SCORE);
    // A rising run of notes, one more for every flame held.
    for (let i = 0; i <= this.flames + 1; i++) setTimeout(() => this.audio.chime(i + 2), i * 90);
    this.setMessage(this.flames >= FLAME_COUNT ? 'the phoenix is whole  +' + FLAME_SCORE
      : 'flame ' + this.flames + ' of ' + FLAME_COUNT + '  +' + FLAME_SCORE, 120);
  }

  // --- events from the player ---------------------------------------------

  onShot() { this.audio.shot(); }

  // The craft has left the ground, which is the one moment in a flight when
  // nobody is steering: whatever way the handset is being held right now is
  // straight ahead. Nothing else in the game can tell the tilt code that, and
  // it is the one thing that would let it stop guessing. See recentre().
  onLiftoff() {
    if (this.input && this.input.tilt && this.input.tilt.recentre) {
      this.input.tilt.recentre();
    }
  }

  onTouchdown(onPad) {
    this.audio.touchdown();
  }

  onCharging() {
    // Chirp occasionally rather than every frame.
    if ((this.chargeTick = (this.chargeTick | 0) + 1) % 7 === 0) this.audio.charge();
    this.setMessage('charging', 12);
  }

  // A tank shell found the craft while it sat on the ground.
  onBoatHit(x, y, z) {
    this.audio.explosion();
    this.setMessage('boat hit', 60);
  }

  // A shadow crab has got the bird: energy out of it, and the bird thrown up
  // and away from the claws.
  onPinched(c) {
    const p = this.player;
    p.charge = Math.max(0, p.charge - PINCH_ENERGY);
    let ax = p.x - c.x, az = p.z - c.z;
    const len = Math.hypot(ax, az) || 1;
    ax /= len; az /= len;
    p.vx = (p.vx * 0.3 + ax * TILE * 0.022) | 0;
    p.vz = (p.vz * 0.3 + az * TILE * 0.022) | 0;
    p.vy = Math.min(p.vy, -TILE * 0.028) | 0;
    this.energyFlash = 24;
    this.audio.tone(210, 0.06, 'square', 0.22);
    setTimeout(() => this.audio.tone(150, 0.09, 'square', 0.2), 70);
    this.setMessage('pinched!', 60);
  }

  // ... and the bird has come down on one.
  onCrabSquashed(c) {
    const p = this.player;
    p.vy = Math.min(p.vy, -TILE * 0.03) | 0;
    this.addScore(CRAB_SCORE);
    this.audio.clatter(0.35);
    this.audio.chime(3);
    this.setMessage('crab squashed  +' + CRAB_SCORE, 60);
  }

  onBoatSunk(x, y, z) {
    this.audio.bigBoom();
    this.setMessage('boat down  +' + BOAT_SCORE, 90);
  }

  onShipGoesUnder(x, y, z) {
    this.audio.bigSplash();
  }

  onSecondaryBlast() {
    this.audio.secondary();
  }

  // Nectar.
  //
  // The bird holds station at a flower and drinks, and what it gets is
  // charge -- which makes a meadow a fuel stop and turns the battery from a
  // countdown into a route. Nothing else in the game gives you charge except
  // sitting on the ground, and sitting on the ground is the one thing a
  // hummingbird is bad at.
  //
  // Hovering is the whole of the skill. It is not a pickup you fly through:
  // you have to be over the bloom, near its height, and nearly stopped, and
  // hold it there for half a second. That is exactly the manoeuvre this
  // airframe is for, and the one the throttle and the stick were tuned
  // around -- so the reward and the control scheme are asking for the same
  // thing, which is the only kind of objective worth adding.
  sipNectar(p) {
    const near = p.landed || p.dead ? null
               : nearestFlower(p.x, p.z, sky.tick, SIP_REACH);
    let sipping = false;
    if (near) {
      // Above the bloom, within reach of it, and slow.
      const over = (near.bloom - p.y) / TILE;
      sipping = over > -0.35 && over < SIP_ABOVE && p.speed < SIP_SPEED;
    }

    if (!sipping) {
      this.sipFor = Math.max(0, (this.sipFor || 0) - 3);
      if (!this.sipFor) this.sipAt = 0;
      return;
    }
    if (this.sipAt !== near.id) { this.sipAt = near.id; this.sipFor = 0; }
    this.sipFor++;

    // A few grains of pollen while it is going on, so the hold has something
    // to show for itself before it pays.
    if (this.sipFor % 4 === 0) spawnSparks(near.x, near.bloom, near.z, 1);

    if (this.sipFor < SIP_FRAMES) return;
    this.sipFor = 0;
    this.sipAt = 0;
    takeFlower(near.id, sky.tick);

    p.charge = Math.min(p.chargeCap, p.charge + NECTAR);
    spawnSparks(near.x, near.bloom, near.z, 8);

    // The same run the lanterns keep: a line of flowers taken without a
    // pause is a phrase rather than the same note eight times. It is a slower
    // phrase, though, and it gets a longer window to stay in: a lantern is
    // taken by flying through it, while a tulip has to be crept up on and
    // held at walking pace for half a second, so the two seconds the water
    // allows would end a run that was never actually broken.
    if (this.nectarRun === undefined || this.nectarAt === undefined ||
        sky.tick - this.nectarAt > NECTAR_RUN_GAP) {
      this.nectarRun = 0;
    }
    this.audio.chime(this.nectarRun);
    const pts = NECTAR_SCORE * (1 + Math.min(this.nectarRun, 7));
    this.addScore(pts);
    this.nectarRun++;
    this.nectarAt = sky.tick;
    this.setMessage('nectar  +' + pts, 50);
  }

  // A lantern gathered off the water.
  //
  // The run counts. Take one and the note is the bottom of the scale; keep
  // taking them without a pause and it climbs, so a line of lanterns played
  // in one pass is a phrase rather than the same ding eight times. Two
  // seconds without one and it drops back to the bottom.
  //
  // Points climb with it too, which is the only scoring in the game that
  // rewards doing something gracefully rather than doing it at all.
  onLanternTaken(x, y, z) {
    if (this.lanternRun === undefined || this.lanternAt === undefined ||
        sky.tick - this.lanternAt > LANTERN_RUN_GAP) {
      this.lanternRun = 0;
    }
    this.audio.chime(this.lanternRun);
    this.addScore(LANTERN_SCORE * (1 + Math.min(this.lanternRun, 7)));
    // A lamp is a top-up: its light goes into the bird.
    const p = this.player;
    if (!p.dead) {
      p.charge = Math.min(p.chargeCap, p.charge + LANTERN_ENERGY);
      this.energyFlash = 18;
    }
    this.lanternRun++;
    this.lanternAt = sky.tick;
    this.lanternsTaken = (this.lanternsTaken || 0) + 1;
  }

  // A structure has gone over. Points either way, but a stack shoved by the
  // drone clatters; one that a bomb went off under does not get the chance.
  onBlocksKnocked(type, x, y, z, force) {
    this.addScore(OBJ_SCORE[type] || 0);
    this.audio.clatter(Math.min(1, force / 2.2));
    this.setMessage('timber  +' + (OBJ_SCORE[type] || 0), 60);
  }

  onDeath(how) {
    // Burning out is not a crash, and does not sound like one.
    if (how === 'spent') this.audio.gameOver();
    else this.audio.explosion();
    this.state = STATE.DYING;
    this.setMessage(DEATH_MESSAGE[how] || String(how), 110);
  }

  setMessage(text, frames) {
    this.message = text;
    this.messageTimer = frames;
  }

  addScore(n) {
    this.score += n;
    if (this.score > this.highScore) {
      this.highScore = this.score;
      saveHighScore(this.highScore);
    }
    // Gravity ratchets up as you get better, exactly as the original does.
    // Gravity ratchets up at the same score thresholds the original uses.
    if (this.score >= 1488) this.gravity = 0x04400;
    else if (this.score >= 1024) this.gravity = 0x03600;
    else this.gravity = GRAVITY_START;
  }

  // --- simulation ----------------------------------------------------------

  step() {
    const inp = this.input.sample();

    // The tilt's neutral is allowed to drift towards where the handset is
    // being held, but only while no power is being asked for. With the engine
    // running, every degree away from neutral is one the pilot asked for, and
    // a zero that wanders under them is a zero taking their lean away. See
    // setDrifting. It reads the asked-for thrust rather than what the machine
    // managed, so a flat battery on the way down does not start moving the
    // zero while it is still being flown.
    if (this.input.tilt && this.input.tilt.setDrifting) {
      this.input.tilt.setDrifting(!inp.thrust);
    }
    advanceDay(STEP_MS);
    updateWeather(this.player.x, this.player.z);
    // The beds run in every state, so the weather is still there behind the
    // title screen and while you are waiting to respawn.
    this.audio.ambience(weather.wet, weather.strength, weather.kind === SNOW);
    if (weather.struck) this.audio.thunder();

    if (this.state === STATE.TITLE || this.state === STATE.GAMEOVER) {
      // The landscape keeps drifting behind the title, as an attract mode.
      this.player.z = (this.player.z + TILE * 0.012) | 0;
      updateParticles(this.gravity, () => false);
      updateBlocks();
      if (inp.consumeStart() || inp.thrust) {
        this.audio.start();
        this.newGame();
      }
      return;
    }

    if (this.state === STATE.DYING) {
      updateParticles(this.gravity, () => false);
      updateBlocks();
      this.player.deathTimer--;
      if (this.player.deathTimer <= 0) this.respawn();
      if (this.messageTimer > 0) this.messageTimer--;
      return;
    }

    // Playing.
    this.player.update(inp.stick, inp.thrust, inp.fire, this.gravity, this, inp.throttle, inp.hold, inp.stay, inp.slide);
    // Gated on the style for the same reason the drawing is: a flower you
    // can drink from and cannot see would be worse than no flower at all.
    if (serene() && this.state === STATE.PLAYING) this.sipNectar(this.player);
    this.audio.engine(this.player.thrusting);

    sampleRibbon(this.player);
    updateBoats(this.player, this);
    updateBalloons(this.player);
    updateLanterns(this.player, this);
    updateFlames(this.player, this);
    updateCrabs(this.player, this);
    updateBlocks();
    updateParticles(this.gravity, (i, bx, by, bz) => this.bulletHit(i, bx, by, bz));

    // Low battery. The meter turning red is easy to miss with the ground
    // coming up at you and a tank to think about, so it says so out loud, and
    // says it faster the less there is left. Nothing while charging -- the
    // meter is low then too, and being nagged about a problem you are already
    // fixing is how a warning gets tuned out.
    const charge = this.player.charge / this.player.chargeCap;
    if (!this.player.dead && !this.player.charging && charge > 0 && charge < LOW_CHARGE) {
      const left = charge / LOW_CHARGE;   // 1 as it turns red, 0 as it dies
      if (--this.warnTick <= 0) {
        this.audio.lowBattery(1 - left);
        this.warnTick = Math.round(WARN_FAST + (WARN_SLOW - WARN_FAST) * left);
      }
    } else {
      // Zero rather than the full gap, so crossing the line beeps at once.
      this.warnTick = 0;
    }

    // Wrecks smoke away for as long as they are in view.
    this.smokeTick = (this.smokeTick | 0) + 1;

    if (this.messageTimer > 0 && --this.messageTimer === 0) this.message = null;
  }

  // The phoenix always rises again: there is no count of lives, and no end to
  // the game but the player's. It comes back at the launchpad, full to its
  // size.
  //
  // Every death costs it a tail feather: the flame it gathered last goes back
  // to where it burned, to be flown back to and taken again -- so progress
  // can slip but never be lost for good -- and the bird comes back a size
  // smaller: a tongue of its tail, a fifth of its streamer and a tenth of its
  // room for energy. It rises from its flame on the pad, as it began.
  respawn() {
    resetParticles();
    resetRibbon();
    let lost = false;
    if (this.flames > 0) {
      const k = (this.flameOrder || []).pop();
      if (k !== undefined) restoreFlame(k);
      this.flames--;
      this.grow();
      lost = true;
    }
    this.player.reset();
    this.input.newFlight();
    this.state = STATE.PLAYING;
    this.setMessage(lost ? 'a tail feather lost -- its flame burns again' : null, lost ? 120 : 0);
  }

  // A bullet has moved; see whether it has struck anything worth destroying.
  bulletHit(i, bx, by, bz) {
    const ground = landAltitude(bx, bz);


    // A hull taken square on.
    if (boatHit(bx, by, bz)) {
      boatBlast(bx, by, bz, this);
      return true;
    }

    // Check the tile the bullet is over, and its neighbours, for scenery.
    // Two tiles either way: a block structure can reach that far from the
    // tile it is recorded on.
    const tx = bx >> 24, tz = bz >> 24;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const ox = (tx + dx) | 0, oz = (tz + dz) | 0;
        const type = objectAt(ox, oz);
        if (type < 0 || isWreck(type)) continue;
        if (isBlocks(type) && pileAt(ox, oz)) continue;   // already rubble

        const model = MODELS[type];
        const [jx, jz] = objectOffset(ox, oz);
        const wx = ((ox * TILE) | 0) + jx;
        const wz = ((oz * TILE) | 0) + jz;
        const base = landAltitude(wx, wz);

        // Cylinder test: within the footprint, and below the top.
        const ddx = (bx - wx) / TILE, ddz = (bz - wz) / TILE;
        const r = model.radius / TILE + 0.12;
        if (ddx * ddx + ddz * ddz > r * r) continue;
        if (by < base - model.height || by > base + TILE * 0.2) continue;

        if (isBlocks(type)) {
          // A bomb underneath sends them a good deal further than a shoulder
          // from the drone does.
          if (!topple(ox, oz, structureIndex(type), wx, base, wz, bx, bz, 3.4)) continue;
          this.addScore(OBJ_SCORE[type] || 0);
          spawnSparks(wx, (base - MODELS[type].height / 2) | 0, wz, 12);
          this.audio.blast();
          this.audio.clatter(1);
          this.setMessage('timber  +' + (OBJ_SCORE[type] || 0), 60);
          return true;
        }

        this.destroy(ox, oz, type, wx, base, wz);
        return true;
      }
    }

    // Otherwise it goes off when it hits the ground.
    if (by >= ground) {
      if (ground < SEA_LEVEL) {
        // A bomb going off, not a bullet pocking the dirt.
        spawnExplosion(bx, ground, bz, 26, TILE * 0.030, null);
        spawnSparks(bx, ground, bz, 12);
        // Anything close enough goes up with it.
        this.audio.explosion();
      } else {
        // Into the sea: still lethal to anything close enough alongside.
        if (!boatBlast(bx, ground, bz, this)) this.audio.splash();
      }
      return true;
    }
    return false;
  }

  destroy(tx, tz, type, wx, base, wz) {
    destroyObject(tx, tz);
    const pts = OBJ_SCORE[type] || 0;
    this.addScore(pts);
    spawnExplosion(wx, (base - MODELS[type].height / 2) | 0, wz, 26, TILE * 0.022, null);
    spawnSparks(wx, (base - MODELS[type].height / 2) | 0, wz, 10);
    this.audio.blast();
  }

  // --- drawing -------------------------------------------------------------

  draw() {
    const rd = this.rd;
    // Each part of the frame is timed into a section of its own; see
    // profile.js. `t` is where the current lap began.
    let t = prof.now();
    rd.begin(sky.top);
    t = prof.lap('begin', t);

    const p = this.player;
    const eyeX = p.camX, eyeY = p.camY, eyeZ = p.camZ;
    // Every layer can be switched off from the console, which is how the
    // frame's contents get attributed: tools/attrib.mjs counts the triangles
    // with each one missing, and the difference is what that layer costs.
    // Counting rather than timing, because the numbers add up and the
    // milliseconds do not -- the GL queue drains between draws, so a timing
    // run picks up whatever the queue was already carrying.
    const __L = (typeof window !== 'undefined' && window.__layers) || {};
    const on = (k) => __L[k] !== false;

    // Sky first, in two bands so the falloff has a bend in it rather than
    // being a straight ramp from top to bottom, then the stars and whichever
    // of the sun or moon is up -- all of it behind the landscape.
    if (on('sky')) {
    rd.gradientBand(0, SKY_BAND_1, sky.top, sky.mid);
    rd.gradientBand(SKY_BAND_1, SKY_BAND_2, sky.mid, sky.horizon);
    rd.gradientBand(SKY_BAND_2, SCREEN_H, sky.horizon, sky.horizon);
    }
    t = prof.lap('sky', t);

    // Stars next, because a star below the horizon has set: the haze of the
    // far plain goes in after them and takes them with it.
    if (on('stars')) this.drawStars();
    t = prof.lap('stars', t);

    // The plain beyond the drawn landscape, and then the sun or the moon
    // standing on it, and only then the hills.
    //
    // The two halves of the horizon are deliberately either side of the sky's
    // furniture. A body should be hidden by hills, which are things, and not
    // by haze, which is only the colour of distance -- and with the haze in
    // front of it a setting sun disappeared forty rows above the skyline in
    // the middle of an empty sky.
    if (serene() && on('haze')) drawHorizonHaze(rd, eyeX, eyeY, eyeZ);
    t = prof.lap('haze', t);
    if (on('celestial')) this.drawCelestial();
    t = prof.lap('sun & moon', t);
    if (serene() && on('ridges')) drawRidges(rd, eyeX, eyeY, eyeZ);
    t = prof.lap('far hills', t);

    // Balloons beyond the drawn landscape have no row to be bucketed into, so
    // they get a pass of their own -- here, after the ranges. They went in
    // before them at first, on the reasoning that a range in front should
    // hide one that had drifted down behind it. That was the wrong picture:
    // the ranges are a parallax backdrop standing at the very back of the
    // world, and the furthest balloon is nearer than the nearest of them, so
    // a balloon disappearing behind a ridge read as the balloon being miles
    // further off than it is. In front, where they belong.
    if (on('farBalloons')) drawFarBalloons(rd, eyeX, eyeY, eyeZ);
    t = prof.lap('far balloons', t);
    // The columns of light over the flames too far off to be drawn with the
    // landscape. The near ones go up with their flames, in their rows.
    if (this.state === STATE.PLAYING || this.state === STATE.DYING) drawBeacons(rd, eyeX, eyeY, eyeZ, LANDSCAPE_Z);

    // Clouds go over the sun and under the landscape, which is the only
    // ordering that lets one drift across the other.
    if (on('clouds')) drawClouds(rd);
    t = prof.lap('clouds', t);

    if (on('landscape')) this.drawLandscape(eyeX, eyeY, eyeZ);
    // The landscape pass carries the scenery standing on it. What is left
    // once that is taken out is the ground itself.
    {
      const n = prof.now();
      prof.add('ground', (n - t) - prof.cur('scenery') - prof.cur('gpu scenery pass'));
      t = n;
    }
    // ... and the ground that is too close to have been drawn at all, which
    // goes in front of it because it is in front of it.
    if (serene() && on('nearGround')) drawNearGround(rd, eyeX, eyeY, eyeZ);
    t = prof.lap('near ground', t);
    if (on('ribbon')) drawRibbon(rd, eyeX, eyeY, eyeZ);
    t = prof.lap('streamer', t);
    if (on('particles')) drawParticles(rd, eyeX, eyeY, eyeZ);
    t = prof.lap('particles', t);
    if (this.state === STATE.PLAYING && on('player')) p.draw(rd, eyeX, eyeY, eyeZ);
    t = prof.lap('bird', t);
    if (on('weather')) drawWeather(rd, eyeX, eyeY, eyeZ);
    t = prof.lap('rain & snow', t);
    if (on('hud')) this.drawHud();
    t = prof.lap('hud', t);

    // The touch stick goes over everything, because it is the one thing on
    // screen that is not part of the world -- it is the player's own thumb,
    // drawn back at them.
    // Only when it is steering: under tilt a finger is just the engine.
    if (this.input.touchSteers) {
      drawTouchStick(this.rd, this.input.leftThumb.furniture);
      drawTouchStick(this.rd, this.input.rightThumb.furniture);
    }

    rd.flush();
    prof.lap('final flush', t);
  }

  // Stars. There is no alpha here, so "faint" has to mean "closer to the
  // colour of the sky behind it" -- which is what a faint star actually looks
  // like, and it means they fade out at dawn for free instead of needing to
  // be switched off at some arbitrary hour.
  drawStars() {
    if (sky.star < 0.02) return;
    const rd = this.rd;
    const t = this.starTick = (this.starTick | 0) + 1;

    for (let i = 0; i < STARS.length; i++) {
      const st = STARS[i];
      // A slow, per-star wobble. Stars twinkle because the air moves, so no
      // two should be in step.
      const tw = 0.78 + 0.22 * Math.sin(t * 0.055 + st.twinkle);
      const m = st.mag * tw * sky.star;
      if (m < 0.05) continue;

      const back = skyColourAt(st.y);
      const col = [
        Math.round(back[0] + (235 - back[0]) * m),
        Math.round(back[1] + (242 - back[1]) * m),
        Math.round(back[2] + (255 - back[2]) * m),
      ];
      rd.rect(Math.round(st.x * SCREEN_W), st.y, st.big ? 2 : 1, st.big ? 2 : 1, col);
    }
  }

  // The sun and the moon, both square, because the whole world is made of
  // flat polygons and a circle would be the one thing in it pretending
  // otherwise.
  drawCelestial() {
    const rd = this.rd;

    if (sun.up) {
      // Three squares, each a step closer to the sun's colour from whatever
      // is behind it, so the corona steps outwards in bands rather than
      // ending at a hard edge. Drawn outside-in, painter's algorithm doing
      // the rest.
      const s = sun.size;
      for (const [scale, mix] of [[2.6, 0.20], [1.8, 0.42], [1.3, 0.68]]) {
        corona(rd, sun.x, sun.y, Math.round(s * scale), sun.col, mix);
      }
      rectAbove(rd, Math.round(sun.x - s / 2), Math.round(sun.y - s / 2), s, s, sun.col);
    }

    if (moon.up) {
      // The same stepped corona as the sun but far tighter, because a single
      // wide square of pale grey against a black sky does not read as glow --
      // it reads as a grey square, which is what the first attempt looked
      // like.
      const s = moon.size;
      const face = [236, 242, 255];
      for (const [scale, mix] of [[2.0, 0.07], [1.45, 0.17]]) {
        corona(rd, moon.x, moon.y, Math.round(s * scale), face, mix);
      }
      const mx = Math.round(moon.x - s / 2), my = Math.round(moon.y - s / 2);
      rectAbove(rd, mx, my, s, s, face);
      // Two square seas, so it is plainly a moon and not a pale sun.
      const sea = [188, 198, 222];
      rectAbove(rd, mx + 2, my + 4, 5, 5, sea);
      rectAbove(rd, mx + 10, my + 9, 3, 3, sea);
    }
  }

  // Walk the fixed grid of tile corners from the back of the view to the
  // front, projecting each corner and filling in a tile once we have all four
  // of its corners. The grid never moves relative to the camera -- the world
  // slides through it -- which is why this is a fixed amount of work per
  // frame no matter where you are or how fast you are going.
  drawLandscape(eyeX, eyeY, eyeZ) {
    const rd = this.rd;

    // zCamera is the world z of the back-middle of the landscape.
    const zCamera = (eyeZ + LANDSCAPE_Z) | 0;
    const xCameraTile = eyeX & ~(TILE - 1);
    const zCameraTile = zCamera & ~(TILE - 1);
    const fracX = (eyeX - xCameraTile) | 0;
    const fracZ = (zCamera - zCameraTile) | 0;

    const eyeShadowZ = this.player.z;
    this.shadowRow = -1;

    for (const list of this.pending) list.length = 0;
    for (const list of this.pendingBoats) list.length = 0;
    for (const list of this.pendingBalloons) list.length = 0;
    for (const list of this.pendingLanterns) list.length = 0;
    for (const list of this.pendingCrabs) list.length = 0;

    // The landscape pass keeps depth: see Renderer.depthMode('paint'). The
    // picture is painter's order exactly as before; the depth buffer comes
    // out of it holding the nearest surface at every pixel.
    rd.depthMode('paint');
    let prevDepth = 1;

    for (let j = 0; j < TILES_Z; j++) {
      const worldZ = (zCameraTile - j * TILE) | 0;
      this.rowWorldZ[j] = worldZ;
      const viewZ = (LANDSCAPE_Z - fracZ - j * TILE) | 0;
      const tz = worldZ >> 24;
      // Every corner in a row is at the same distance, so one depth does the
      // whole row -- and anything drawn with the row that does not carry a
      // depth of its own takes this one.
      const rowDepth = depthOf(viewZ);
      rd.z = rowDepth;
      this.rowDepth[j] = rowDepth;

      // Any tank standing in this row's band of ground draws with it, so
      // hills in front still hide what is behind them.
      if (j > 0) {
        boatsInRow(worldZ, (worldZ + TILE) | 0, this.pendingBoats[j]);
        balloonsInRow(worldZ, (worldZ + TILE) | 0, this.pendingBalloons[j]);
        lanternsInRow(worldZ, (worldZ + TILE) | 0, this.pendingLanterns[j]);
        flamesInRow(worldZ, (worldZ + TILE) | 0, this.pendingFlames[j]);
        crabsInRow(worldZ, (worldZ + TILE) | 0, this.pendingCrabs[j]);
        // The craft's shadow belongs to whichever row the ground under it
        // is in, so it is drawn with that row and hidden by hills in front.
        if (eyeShadowZ >= worldZ && eyeShadowZ < worldZ + TILE) this.shadowRow = j;
      }

      let prevAlt = 0;

      // The row's arrays as locals, and the projection done here rather than
      // through project(): every corner in a row is at the same distance, so
      // whether it is in front of the camera is decided once per row, and a
      // function call per corner is real money with the JIT off. The
      // arithmetic is project()'s exactly, so the picture is unchanged.
      const rowX = this.rowX, rowY = this.rowY, rowOk = this.rowOk, rowAlt = this.rowAlt;
      const prevX = this.prevX, prevY = this.prevY, prevOk = this.prevOk;
      const inFront = viewZ >= DEPTH.NEAR;

      for (let i = 0; i < TILES_X; i++) {
        const worldX = (xCameraTile - LANDSCAPE_X + i * TILE) | 0;
        const viewX = (-LANDSCAPE_X - fracX + i * TILE) | 0;

        const tx = worldX >> 24;
        const tci = ((tx & TC_MASK) << 6) | (tz & TC_MASK);
        let alt;
        if (tcX[tci] === tx && tcZ[tci] === tz) {
          alt = tcAlt[tci];
        } else {
          alt = landAltitude(worldX, worldZ);
          tcX[tci] = tx; tcZ[tci] = tz; tcAlt[tci] = alt;
          tcObjVer[tci] = -1; tcRow[tci] = -1;
        }
        const viewY = (alt - eyeY) | 0;

        const ok = inFront;
        if (ok) {
          rowX[i] = CENTRE_X + (viewX * FOCAL_X) / viewZ;
          rowY[i] = CENTRE_Y + (viewY * FOCAL_Y) / viewZ;
        }
        rowOk[i] = ok ? 1 : 0;
        rowAlt[i] = alt;

        // Fill the tile whose far-left corner we saw last row.
        if (j > 0 && i > 0 && ok && rowOk[i - 1] && prevOk[i] && prevOk[i - 1]) {
          // The lift belongs to open water only. A tile with one corner
          // ashore is drawn as land, and brightening it would put surf on
          // the beach rather than in front of it.
          let col;
          if (tcRow[tci] === j && tcGen[tci] === lightGen) {
            col = tcCol[tci];
          } else {
            const wet = alt === SEA_LEVEL && prevAlt === SEA_LEVEL;
            col = tileColour(prevAlt, alt, j, worldX, worldZ, wet ? seaShade(worldX, worldZ) : 0);
            tcCol[tci] = col; tcRow[tci] = j; tcGen[tci] = lightGen;
          }
          rd.quadZ(
            prevX[i - 1], prevY[i - 1], prevDepth,
            prevX[i], prevY[i], prevDepth,
            rowX[i], rowY[i], rowDepth,
            rowX[i - 1], rowY[i - 1], rowDepth,
            col,
          );
        }

        prevAlt = alt;

        // Note any object standing on this tile, to be drawn a couple of rows
        // later so the landscape behind it is already down.
        if (j > 0) {
          if (tcObjVer[tci] !== objectsVersion) {
            const type = tcObj[tci] = objectAt(tx, tz);
            tcObjVer[tci] = objectsVersion;
            if (type >= 0) placeObject(tci, tx, tz, type);
          }
          if (tcObj[tci] >= 0) this.pending[j].push(tx, tz, tci);
        }
      }

      // Swap the row buffers.
      [this.prevX, this.rowX] = [this.rowX, this.prevX];
      [this.prevY, this.rowY] = [this.rowY, this.prevY];
      [this.prevOk, this.rowOk] = [this.rowOk, this.prevOk];

      if (j >= 2) {
        const ts = prof.now();
        this.flushObjects(j - 2, eyeX, eyeY, eyeZ);
        prof.lapTo(P_SCENERY, ts);
      }
      prevDepth = rowDepth;
    }

    // Anything left in the last couple of rows.
    let ts = prof.now();
    this.flushObjects(TILES_Z - 2, eyeX, eyeY, eyeZ);
    this.flushObjects(TILES_Z - 1, eyeX, eyeY, eyeZ);
    ts = prof.lap('scenery', ts);
    // The scenery that went to the GPU, all of it at once, tested against
    // the depth the pass above has just left behind.
    this.models.flush();
    prof.lap('gpu scenery pass', ts);
    rd.depthMode('off');
    rd.z = 1;
  }

  flushObjects(row, eyeX, eyeY, eyeZ) {
    const haze = fogForRow(row);
    // Objects are drawn a couple of rows after the ground they stand on, so
    // anything among them without a depth of its own -- a shadow, a
    // reflection -- takes the depth of their row rather than of the row
    // being laid when they are drawn.
    this.rd.z = this.rowDepth[row];

    // The craft's own shadow: it grows and fades as you climb, which is the
    // cue that was missing when judging height on an approach.
    if (row === this.shadowRow && this.state === STATE.PLAYING && !this.player.dead) {
      const p = this.player;
      const altTiles = Math.max(0, p.altitude / TILE);
      // The phoenix is a light, so its shadow is a soft one, and over it the
      // ground takes its glow: a warm pool, faint by day and bright by
      // night, spreading and thinning as it climbs -- which puts the bird
      // in the scene rather than pasted over it, and is a height cue of its
      // own. Its lamp is its fire, so there is no landing lamp as well.
      const phoenix = AIRFRAME === 'origami';
      if (altTiles < SHADOW_FADE) {
        const t = altTiles / SHADOW_FADE;
        drawShadow(this.rd, p.x, p.z,
          TILE * (0.46 + 0.62 * t),        // spreads with height
          (1 - t) * (phoenix ? 0.5 : 0.92),  // and fades
          eyeX, eyeY, eyeZ, row, haze, p.altitude);
      }
      if (phoenix && altTiles < FIRE_REACH) {
        // Two layers, wide and faint under narrow and stronger, so the glow
        // falls off towards its edge rather than stopping at one.
        const t = altTiles / FIRE_REACH;
        const k = (1 - t) * (1 - t * 0.4);
        const r = TILE * (1.15 + 1.3 * t);
        drawLightPool(this.rd, p.x, p.z, r, (0.14 + 0.20 * sky.lamp) * k,
          eyeX, eyeY, eyeZ, row, haze, FIRE_GLOW);
        drawLightPool(this.rd, p.x, p.z, r * 0.55, (0.16 + 0.26 * sky.lamp) * k,
          eyeX, eyeY, eyeZ, row, haze, FIRE_GLOW);
      } else if (!phoenix && sky.lamp > 0.05 && altTiles < LAMP_REACH) {
        // After dark the landing lamp throws a pool where the shadow was. It
        // spreads and thins with height exactly as a real beam would, which
        // makes it a height cue in its own right once the shadow is gone.
        const t = altTiles / LAMP_REACH;
        drawLightPool(this.rd, p.x, p.z,
          TILE * (0.44 + 1.15 * t),
          sky.lamp * 0.76 * (1 - t) * (1 - t * 0.4),
          eyeX, eyeY, eyeZ, row, haze);
      }
    }

    // Balloons first: they are the furthest thing in their row, being in the
    // air above it rather than standing on it.
    const sky2 = this.pendingBalloons[row];
    if (sky2 && sky2.length) {
      for (const e of sky2) drawBalloon(this.rd, e, eyeX, eyeY, eyeZ, haze);
      sky2.length = 0;
    }

    // Lanterns before the shipping in the same row: a canoe passing a drift
    // of them should be in front of them, not among them.
    const drift = this.pendingLanterns[row];
    if (drift && drift.length) {
      const __lanterns = !window.__layers || window.__layers.lanterns !== false;
      if (__lanterns && drift.length) {
        const tl = prof.now();
        for (const l of drift) drawLantern(this.rd, l, eyeX, eyeY, eyeZ, haze);
        prof.lapTo(P_LANTERNS, tl);
      }
      drift.length = 0;
    }

    // The phoenix's flames, over their ground, with their columns of light.
    const fl = this.pendingFlames[row];
    if (fl && fl.length) {
      for (const f of fl) drawFlame(this.rd, f, eyeX, eyeY, eyeZ, haze);
      fl.length = 0;
    }

    // Shadow crabs, on the ground of their row.
    const crabs = this.pendingCrabs[row];
    if (crabs && crabs.length) {
      for (const c of crabs) drawCrab(this.rd, c, eyeX, eyeY, eyeZ, haze, row);
      crabs.length = 0;
    }

    const shipping = this.pendingBoats[row];
    if (shipping && shipping.length) {
      for (const b of shipping) drawBoat(this.rd, b, eyeX, eyeY, eyeZ, haze);
      shipping.length = 0;
    }

    // Flowers stand on the ground this row has just drawn, and under
    // anything else standing on it.
    if (serene() && (!window.__layers || window.__layers.flowers !== false)) {
      const tf = prof.now();
      flowersInRow(this.rd, this.rowWorldZ[row], row, eyeX, eyeY, eyeZ, haze, sky.tick);
      prof.lapTo(P_FLOWERS, tf);
    }

    const list = this.pending[row];
    if (!list || list.length === 0) return;
    if (window.__layers && window.__layers.objects === false) { list.length = 0; return; }

    for (let k = 0; k < list.length; k += 3) {
      const tx = list[k], tz = list[k + 1];
      let tci = list[k + 2];
      // The cache entry noted two rows ago is still this tile's unless the
      // grid is wider than the cache, in which case it is worked out again
      // in a spare slot.
      if (tcX[tci] !== tx || tcZ[tci] !== tz || tcObjVer[tci] !== objectsVersion) {
        tci = TC * TC;
        tcObj[tci] = objectAt(tx, tz);
        if (tcObj[tci] < 0) continue;
        placeObject(tci, tx, tz, tcObj[tci]);
      }
      const type = tcObj[tci];
      const model = MODELS[type];
      const wx = tcWx[tci], wz = tcWz[tci], base = tcBase[tci];
      if (base >= SEA_LEVEL) continue;

      // Anything you are about to fly into stops being lit and becomes a
      // shape -- the same answer the near ground and the horizon already
      // give, for the same reason.
      const sil = silhouetteAmount((wx - eyeX) / TILE, (wz - eyeZ) / TILE);

      // A structure that has been knocked over is no longer one model: it is
      // its blocks again, wherever they have got to.
      const pile = isBlocks(type) ? pileAt(tx, tz) : null;
      if (pile) {
        // A fallen tree keeps its own colours; only the painted blocks take
        // the biome's.
        const dress = isNatural(type) ? -1 : tcBiome[tci];
        drawPile(this.rd, pile, eyeX, eyeY, eyeZ, haze, row, dress, sil);
        continue;
      }

      drawShadow(this.rd, wx, wz, model.radius * 0.85, 0.7,
                 eyeX, eyeY, eyeZ, row, haze, model.height * 0.5);
      drawModel(this.rd, tcModel[tci], null,
                wx, base, wz, eyeX, eyeY, eyeZ, haze, sil);

      // Wrecks smoulder.
      if (isWreck(type) && (this.smokeTick + tx * 7 + tz * 13) % 11 === 0) {
        spawnSmoke(wx, (base - model.height) | 0, wz);
      }
    }
    list.length = 0;
  }

  // --- HUD -----------------------------------------------------------------

  drawHud() {
    const rd = this.rd;
    const p = this.player;
    // Nothing on this display shouts. The old set was arcade colours -- a
    // hard white on a saturated green, warnings in pure red -- which is the
    // right palette for a machine that wants your attention and the wrong one
    // for a game about pottering about at dusk. These are the same readings
    // in the colours the sky is already using: chalk, sage, clay, and a warm
    // sand for anything that matters.
    const WHITE = [236, 240, 228];
    const DIM = [146, 166, 152];
    const WARM = [236, 198, 140];
    const CLAY = [232, 142, 116];
    const COOL = [156, 198, 214];

    drawText(rd, 'score', 4, 4, DIM);
    drawText(rd, pad(this.score, 6), 4 + textWidth('score '), 4, WHITE);
    // The phoenix's flames: how many of the five it has gathered, and a mark
    // for each, lit once taken.
    if (this.state !== STATE.TITLE) {
      drawText(rd, 'flames', 4, 14, DIM);
      const fx = 4 + textWidth('flames ');
      for (let i = 0; i < FLAME_COUNT; i++) {
        const lit = i < (this.flames | 0);
        const x = fx + i * 7, col = lit ? [255, 170, 60] : [96, 88, 84];
        rd.tri(x + 2.5, 14, x + 5, 20, x, 20, col);
        if (lit) rd.rect(x + 1.5, 17, 2, 2, [255, 236, 170]);
      }
    }

    const hi = 'best ' + pad(this.highScore, 6);
    drawText(rd, hi, SCREEN_W - 4 - textWidth(hi), 4, DIM);

    // Charge meter.
    // As long as the bird's room for energy, which grows with its flames: a
    // full load is the whole 92 pixels.
    const BAR_W = Math.round(92 * p.chargeCap / CHARGE_MAX), BAR_H = 6, bx = 4, by = SCREEN_H - 14;
    const frac = Math.max(0, p.charge / p.chargeCap);
    // The label flashes on the same threshold the beeps use, so there is
    // something to see for anyone playing with the sound off.
    const low = !p.charging && frac < LOW_CHARGE;
    drawText(rd, p.charging ? 'charging' : 'energy', bx, by - 10,
             p.charging ? COOL
             : low && beacon(28, 16) ? CLAY : DIM);
    rd.rect(bx - 1, by - 1, BAR_W + 2, BAR_H + 2, [58, 66, 60]);
    let barCol = frac > 0.5 ? [138, 196, 150] : frac > LOW_CHARGE ? WARM : CLAY;
    // Pulse while taking on charge, so it is obviously happening.
    if (p.charging && ((this.chargeTick | 0) >> 2) % 2 === 0) barCol = COOL;
    // ... and glow for a moment when a lamp tops it up.
    if (this.energyFlash > 0) {
      this.energyFlash--;
      if ((this.energyFlash >> 2) % 2 === 0) barCol = [255, 206, 130];
    }
    if (frac > 0) rd.rect(bx, by, Math.max(1, Math.round(BAR_W * frac)), BAR_H, barCol);

    // What is left of the airframe, shown only once some of it is not. An
    // undamaged craft does not need telling; a damaged one needs it at a
    // glance, next to the other thing that runs out.
    if (p.hits > 0 && this.state === STATE.PLAYING) {
      const hx = bx + BAR_W + 12;
      drawText(rd, 'hull', hx, by - 10, p.hits >= HULL_HITS - 1 ? CLAY : WARM);
      for (let i = 0; i < HULL_HITS; i++) {
        const gone = i >= HULL_HITS - p.hits;
        rd.rect(hx + i * 6, by, 4, BAR_H,
                gone ? [72, 58, 52] : p.hits >= HULL_HITS - 1 ? CLAY : WARM);
      }
    }

    // Two heights, because they answer two different questions.
    //
    // `alt` is the height above the sea: the one the ceiling is set in, and
    // the one that says where you are in the sky. The readout used to be
    // labelled alt and show the other one, height over whatever was directly
    // below, so it jumped with every hill passed over and said nothing about
    // how near the thin air was.
    //
    // `gnd` is that other one, now under its own name: how far the skids are
    // from the ground (or the water) straight down, which is the number that
    // matters when you are trying to put down.
    if (this.state === STATE.PLAYING) {
      const alt = (SEA_LEVEL - UNDERCARRIAGE_Y - p.y) / TILE;
      const gnd = Math.max(0, p.altitude / TILE);
      const altTxt = 'alt ' + alt.toFixed(1);
      const gndTxt = 'gnd ' + gnd.toFixed(1);
      drawText(rd, altTxt, SCREEN_W - 4 - textWidth(altTxt), 14, DIM);
      drawText(rd, gndTxt, SCREEN_W - 4 - textWidth(gndTxt), 25, DIM);

      // Say why the machine is not climbing. Both of these used to happen in
      // silence, which is how a limit gets mistaken for a fault.
      // Worded as what the machine is doing rather than as a fault. It is
      // the same information -- you are coming down, there is nothing left,
      // there is no more air -- said the way you would say it to someone
      // sitting next to you.
      if (p.flat) {
        drawText(rd, 'out of energy', SCREEN_W - 4 - textWidth('out of energy'), 36, CLAY);
      } else if (p.ceiling > 0.12) {
        drawText(rd, 'thin air up here', SCREEN_W - 4 - textWidth('thin air up here'), 36, WARM);
      }
    }

    if (this.state === STATE.PLAYING && p.protected) {
      // No number until the clock is actually running, since a number that
      // is not counting down is a broken one.
      const secs = Math.ceil(p.grace / 50);
      drawTextCentred(rd, p.launched ? 'take your time  ' + secs : 'take your time',
                      CENTRE_X, 30, COOL);
    }

    if (this.message) {
      drawTextCentred(rd, this.message, CENTRE_X, 96, [240, 224, 190], 2);
    }

    if (this.state === STATE.TITLE) {
      drawTextCentred(rd, 'twilight hover', CENTRE_X, 78, [238, 232, 216], 3);
      drawTextCentred(rd, 'press start to fly', CENTRE_X, 122, WHITE);
    }
  }
}

// Height, in tiles, at which the craft's shadow has faded out entirely, and
// at which its landing lamp stops reaching the ground.
const SHADOW_FADE = 7.0;
const LAMP_REACH = 5.5;
// The phoenix's own glow on the ground, and how far up it reaches.
const FIRE_REACH = 6.0;
const FIRE_GLOW = [255, 136, 44];

function mixCol(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function pad(n, width) {
  const s = String(Math.max(0, Math.floor(n)));
  return '0'.repeat(Math.max(0, width - s.length)) + s;
}

function loadHighScore() {
  try {
    return parseInt(localStorage.getItem('weblander.hi') || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function saveHighScore(v) {
  try { localStorage.setItem('weblander.hi', String(v)); } catch { /* private mode */ }
}
