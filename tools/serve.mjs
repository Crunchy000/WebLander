// serve.mjs -- the game, served from inside the tool that wants it.
//
// The tools used to expect a web server already running on port 8123
// (python3 -m http.server), started by hand and left in the background. Left
// in the background is where it went wrong: it died between sessions, or hung,
// and every tool then failed on a refused connection that had nothing to do
// with what it was testing. So each tool now starts its own: a small static
// server on a free port, in the same process, gone when the tool exits.
//
//   import { base } from './serve.mjs';
//   await pg.goto(await base() + '?perf=1');
//
// BASE in the environment still wins, for pointing a tool at another build
// (a git worktree of the previous commit, say) served however you like.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

let started = null;

// The URL of the game, with a trailing slash. Starts the server the first time
// it is asked for, serving `root` (the repository by default).
export function base(root = ROOT) {
  if (process.env.BASE) return Promise.resolve(process.env.BASE);
  if (started) return started;
  started = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.join(root, rel);
      // Nothing outside the root.
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, {
          'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      });
    });
    // Neither the server nor its connections keep the tool alive: when the
    // tool is done, it exits, and the server goes with it.
    server.on('connection', (s) => s.unref());
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      resolve(`http://127.0.0.1:${server.address().port}/`);
    });
  });
  return started;
}
