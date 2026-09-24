// game.js -- the main loop: draw the world, fly the ship, keep the score.

import { TILE, rndInt, rnd } from './maths.js';
import {
  landAltitude, tileColour, fogForRow, SEA_LEVEL, LAUNCHPAD_ALT,
  TILES_X, TILES_Z, LANDSCAPE_X, LANDSCAPE_Z, LANDSCAPE_Z_MID,
  UNDERCARRIAGE_Y,
} from './landscape.js';
import {
  sky, sun, moon, STARS, advanceDay, skyColourAt, SKY_BAND_1, SKY_BAND_2, beacon,
} from './daylight.js';
import { drawRidges, drawNearGround, drawHorizonHaze, backdropAt } from './ridges.js';
import { flowersInRow, nearestFlower, takeFlower, resetFlowers } from './flowers.js';
import { sampleRibbon, drawRibbon, resetRibbon } from './ribbon.js';
import { serene } from './style.js';
import { depthAt, waveLift, seaShade } from './sea.js';
import { updateWeather, drawWeather, resetWeather, weather, SNOW } from './weather.js';
import { drawClouds } from './clouds.js';
import { project, depthOf, SCREEN_W, SCREEN_H, CENTRE_X } from './renderer.js';
import { ModelPass } from './modelpass.js';
import { drawTouchStick } from './stick.js';
import { Player, GRAVITY_START, CHARGE_MAX, HULL_HITS } from './player.js';
import { drawModel, drawShadow, drawLightPool, silhouetteAmount } from './model.js';
import {
  MODELS, OBJ_SCORE, objectAt, objectOffset, destroyObject, isWreck,
  isBlocks, isNatural, structureIndex, resetObjects, modelFor, biomeAt,
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
};


// What a lantern is worth, and how long a run may pause before it is over.
// Two seconds is long enough to line up the next one and short enough that
// the run has to be flown rather than wandered.
const LANTERN_SCORE = 10;

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

