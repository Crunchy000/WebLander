// debugpanel.js -- the frame's figures as a QR code, and switches for the
// likely culprits, for machines whose console nobody can reach.
//
// A console browser on a television has no developer tools worth the name,
// and reading numbers off the screen and typing them into a phone is how
// they get garbled. So B on the pad (or the B key) opens a panel: the same
// figures the perf overlay shows, the machine they came from, and a QR code
// of all of it that a phone can read across the room.
//
// Next to it, switches. The renderer has no lighting or shadow pipeline in
// the usual sense -- it is flat triangles, coloured on the CPU, with one
// small shader for the instanced scenery -- so the switches are the things
// that actually cost something here: that shader pass, the render scale,
// the shadows, and each layer of the picture. Turning one off and watching
// the frame time is the cheapest profiler there is. What is off goes into
// the QR code too, so the figures always say what they were measured with.
//
// While the panel is open the flight is paused but the frame is still drawn
// every time, so the figures are the cost of drawing, not of a frozen image.
// The switches last until the page is reloaded.

import { qrcode } from './vendor/qrcode.mjs';
import { perfReport } from './perf.js';

// window.__layers is what game.js reads to leave a layer out. The keys are
// its names; the labels are what they are called on screen.
const LAYERS = [
  ['objects', 'trees & buildings'],
  ['flowers', 'flowers'],
  ['lanterns', 'lanterns'],
  ['farBalloons', 'balloons'],
  ['shadows', 'shadows'],
  ['landscape', 'ground'],
  ['ridges', 'far hills'],
  ['haze', 'haze'],
  ['sky', 'sky'],
  ['clouds', 'clouds'],
  ['celestial', 'sun & moon'],
  ['stars', 'stars'],
  ['weather', 'rain & snow'],
  ['particles', 'particles'],
  ['ribbon', 'streamer'],
  ['hud', 'hud'],
];

const REFRESH_MS = 1000;
const QR_CELL = 4;           // CSS pixels per module: readable across a room
const QR_MARGIN = 4;         // modules of quiet zone, as the standard asks

export class DebugPanel {
  constructor({ renderer, game, canvas }) {
    this.renderer = renderer;
    this.game = game;
    this.canvas = canvas;
    this.open = false;
    this.sel = 0;
    this.was = {};             // pad buttons last frame, for edges
    this.lastRefresh = 0;
    this.box = null;

    if (typeof window !== 'undefined') {
      if (!window.__layers) window.__layers = {};
      // Captured, and first: while the panel is open its keys are its own,
      // and the game must not also see them as steering or a start press.
      window.addEventListener('keydown', (e) => this._key(e), { capture: true });
    }

    const rd = renderer;
    this.items = [
      {
        label: 'gpu scenery',
        value: () => (!game.models.ok ? 'n/a' : rd.instancer ? 'on' : 'off'),
        act: () => { if (game.models.ok) rd.instancer = rd.instancer ? null : game.models; },
      },
      {
        label: 'resolution',
        value: () => (rd.fixed == null ? 'auto ' : 'fixed ') + Math.round(rd.scale * 100) + '%',
        // auto, then each scale from the largest down, then auto again.
        act: () => {
          const n = rd.scales.length;
          rd.fixed = rd.fixed == null ? 0 : rd.fixed + 1 < n ? rd.fixed + 1 : null;
          if (rd.fixed != null) rd.want = rd.fixed;
        },
      },
      ...LAYERS.map(([key, label]) => ({
        label,
        value: () => (window.__layers[key] === false ? 'off' : 'on'),
        act: () => { window.__layers[key] = window.__layers[key] === false; },
      })),
    ];
  }

  // What has been changed from normal, for the report.
  changes() {
    const out = [];
    for (const it of this.items) {
      const v = it.value();
      if (v === 'off' || v.startsWith('fixed')) out.push(it.label + ' ' + v);
    }
    return out;
  }

  toggle() {
    this.open = !this.open;
    if (this.open) this._show(); else this._hide();
  }

