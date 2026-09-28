// assemble-web.mjs -- stage the playable web build into a directory.
//
// One definition of "what the game is". The site used to be served straight
// from the repository root, which meant anything added alongside the game --
// workflows, scripts, a README, at one point a Rust crate and a flatpak
// manifest -- was published as part of it. This lists what the game actually
// consists of and copies out that and nothing else.

import { cp, mkdir, rm, readdir, writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Everything the game needs at runtime, and nothing else.
const CONTENT = ['index.html', 'css', 'js', 'icons'];

// Carried if present, ignored if not. The soundtrack is the only part of the
// game that is a file rather than code, and the game has to build and deploy
// without it -- a missing track is a quieter game, not a broken one.
const OPTIONAL = ['audio'];

const out = resolve(ROOT, process.argv[2] || '_site');
if (out === ROOT) {
  throw new Error('refusing to assemble into the repository root');
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const name of CONTENT) {
  const from = join(ROOT, name);
  if (!existsSync(from)) throw new Error('missing web content: ' + name);
  await cp(from, join(out, name), { recursive: true });
}

for (const name of OPTIONAL) {
  const from = join(ROOT, name);
  if (existsSync(from)) await cp(from, join(out, name), { recursive: true });
}

// Stamp the build: the commit it was made from, short, and when that was.
// GITHUB_SHA on the deploy runner; git itself anywhere else; 'dev' if
// neither can say.
function git(args) {
  try { return execSync('git ' + args, { cwd: ROOT, env: { ...process.env, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}
const sha = (process.env.GITHUB_SHA || git('rev-parse HEAD') || 'dev').slice(0, 7);
const date = git("log -1 --format=%cd --date=format-local:'%Y-%m-%d %H:%M UTC'");
await writeFile(join(out, 'js', 'build.js'),
  '// Written by scripts/assemble-web.mjs at deploy.\n' +
  'export const BUILD = ' + JSON.stringify({ hash: sha, date }) + ';\n');
console.log('build ' + sha + (date ? ' (' + date + ')' : ''));

const listed = await readdir(out);
console.log('staged ' + listed.length + ' entries into ' + out + ': ' + listed.join(', '));
