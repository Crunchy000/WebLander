// settings.js -- the player's settings, kept between visits.
//
// Sound, the mix, how the mouse steers and how sharp the picture is. The
// defaults are the game as it was before there were settings, so nobody who
// never opens the page notices it exists. Stored as one small JSON record;
// anything missing or malformed in it falls back to the default, so an old
// record from an earlier version is never a reason for the game not to start.

const KEY = 'weblander.settings';

export const DEFAULTS = {
  sound: true,       // everything on or off (M)
  volume: 1,         // 0 to 1: all of it
  music: 1,          // 0 to 1: the soundtrack
  effects: 1,        // 0 to 1: everything else
  mouse: 1,          // how far a given hand movement leans the bird; 0.5 to 2
  picture: 0,        // index into PICTURES
  steer: 'relative', // the sticks: 'relative' (turn and pitch) or 'screen' (lean where you point)
};

// How sharp the picture is: the share of the display's own resolution the
// game is drawn at (an index into the renderer's scales). Sharp is all of
// it; the others are for a machine that cannot keep up.
export const PICTURES = [
  { name: 'sharp', scale: 0 },
  { name: 'balanced', scale: 1 },
  { name: 'fast', scale: 3 },
];

export const settings = load();

function load() {
  const out = { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof raw[k] === typeof DEFAULTS[k]) out[k] = raw[k];
    }
  } catch { /* private mode, or nothing saved */ }
  out.volume = clamp01(out.volume);
  out.music = clamp01(out.music);
  out.effects = clamp01(out.effects);
  out.mouse = Math.max(0.5, Math.min(2, out.mouse));
  out.picture = Math.max(0, Math.min(PICTURES.length - 1, out.picture | 0));
  if (out.steer !== 'relative' && out.steer !== 'screen') out.steer = DEFAULTS.steer;
  return out;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, +v || 0));
}

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}