const STARTING_LIVES = 4;

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
function corona(rd, cx, cy, w, col, mix) {
  const x0 = Math.round(cx - w / 2), y0 = Math.round(cy - w / 2), y1 = y0 + w;
  const a = mixCol(backdropAt(y0, backTop), col, mix);
  const b = mixCol(backdropAt(y1, backBottom), col, mix);
  rd.quadShaded(x0, y0, a, x0 + w, y0, a, x0 + w, y1, b, x0, y1, b);
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
    this.input = input;
    this.audio = audio;

    this.player = new Player();
    this.highScore = loadHighScore();
    this.state = STATE.TITLE;

    // Scratch buffers for the landscape scan, allocated once.
    this.rowX = new Float64Array(TILES_X);
    this.rowY = new Float64Array(TILES_X);
    this.rowOk = new Uint8Array(TILES_X);
    this.rowAlt = new Int32Array(TILES_X);
    this.prevX = new Float64Array(TILES_X);
    this.prevY = new Float64Array(TILES_X);
    this.prevOk = new Uint8Array(TILES_X);

    // Objects waiting to be drawn, staggered behind the landscape.
    this.rowWorldZ = new Int32Array(TILES_Z + 2);
    this.rowDepth = new Float32Array(TILES_Z + 2);
    this.pending = Array.from({ length: TILES_Z + 2 }, () => []);
    this.pendingBoats = Array.from({ length: TILES_Z + 2 }, () => []);
    this.pendingBalloons = Array.from({ length: TILES_Z + 2 }, () => []);
    this.pendingLanterns = Array.from({ length: TILES_Z + 2 }, () => []);
    this.warnTick = 0;

    this.newGame();
    this.state = STATE.TITLE;
  }

  newGame() {
    this.score = 0;
    this.lives = STARTING_LIVES;
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
    this.player.reset();
    this.state = STATE.PLAYING;
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

    p.charge = Math.min(CHARGE_MAX, p.charge + NECTAR);
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
    this.audio.explosion();
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
    this.player.update(inp.stick, inp.thrust, inp.fire, this.gravity, this, inp.throttle, inp.turn, inp.hold);
    // Gated on the style for the same reason the drawing is: a flower you
    // can drink from and cannot see would be worse than no flower at all.
    if (serene() && this.state === STATE.PLAYING) this.sipNectar(this.player);
    this.audio.engine(this.player.thrusting);

    sampleRibbon(this.player);
    updateBoats(this.player, this);
    updateBalloons(this.player);
    updateLanterns(this.player, this);
    updateBlocks();
    updateParticles(this.gravity, (i, bx, by, bz) => this.bulletHit(i, bx, by, bz));

    // Low battery. The meter turning red is easy to miss with the ground
    // coming up at you and a tank to think about, so it says so out loud, and
    // says it faster the less there is left. Nothing while charging -- the
    // meter is low then too, and being nagged about a problem you are already
    // fixing is how a warning gets tuned out.
    const charge = this.player.charge / CHARGE_MAX;
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

  respawn() {
    this.lives--;
    if (this.lives <= 0) {
      this.state = STATE.GAMEOVER;
      this.setMessage(null, 0);
      this.audio.gameOver();
      this.audio.engine(0);
      return;
    }
    resetParticles();
    resetRibbon();
    this.player.reset();
    this.state = STATE.PLAYING;
    this.setMessage(null, 0);
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
    rd.begin(sky.top);

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

    // Stars next, because a star below the horizon has set: the haze of the
    // far plain goes in after them and takes them with it.
    if (on('stars')) this.drawStars();

    // The plain beyond the drawn landscape, and then the sun or the moon
    // standing on it, and only then the hills.
    //
    // The two halves of the horizon are deliberately either side of the sky's
    // furniture. A body should be hidden by hills, which are things, and not
    // by haze, which is only the colour of distance -- and with the haze in
    // front of it a setting sun disappeared forty rows above the skyline in
    // the middle of an empty sky.
    if (serene() && on('haze')) drawHorizonHaze(rd, eyeX, eyeY, eyeZ);
    if (on('celestial')) this.drawCelestial();
    if (serene() && on('ridges')) drawRidges(rd, eyeX, eyeY, eyeZ);

    // Balloons beyond the drawn landscape have no row to be bucketed into, so
    // they get a pass of their own -- here, after the ranges. They went in
    // before them at first, on the reasoning that a range in front should
    // hide one that had drifted down behind it. That was the wrong picture:
    // the ranges are a parallax backdrop standing at the very back of the
    // world, and the furthest balloon is nearer than the nearest of them, so
    // a balloon disappearing behind a ridge read as the balloon being miles
    // further off than it is. In front, where they belong.
    if (on('farBalloons')) drawFarBalloons(rd, eyeX, eyeY, eyeZ);

    // Clouds go over the sun and under the landscape, which is the only
    // ordering that lets one drift across the other.
    if (on('clouds')) drawClouds(rd);

    if (on('landscape')) this.drawLandscape(eyeX, eyeY, eyeZ);
    // ... and the ground that is too close to have been drawn at all, which
    // goes in front of it because it is in front of it.
    if (serene() && on('nearGround')) drawNearGround(rd, eyeX, eyeY, eyeZ);
    if (on('ribbon')) drawRibbon(rd, eyeX, eyeY, eyeZ);
    if (on('particles')) drawParticles(rd, eyeX, eyeY, eyeZ);
    if (this.state === STATE.PLAYING && on('player')) p.draw(rd, eyeX, eyeY, eyeZ);
    if (on('weather')) drawWeather(rd, eyeX, eyeY, eyeZ);
    if (on('hud')) this.drawHud();

    // The touch stick goes over everything, because it is the one thing on
    // screen that is not part of the world -- it is the player's own thumb,
    // drawn back at them.
    // Only when it is steering: under tilt a finger is just the engine.
    if (this.input.touchSteers) {
      drawTouchStick(this.rd, this.input.leftThumb.furniture);
      drawTouchStick(this.rd, this.input.rightThumb.furniture);
    }

    rd.flush();
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
      rd.rect(st.x, st.y, st.big ? 2 : 1, st.big ? 2 : 1, col);
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
      rd.rect(Math.round(sun.x - s / 2), Math.round(sun.y - s / 2), s, s, sun.col);
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
      rd.rect(mx, my, s, s, face);
      // Two square seas, so it is plainly a moon and not a pale sun.
      const sea = [188, 198, 222];
      rd.rect(mx + 2, my + 4, 5, 5, sea);
      rd.rect(mx + 10, my + 9, 3, 3, sea);
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

    const pt = { x: 0, y: 0 };

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
        // The craft's shadow belongs to whichever row the ground under it
        // is in, so it is drawn with that row and hidden by hills in front.
        if (eyeShadowZ >= worldZ && eyeShadowZ < worldZ + TILE) this.shadowRow = j;
      }

      let prevAlt = 0;

      for (let i = 0; i < TILES_X; i++) {
        const worldX = (xCameraTile - LANDSCAPE_X + i * TILE) | 0;
        const viewX = (-LANDSCAPE_X - fracX + i * TILE) | 0;

        const alt = landAltitude(worldX, worldZ);
        let viewY = (alt - eyeY) | 0;

        // Water heaves, and brightens with swell, surf and glitter. Both come
        // off the same depth, so it is worked out once per corner here rather
        // than twice inside sea.js.
        let seaLift = 0;
        if (alt === SEA_LEVEL) {
          const depth = depthAt(worldX, worldZ);
          viewY = (viewY + waveLift(worldX, worldZ, depth)) | 0;
          seaLift = seaShade(worldX, worldZ, viewX, viewZ, depth);
        }

        const ok = project(viewX, viewY, viewZ, pt);
        this.rowX[i] = pt.x;
        this.rowY[i] = pt.y;
        this.rowOk[i] = ok ? 1 : 0;
        this.rowAlt[i] = alt;

        // Fill the tile whose far-left corner we saw last row.
        if (j > 0 && i > 0 && ok && this.rowOk[i - 1] && this.prevOk[i] && this.prevOk[i - 1]) {
          // The lift belongs to open water only. A tile with one corner
          // ashore is drawn as land, and brightening it would put surf on
          // the beach rather than in front of it.
          const wet = alt === SEA_LEVEL && prevAlt === SEA_LEVEL;
          const col = tileColour(prevAlt, alt, j, worldX, worldZ, wet ? seaLift : 0);
          rd.quadZ(
            this.prevX[i - 1], this.prevY[i - 1], prevDepth,
            this.prevX[i], this.prevY[i], prevDepth,
            this.rowX[i], this.rowY[i], rowDepth,
            this.rowX[i - 1], this.rowY[i - 1], rowDepth,
            col,
          );
        }

        prevAlt = alt;

        // Note any object standing on this tile, to be drawn a couple of rows
        // later so the landscape behind it is already down.
        if (j > 0) {
          const tx = worldX >> 24;
          const type = objectAt(tx, tz);
          if (type >= 0) this.pending[j].push(tx, tz, type);
        }
      }

      // Swap the row buffers.
      [this.prevX, this.rowX] = [this.rowX, this.prevX];
      [this.prevY, this.rowY] = [this.rowY, this.prevY];
      [this.prevOk, this.rowOk] = [this.rowOk, this.prevOk];

      if (j >= 2) this.flushObjects(j - 2, eyeX, eyeY, eyeZ);
      prevDepth = rowDepth;
    }

    // Anything left in the last couple of rows.
    this.flushObjects(TILES_Z - 2, eyeX, eyeY, eyeZ);
    this.flushObjects(TILES_Z - 1, eyeX, eyeY, eyeZ);
    // The scenery that went to the GPU, all of it at once, tested against
    // the depth the pass above has just left behind.
    this.models.flush();
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
      if (altTiles < SHADOW_FADE) {
        const t = altTiles / SHADOW_FADE;
        drawShadow(this.rd, p.x, p.z,
          TILE * (0.46 + 0.62 * t),        // spreads with height
          (1 - t) * 0.92,                  // and fades
          eyeX, eyeY, eyeZ, row, haze, p.altitude);
      }
      // After dark the landing lamp throws a pool where the shadow was. It
      // spreads and thins with height exactly as a real beam would, which
      // makes it a height cue in its own right once the shadow is gone.
      if (sky.lamp > 0.05 && altTiles < LAMP_REACH) {
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
      if (__lanterns) for (const l of drift) drawLantern(this.rd, l, eyeX, eyeY, eyeZ, haze);
      drift.length = 0;
    }

    const shipping = this.pendingBoats[row];
    if (shipping && shipping.length) {
      for (const b of shipping) drawBoat(this.rd, b, eyeX, eyeY, eyeZ, haze);
      shipping.length = 0;
    }

    // Flowers stand on the ground this row has just drawn, and under
    // anything else standing on it.
    if (serene() && (!window.__layers || window.__layers.flowers !== false)) {
      flowersInRow(this.rd, this.rowWorldZ[row], row, eyeX, eyeY, eyeZ, haze, sky.tick);
    }

    const list = this.pending[row];
    if (!list || list.length === 0) return;
    if (window.__layers && window.__layers.objects === false) { list.length = 0; return; }

    for (let k = 0; k < list.length; k += 3) {
      const tx = list[k], tz = list[k + 1], type = list[k + 2];
      const model = MODELS[type];
      const [jx, jz] = objectOffset(tx, tz);
      const wx = ((tx * TILE) | 0) + jx;
      const wz = ((tz * TILE) | 0) + jz;
      const base = landAltitude(wx, wz);
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
        const dress = isNatural(type) ? -1 : biomeAt(tx, tz);
        drawPile(this.rd, pile, eyeX, eyeY, eyeZ, haze, row, dress, sil);
        continue;
      }

      drawShadow(this.rd, wx, wz, model.radius * 0.85, 0.7,
                 eyeX, eyeY, eyeZ, row, haze, model.height * 0.5);
      drawModel(this.rd, modelFor(type, biomeAt(tx, tz)), null,
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

    const hi = 'best ' + pad(this.highScore, 6);
    drawText(rd, hi, SCREEN_W - 4 - textWidth(hi), 4, DIM);

    // Charge meter.
    const BAR_W = 92, BAR_H = 6, bx = 4, by = SCREEN_H - 14;
    const frac = Math.max(0, p.charge / CHARGE_MAX);
    // The label flashes on the same threshold the beeps use, so there is
    // something to see for anyone playing with the sound off.
    const low = !p.charging && frac < LOW_CHARGE;
    drawText(rd, p.charging ? 'charging' : 'battery', bx, by - 10,
             p.charging ? COOL
             : low && beacon(28, 16) ? CLAY : DIM);
    rd.rect(bx - 1, by - 1, BAR_W + 2, BAR_H + 2, [58, 66, 60]);
    let barCol = frac > 0.5 ? [138, 196, 150] : frac > LOW_CHARGE ? WARM : CLAY;
    // Pulse while taking on charge, so it is obviously happening.
    if (p.charging && ((this.chargeTick | 0) >> 2) % 2 === 0) barCol = COOL;
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

    // How many more are left. Not drones in a hangar any more.
    const lifeText = 'birds ' + Math.max(0, this.lives - 1);
    drawText(rd, lifeText, SCREEN_W - 4 - textWidth(lifeText), by, DIM);

    // Altitude, which matters most when you are trying to put down.
    if (this.state === STATE.PLAYING) {
      const alt = Math.max(0, p.altitude / TILE);
      const txt = 'alt ' + alt.toFixed(1);
      drawText(rd, txt, SCREEN_W - 4 - textWidth(txt), 14, DIM);

      // Say why the machine is not climbing. Both of these used to happen in
      // silence, which is how a limit gets mistaken for a fault.
      // Worded as what the machine is doing rather than as a fault. It is
      // the same information -- you are coming down, there is nothing left,
      // there is no more air -- said the way you would say it to someone
      // sitting next to you.
      if (p.autorotating) {
        drawText(rd, 'gliding down', SCREEN_W - 4 - textWidth('gliding down'), 25, WARM);
      } else if (p.flat) {
        drawText(rd, 'out of charge', SCREEN_W - 4 - textWidth('out of charge'), 25, CLAY);
      } else if (p.ceiling > 0.12) {
        drawText(rd, 'thin air up here', SCREEN_W - 4 - textWidth('thin air up here'), 25, WARM);
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
      drawTextCentred(rd, 'weblander', CENTRE_X, 78, [238, 232, 216], 3);
      drawTextCentred(rd, 'press start to fly', CENTRE_X, 122, WHITE);
    } else if (this.state === STATE.GAMEOVER) {
      // Not GAME OVER. Nothing has been failed here -- the birds are simply
      // used up, and the next line is an invitation rather than a verdict.
      drawTextCentred(rd, 'out of birds', CENTRE_X, 92, [226, 172, 148], 2);
      drawTextCentred(rd, 'you scored ' + this.score, CENTRE_X, 118, WHITE);
      drawTextCentred(rd, 'press start to fly again', CENTRE_X, 136, DIM);
    }
  }
}

// Height, in tiles, at which the craft's shadow has faded out entirely, and
// at which its landing lamp stops reaching the ground.
const SHADOW_FADE = 7.0;
const LAMP_REACH = 5.5;

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
