// assemble-web.mjs -- stage the playable web build into a directory.
//
// One definition of "what the game is", used by both the Pages deploy and the
// desktop bundler. Without it the two drift: the site is served from the repo
// root, so anything added alongside it -- a Rust crate, a flatpak manifest,
// a node_modules -- would be published as part of the game, and the desktop
// build would have to be told separately which files to swallow.

import { cp, mkdir, rm, readdir } from 'fs/promises';
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

const listed = await readdir(out);
console.log('staged ' + listed.length + ' entries into ' + out + ': ' + listed.join(', '));
