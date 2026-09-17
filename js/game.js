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
import { drawRidges } from './ridges.js';
import { sampleRibbon, drawRibbon, resetRibbon } from './ribbon.js';
import { serene } from './style.js';
import { depthAt, waveLift, seaShade } from './sea.js';
import { updateWeather, drawWeather, resetWeather, weather, SNOW } from './weather.js';
import { drawClouds } from './clouds.js';
import { project, SCREEN_W, SCREEN_H, CENTRE_X } from './renderer.js';
import { Player, GRAVITY_START, CHARGE_MAX, HULL_HITS } from './player.js';
import { drawModel, drawShadow, drawLightPool } from './model.js';
import {
  MODELS, OBJ_SCORE, objectAt, objectOffset, destroyObject, isWreck,
  isBlocks, isOpen, spansZ, structureIndex, resetObjects,
} from './objects.js';
import { topple, updateBlocks, drawPile, pileAt } from './blocks.js';
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

export class Game {
  constructor(renderer, input, audio) {
    this.rd = renderer;
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
    this.pending = Array.from({ length: TILES_Z + 2 }, () => []);
    this.pendingBoats = Array.from({ length: TILES_Z + 2 }, () => []);
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
    resetWeather();
    this.player.reset();
    this.state = STATE.PLAYING;
  }

  // --- events from the player ---------------------------------------------

  onShot() { this.audio.shot(); }

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
    this.player.update(inp.stick, inp.thrust, inp.fire, this.gravity, this);
    this.audio.engine(this.player.thrusting);

    sampleRibbon(this.player);
    updateBoats(this.player, this);
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
        if (type < 0 || isWreck(type) || isOpen(type)) continue;
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

    // Sky first, in two bands so the falloff has a bend in it rather than
    // being a straight ramp from top to bottom, then the stars and whichever
    // of the sun or moon is up -- all of it behind the landscape.
    rd.gradientBand(0, SKY_BAND_1, sky.top, sky.mid);
    rd.gradientBand(SKY_BAND_1, SKY_BAND_2, sky.mid, sky.horizon);
    rd.gradientBand(SKY_BAND_2, SCREEN_H, sky.horizon, sky.horizon);

    // Ranges stand between the sky and everything else, so they go in here --
    // after the sky, before a single tile of landscape.
    if (serene()) drawRidges(rd, eyeX, eyeZ);
    this.drawStars();
    this.drawCelestial();
    // Clouds go over the sun and under the landscape, which is the only
    // ordering that lets one drift across the other.
    drawClouds(rd);