  // Called once a frame, paused or not. The pad is read here directly,
  // because while the panel is open the game is not sampling its input.
  poll(now) {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (pad) {
      const down = (i) => !!(pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.5));
      const ly = pad.axes.length > 1 ? pad.axes[1] : 0;
      const now_ = {
        b: down(1), a: down(0),
        up: down(12) || ly < -0.6, dn: down(13) || ly > 0.6,
      };
      const edge = (k) => now_[k] && !this.was[k];
      if (edge('b')) this.toggle();
      else if (this.open) {
        if (edge('up')) this._move(-1);
        if (edge('dn')) this._move(1);
        if (edge('a')) this._act(this.sel);
      }
      this.was = now_;
    }
    if (this.open && now - this.lastRefresh > REFRESH_MS) this._render();
  }

  _key(e) {
    if (e.code === 'KeyB' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.toggle();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!this.open) return;
    const k = e.code;
    if (k === 'ArrowUp' || k === 'KeyW') this._move(-1);
    else if (k === 'ArrowDown' || k === 'KeyS') this._move(1);
    else if (k === 'Enter' || k === 'Space') this._act(this.sel);
    else if (k === 'Escape') this.toggle();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  _move(d) {
    const n = this.items.length;
    this.sel = (this.sel + d + n) % n;
    this._render();
  }

  _act(i) {
    this.sel = i;
    this.items[i].act();
    this._render();
  }

  _show() {
    if (!this.box) {
      const box = document.createElement('div');
      box.id = 'debugpanel';
      box.style.cssText = 'position:fixed;inset:8px;z-index:60;display:flex;gap:16px;' +
        'align-items:flex-start;justify-content:center;flex-wrap:wrap;overflow:auto;' +
        'font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#dfe9f5;' +
        'background:rgba(8,12,22,0.86);padding:12px;border-radius:6px;';
      const list = document.createElement('div');
      list.style.cssText = 'min-width:17em';
      const right = document.createElement('div');
      right.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-width:min(60ch,100%)';
      // An image rather than a live canvas: it is redrawn once a second, and
      // a canvas that changes size inside a reflowing panel left a stale
      // copy of itself composited below the text.
      const qr = document.createElement('img');
      qr.alt = 'QR code of the figures';
      qr.style.cssText = 'align-self:flex-start;image-rendering:pixelated;background:#fff';
      this.qrCanvas = document.createElement('canvas');
      const text = document.createElement('pre');
      text.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;font:inherit;color:#b9c9dc';
      right.append(qr, text);
      box.append(list, right);
      // Tapped or clicked, an item toggles; the panel is for any device.
      list.addEventListener('click', (e) => {
        const row = e.target.closest('[data-i]');
        if (row) this._act(+row.dataset.i);
      });
      this.box = box; this.list = list; this.qr = qr; this.text = text;
    }
    document.body.appendChild(this.box);
    this._render();
  }

  _hide() {
    if (this.box) this.box.remove();
  }

  _render() {
    if (!this.open || !this.box) return;
    this.lastRefresh = performance.now();

    let html = '<div style="color:#f0d9a8;margin-bottom:6px">debug &mdash; B or Esc closes</div>';
    this.items.forEach((it, i) => {
      const v = it.value();
      const off = v === 'off' || v.startsWith('fixed');
      html += '<div data-i="' + i + '" style="cursor:pointer;padding:1px 6px;border-radius:3px;' +
        (i === this.sel ? 'background:rgba(224,189,138,.28);' : '') + '">' +
        '<span style="display:inline-block;width:12em">' + it.label + '</span>' +
        '<span style="color:' + (off ? '#e79a7c' : '#9fd6a8') + '">' + v + '</span></div>';
    });
    html += '<div style="color:#8b98a8;margin-top:6px">d-pad / arrows move, A / Enter toggles</div>';
    this.list.innerHTML = html;

    const lines = perfReport(this.canvas, this.renderer.gl);
    const changed = this.changes();
    lines.push('changed: ' + (changed.length ? changed.join(', ') : 'nothing'));
    const report = lines.join('\n');
    this.text.textContent = report;
    this._qr(report);
  }

  _qr(text) {
    let q;
    try {
      q = qrcode(0, 'L');       // the smallest version that fits
      q.addData(text, 'Byte');
      q.make();
    } catch (err) {
      this.qr.removeAttribute('src');
      return;
    }
    const n = q.getModuleCount();
    const size = (n + QR_MARGIN * 2) * QR_CELL;
    const c = this.qrCanvas;
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, size, size);
    g.fillStyle = '#000';
    for (let r = 0; r < n; r++) {
      for (let k = 0; k < n; k++) {
        if (q.isDark(r, k)) g.fillRect((k + QR_MARGIN) * QR_CELL, (r + QR_MARGIN) * QR_CELL, QR_CELL, QR_CELL);
      }
    }
    this.qr.width = this.qr.height = size;
    this.qr.src = c.toDataURL('image/png');
  }
}
