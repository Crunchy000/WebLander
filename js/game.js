// game.js -- the main loop: draw the world, fly the ship, keep the score.

import { TILE, rndInt, rnd } from './maths.js';
import {
  landAltitude, tileColour, SKY_COLOUR, SEA_LEVEL, LAUNCHPAD_ALT,
  TILES_X, TILES_Z, LANDSCAPE_X, LANDSCAPE_Z, LANDSCAPE_Z_MID,
  UNDERCARRIAGE_Y,
} from './landscape.js';
import { project, SCREEN_W, SCREEN_H, CENTRE_X } from './renderer.js';
import { Player, GRAVITY_START, FUEL_MAX } from './player.js';
import { drawModel } from './model.js';
import {
  MODELS, OBJ_SCORE, objectAt, objectOffset, destroyObject, isWreck,
  resetObjects,
} from './objects.js';
import {
  updateParticles, drawParticles, resetParticles, particleData,
  spawnExplosion, spawnSparks, spawnSmoke, particleCount, P_BULLET,
} from './particles.js';
import { drawText, drawTextCentred, textWidth } from './font.js';

export const STATE = { TITLE: 0, PLAYING: 1, DYING: 2, GAMEOVER: 3 };


const STARTING_LIVES = 4;

// The game runs on a fixed 50Hz step regardless of how often the display
// refreshes, so the physics constants -- which are all per-frame, as they were
// on hardware with a fixed frame rate -- behave identically everywhere.
export const STEP_MS = 20;

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
    this.player.reset();
    this.state = STATE.PLAYING;
  }

  // --- events from the player ---------------------------------------------

  onShot() { this.audio.shot(); }

  onTouchdown(onPad) {
    this.audio.touchdown();
    if (onPad) this.setMessage('REFUELLING', 90);
  }

  onRefuel() {
    if ((this.refuelTick = (this.refuelTick | 0) + 1) % 6 === 0) this.audio.refuel();
  }

  onDeath(how) {
    this.audio.explosion();
    this.state = STATE.DYING;
    this.setMessage(how === 'sea' ? 'LOST AT SEA' : 'CRASHED', 110);
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

    if (this.state === STATE.TITLE || this.state === STATE.GAMEOVER) {
      // The landscape keeps drifting behind the title, as an attract mode.
      this.player.z = (this.player.z + TILE * 0.012) | 0;
      updateParticles(this.gravity, () => false);
      if (inp.consumeStart() || inp.thrust) {
        this.audio.start();
        this.newGame();
      }
      return;
    }

    if (this.state === STATE.DYING) {
      updateParticles(this.gravity, () => false);
      this.player.deathTimer--;
      if (this.player.deathTimer <= 0) this.respawn();
      if (this.messageTimer > 0) this.messageTimer--;
      return;
    }

    // Playing.
    this.player.update(inp.stick, inp.thrust, inp.fire, this.gravity, this);
    this.audio.engine(this.player.thrusting);

    updateParticles(this.gravity, (i, bx, by, bz) => this.bulletHit(i, bx, by, bz));

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
    this.player.reset();
    this.state = STATE.PLAYING;
    this.setMessage(null, 0);
  }

  // A bullet has moved; see whether it has struck anything worth destroying.
  bulletHit(i, bx, by, bz) {
    const ground = landAltitude(bx, bz);

    // Check the tile the bullet is over, and its neighbours, for scenery.
    const tx = bx >> 24, tz = bz >> 24;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ox = (tx + dx) | 0, oz = (tz + dz) | 0;
        const type = objectAt(ox, oz);
        if (type < 0 || isWreck(type)) continue;

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
        this.audio.explosion();
      } else {
        this.audio.splash();
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
    rd.begin(SKY_COLOUR);

    const p = this.player;
    const eyeX = p.camX, eyeY = p.camY, eyeZ = p.camZ;

    this.drawLandscape(eyeX, eyeY, eyeZ);
    drawParticles(rd, eyeX, eyeY, eyeZ);
    if (this.state === STATE.PLAYING) p.draw(rd, eyeX, eyeY, eyeZ);
    this.drawHud();

    rd.flush();
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

    for (const list of this.pending) list.length = 0;

    const pt = { x: 0, y: 0 };

    for (let j = 0; j < TILES_Z; j++) {
      const worldZ = (zCameraTile - j * TILE) | 0;
      const viewZ = (LANDSCAPE_Z - fracZ - j * TILE) | 0;
      const tz = worldZ >> 24;

      let prevAlt = 0;

      for (let i = 0; i < TILES_X; i++) {
        const worldX = (xCameraTile - LANDSCAPE_X + i * TILE) | 0;
        const viewX = (-LANDSCAPE_X - fracX + i * TILE) | 0;

        const alt = landAltitude(worldX, worldZ);
        const viewY = (alt - eyeY) | 0;

        const ok = project(viewX, viewY, viewZ, pt);
        this.rowX[i] = pt.x;
        this.rowY[i] = pt.y;
        this.rowOk[i] = ok ? 1 : 0;
        this.rowAlt[i] = alt;

        // Fill the tile whose far-left corner we saw last row.
        if (j > 0 && i > 0 && ok && this.rowOk[i - 1] && this.prevOk[i] && this.prevOk[i - 1]) {
          const col = tileColour(prevAlt, alt, j);
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

      drawModel(this.rd, model, null, wx, base, wz, eyeX, eyeY, eyeZ);

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
    const WHITE = [230, 245, 230];
    const DIM = [120, 170, 130];

    drawText(rd, 'SCORE', 4, 4, DIM);
    drawText(rd, pad(this.score, 6), 4 + textWidth('SCORE '), 4, WHITE);

    const hi = 'HI ' + pad(this.highScore, 6);
    drawText(rd, hi, SCREEN_W - 4 - textWidth(hi), 4, DIM);

    // Fuel gauge.
    const BAR_W = 92, BAR_H = 6, bx = 4, by = SCREEN_H - 12;
    drawText(rd, 'FUEL', bx, by - 9, DIM);
    rd.rect(bx - 1, by - 1, BAR_W + 2, BAR_H + 2, [40, 60, 45]);
    const frac = Math.max(0, p.fuel / FUEL_MAX);
    const fuelCol = frac > 0.5 ? [80, 220, 100] : frac > 0.22 ? [230, 200, 60] : [230, 70, 50];
    if (frac > 0) rd.rect(bx, by, Math.max(1, Math.round(BAR_W * frac)), BAR_H, fuelCol);

    // Lives, as a row of pips.
    const lifeText = 'SHIPS ' + Math.max(0, this.lives - 1);
    drawText(rd, lifeText, SCREEN_W - 4 - textWidth(lifeText), SCREEN_H - 12, DIM);

    // Altitude, which matters most when you are trying to put down.
    if (this.state === STATE.PLAYING) {
      const alt = Math.max(0, p.altitude / TILE);
      const txt = 'ALT ' + alt.toFixed(1);
      drawText(rd, txt, SCREEN_W - 4 - textWidth(txt), 14, DIM);
    }

    if (this.state === STATE.PLAYING && p.protected) {
      const secs = Math.ceil(p.grace / 50);
      drawTextCentred(rd, 'SAFE ' + secs, CENTRE_X, 30, [110, 200, 255]);
    }

    if (this.message) {
      drawTextCentred(rd, this.message, CENTRE_X, 96, [255, 230, 120], 2);
    }

    if (this.state === STATE.TITLE) {
      drawTextCentred(rd, 'WEBLANDER', CENTRE_X, 78, [160, 255, 200], 3);
      drawTextCentred(rd, 'PRESS START TO FLY', CENTRE_X, 120, WHITE);
    } else if (this.state === STATE.GAMEOVER) {
      drawTextCentred(rd, 'GAME OVER', CENTRE_X, 92, [255, 120, 100], 3);
      drawTextCentred(rd, 'SCORE ' + this.score, CENTRE_X, 126, WHITE);
      drawTextCentred(rd, 'PRESS START', CENTRE_X, 142, DIM);
    }
  }
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
