// achievements.js -- things to tick off, kept between visits.
//
// Some are a count kept across every flight -- flip fifty crabs, bounce off
// ten balloons -- and some are a single feat -- three balloon bounces in one
// stack, a x10 stack banked. Counts live in `stats`, feats and finished
// counts in `done`, both in one small record in localStorage. The game tells
// this what happened (count, unlock); this says what was earned by it, and
// whoever is listening (onEarn) makes the fuss.

const KEY = 'weblander.achievements';

// `stat` and `goal` for a count; neither for a feat.
export const ACHIEVEMENTS = [
  { id: 'hatch', name: 'first light', desc: 'hatch from the flame on the pad' },
  { id: 'flame', name: 'kindling', desc: 'gather a flame', stat: 'flames', goal: 1 },
  { id: 'whole', name: 'the phoenix is whole', desc: 'hold all five flames at once' },
  { id: 'loop', name: 'loop the loop', desc: 'fly a loop', stat: 'loops', goal: 1 },
  { id: 'loop10', name: 'aerobat', desc: 'fly ten loops', stat: 'loops', goal: 10 },
  { id: 'bounce', name: 'boing', desc: 'bounce off the top of a balloon', stat: 'bounces', goal: 1 },
  { id: 'bounce10', name: 'balloon hopper', desc: 'bounce off balloons ten times', stat: 'bounces', goal: 10 },
  { id: 'bounce3', name: 'up, up and away', desc: 'three balloon bounces in one stack' },
  { id: 'bunting', name: 'party line', desc: 'fly through the bunting five times', stat: 'bunting', goal: 5 },
  { id: 'canoe', name: 'all aboard', desc: 'land on a canoe', stat: 'canoes', goal: 1 },
  { id: 'canoe5', name: 'ferry', desc: 'land on canoes five times', stat: 'canoes', goal: 5 },
  { id: 'towers5', name: 'demolition', desc: 'knock over five block towers', stat: 'towers', goal: 5 },
  { id: 'towers25', name: 'wrecking ball', desc: 'knock over twenty-five block towers', stat: 'towers', goal: 25 },
  { id: 'trees', name: 'timber!', desc: 'knock over twenty trees', stat: 'trees', goal: 20 },
  { id: 'crabs10', name: 'crab wrangler', desc: 'squash or flip ten shadow crabs', stat: 'crabs', goal: 10 },
  { id: 'crabs50', name: 'scourge of the shore', desc: 'squash or flip fifty shadow crabs', stat: 'crabs', goal: 50 },
  { id: 'triple', name: 'hat trick', desc: 'flip three crabs with one fire bomb' },
  { id: 'skim1', name: 'spray', desc: 'skim low and fast over the sea', stat: 'skims', goal: 1 },
  { id: 'skim10', name: 'wave rider', desc: 'skim the sea ten times', stat: 'skims', goal: 10 },
  { id: 'skim', name: 'skipping stone', desc: 'hold a long skim over the sea' },
  { id: 'shave', name: 'close shaves', desc: 'twenty-five close shaves', stat: 'shaves', goal: 25 },
  { id: 'stack5', name: 'stacked', desc: 'bank a stack of x5 or more' },
  { id: 'stack10', name: 'sky high', desc: 'bank a stack of x10' },
  { id: 'bank1000', name: 'high roller', desc: 'bank 1000 points in one stack' },
  { id: 'nectar', name: 'sweet tooth', desc: 'sip nectar from ten tulips', stat: 'nectar', goal: 10 },
  { id: 'lamps', name: 'lamplighter', desc: 'gather twenty-five lamps off the water', stat: 'lamps', goal: 25 },
  { id: 'midnight', name: 'night owl', desc: 'be in the air at midnight' },
];

const record = load();

function load() {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { stats: r.stats || {}, done: r.done || {} };
  } catch {
    return { stats: {}, done: {} };
  }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(record)); } catch { /* private mode */ }
}

// Whoever wants to know when something is earned: the game, for the fanfare.
let listener = null;
export function onEarn(fn) { listener = fn; }

function earn(a) {
  if (record.done[a.id]) return false;
  record.done[a.id] = Date.now();
  if (listener) listener(a);
  return true;
}

// Something happened `n` more times.
export function count(stat, n = 1) {
  record.stats[stat] = (record.stats[stat] || 0) + n;
  for (const a of ACHIEVEMENTS) {
    if (a.stat === stat && record.stats[stat] >= a.goal) earn(a);
  }
  save();
}

// A feat.
export function unlock(id) {
  const a = ACHIEVEMENTS.find((q) => q.id === id);
  if (a && earn(a)) save();
}

export function isDone(id) { return !!record.done[id]; }

export function progress(a) {
  if (!a.stat) return record.done[a.id] ? 1 : 0;
  return Math.min(a.goal, record.stats[a.stat] || 0);
}

export function earnedCount() {
  return ACHIEVEMENTS.filter((a) => record.done[a.id]).length;
}

export function clearAchievements() {
  record.stats = {};
  record.done = {};
  save();
}
