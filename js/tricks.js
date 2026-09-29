// tricks.js -- tricks, and stacking them.
//
// Loop the loop, bounce off a balloon, thread the bunting, knock a stack
// over, skim the sea, shave past a tree, squash or flip a crab: each is a
// trick, and tricks done one after another stack. Every trick adds its
// points to the pot and one to the multiplier; the next has to come within
// COMBO_WINDOW of the last, or the stack is banked -- pot times multiplier,
// into the score. Setting down banks it too. Crashing loses it.
//
// The same trick again in one stack is worth half what it was the time
// before (never less than a quarter), so a stack of ten loops pays less
// than a stack of five different things -- variety is the trick.

export const COMBO_WINDOW = 200;    // steps: four seconds to find the next one
const MAX_MULT = 10;

export class Combo {
  constructor() {
    this.reset();
    this.lost = 0;                  // steps "combo lost" stays on the HUD
  }

  reset() {
    this.names = [];
    this.counts = Object.create(null);
    this.pot = 0;
    this.n = 0;
    this.timer = 0;
    this.flash = 0;
  }

  get active() { return this.n > 0; }
  get mult() { return Math.min(MAX_MULT, this.n); }
  get total() { return this.pot * this.mult; }

  // A trick. Returns what it added to the pot.
  add(name, base) {
    const k = this.counts[name] || 0;
    this.counts[name] = k + 1;
    const value = Math.max(Math.round(base / 4), Math.round(base / (1 << Math.min(k, 8))));
    this.pot += value;
    this.n++;
    this.names.push(name);
    this.timer = COMBO_WINDOW;
    this.flash = 24;
    this.lost = 0;
    return value;
  }

  // Something is still going on -- a skim in progress -- so the stack is
  // not allowed to run out underneath it.
  hold() {
    if (this.n && this.timer < COMBO_WINDOW / 2) this.timer = COMBO_WINDOW / 2;
  }

  // A step. True when the window has just closed on a live stack.
  tick() {
    if (this.flash > 0) this.flash--;
    if (this.lost > 0) this.lost--;
    return this.n > 0 && --this.timer <= 0;
  }
}