    this.drawLandscape(eyeX, eyeY, eyeZ);
    drawRibbon(rd, eyeX, eyeY, eyeZ);
    drawParticles(rd, eyeX, eyeY, eyeZ);
    if (this.state === STATE.PLAYING) p.draw(rd, eyeX, eyeY, eyeZ);
    drawWeather(rd, eyeX, eyeY, eyeZ);
    this.drawHud();

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
      // Three squares, each a step closer to the sun's colour from the sky
      // behind it, so the corona steps outwards in bands rather than ending
      // at a hard edge. Drawn outside-in, painter's algorithm doing the rest.
      const back = skyColourAt(sun.y);
      const s = sun.size;
      for (const [scale, mix] of [[2.6, 0.20], [1.8, 0.42], [1.3, 0.68]]) {
        const w = Math.round(s * scale);
        rd.rect(Math.round(sun.x - w / 2), Math.round(sun.y - w / 2), w, w,
                mixCol(back, sun.col, mix));
      }
      rd.rect(Math.round(sun.x - s / 2), Math.round(sun.y - s / 2), s, s, sun.col);
    }

    if (moon.up) {
      // The same stepped corona as the sun but far tighter, because a single
      // wide square of pale grey against a black sky does not read as glow --
      // it reads as a grey square, which is what the first attempt looked
      // like.
      const back = skyColourAt(moon.y);
      const s = moon.size;
      const face = [236, 242, 255];
      for (const [scale, mix] of [[2.0, 0.07], [1.45, 0.17]]) {
        const w = Math.round(s * scale);
        rd.rect(Math.round(moon.x - w / 2), Math.round(moon.y - w / 2), w, w,
                mixCol(back, face, mix));
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

    const pt = { x: 0, y: 0 };

    for (let j = 0; j < TILES_Z; j++) {
      const worldZ = (zCameraTile - j * TILE) | 0;
      const viewZ = (LANDSCAPE_Z - fracZ - j * TILE) | 0;
      const tz = worldZ >> 24;

      // Any tank standing in this row's band of ground draws with it, so
      // hills in front still hide what is behind them.
      if (j > 0) {
        boatsInRow(worldZ, (worldZ + TILE) | 0, this.pendingBoats[j]);
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
          rd.quad(
            this.prevX[i - 1], this.prevY[i - 1],
            this.prevX[i], this.prevY[i],
            this.rowX[i], this.rowY[i],
            this.rowX[i - 1], this.rowY[i - 1],
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
    }

    // Anything left in the last couple of rows.
    this.flushObjects(TILES_Z - 2, eyeX, eyeY, eyeZ);
    this.flushObjects(TILES_Z - 1, eyeX, eyeY, eyeZ);
  }

  flushObjects(row, eyeX, eyeY, eyeZ) {
    const haze = fogForRow(row);

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

    const shipping = this.pendingBoats[row];
    if (shipping && shipping.length) {
      for (const b of shipping) drawBoat(this.rd, b, eyeX, eyeY, eyeZ, haze);
      shipping.length = 0;
    }

    const list = this.pending[row];
    if (!list || list.length === 0) return;

    for (let k = 0; k < list.length; k += 3) {
      const tx = list[k], tz = list[k + 1], type = list[k + 2];
      const model = MODELS[type];
      const [jx, jz] = objectOffset(tx, tz);
      const wx = ((tx * TILE) | 0) + jx;
      const wz = ((tz * TILE) | 0) + jz;
      const base = landAltitude(wx, wz);
      if (base >= SEA_LEVEL) continue;

      // A structure that has been knocked over is no longer one model: it is
      // its blocks again, wherever they have got to.
      const pile = isBlocks(type) ? pileAt(tx, tz) : null;
      if (pile) {
        drawPile(this.rd, pile, eyeX, eyeY, eyeZ, haze, row);
        continue;
      }

      if (isOpen(type)) {
        // An arch stands on two feet and the light goes between them. One
        // round patch the width of the whole thing would put the darkest
        // shadow of the lot directly under the opening -- the one part of it
        // that is not there.
        const r = (model.radius * 0.34) | 0;
        const d = (model.radius * 0.60) | 0;
        const az = spansZ(type);
        for (const s of [-1, 1]) {
          drawShadow(this.rd, wx + (az ? 0 : s * d), wz + (az ? s * d : 0), r, 0.7,
                     eyeX, eyeY, eyeZ, row, haze, model.height * 0.5);
        }
      } else {
        drawShadow(this.rd, wx, wz, model.radius * 0.85, 0.7,
                   eyeX, eyeY, eyeZ, row, haze, model.height * 0.5);
      }
      drawModel(this.rd, model, null, wx, base, wz, eyeX, eyeY, eyeZ, haze);

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

    // Lives, as a row of pips.
    const lifeText = 'drones ' + Math.max(0, this.lives - 1);
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
      const secs = Math.ceil(p.grace / 50);
      drawTextCentred(rd, 'take your time  ' + secs, CENTRE_X, 30, COOL);
    }

    if (this.message) {
      drawTextCentred(rd, this.message, CENTRE_X, 96, [240, 224, 190], 2);
    }

    if (this.state === STATE.TITLE) {
      drawTextCentred(rd, 'weblander', CENTRE_X, 78, [238, 232, 216], 3);
      drawTextCentred(rd, 'press start to fly', CENTRE_X, 122, WHITE);
    } else if (this.state === STATE.GAMEOVER) {
      // Not GAME OVER. Nothing has been failed here -- the drones are simply
      // used up, and the next line is an invitation rather than a verdict.
      drawTextCentred(rd, 'out of drones', CENTRE_X, 92, [226, 172, 148], 2);
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
