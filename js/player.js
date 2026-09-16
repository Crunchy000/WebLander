// player.js -- the lander: how it is drawn, how it flies, and how it dies.
//
// The craft has no independent yaw. It leans, and leaning is what moves you:
// thrust always acts along the ship's own "up" axis, so tilting trades lift
// for sideways acceleration. That single idea is the whole flight model, and
// it is why the controls map so naturally onto a phone you physically tilt.

import { TILE, matFromAim, matApply, clamp, rnd, rndSigned } from './maths.js';
import { Model, shade, facet, drawModel } from './model.js';
import {
  landAltitude, SEA_LEVEL, LAUNCHPAD_ALT, LAUNCHPAD_Y,
  UNDERCARRIAGE_Y, LANDING_SPEED, LANDSCAPE_Z_MID, isOnLaunchpad,
  groundRoughness, FLAT_ENOUGH,
} from './landscape.js';
import { MODELS, objectAt, objectOffset, isWreck, isBlocks, structureIndex } from './objects.js';
import { topple, isKnocked } from './blocks.js';
import { weather } from './weather.js';
import { project } from './renderer.js';
import { spawnExhaust, spawnBomb, spawnExplosion, spawnSparks, spawnDust } from './particles.js';
import { drawUav } from './uav.js';

// Which airframe to fly. The faceted lander and the tilt-rotor UAV share the
// same flight model, so this is a straight swap.
export const AIRFRAME = 'uav';   // 'lander' | 'uav'

// --- tuning ----------------------------------------------------------------

export const GRAVITY_START = 0x02800;
// The eye sits at y = 0, which is also the height of the tallest possible
// peak: the game is played skimming the landscape, within about five tiles of
// the ground, not cruising above it. The engines cut out just above that, so
// climbing is self-limiting and the landscape always stays in frame.
export const HIGHEST_ALTITUDE = -(TILE * 3);

// Where lift starts fading rather than where it stops. A tile and a bit of
// warning is enough to feel the air thinning and back off.
const CEILING_SOFT = HIGHEST_ALTITUDE + TILE * 1.2;
// Battery capacity. Doubled from the original tank so a sortie lasts about
// twice as long; the charge rate is doubled to match, so topping up still
// takes the same time on the ground.
export const CHARGE_MAX = 0x8000;

const THRUST_HOVER = 0x06600;   // hover thrust, doubled again for a much faster feel
const THRUST_FULL  = 0x0C000;   // full-throttle thrust, doubled again
const MAX_LEAN = 0.95;          // radians at full stick deflection -- steeper dives, more lean-to-speed
const LEAN_RATE = 0.30;         // how fast the craft follows the stick -- snappier response
const DRAG = 0.985;             // damping; without it the craft is unflyable

const DRAW_HOVER = 3;    // power drawn per frame while hovering
const DRAW_FULL = 8;     // ... and under full thrust
