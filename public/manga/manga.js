/* ============================================================
   Manga Studio — Stop & Connect
   Browser manga page templater: split panels, speech bubbles
   in the local "Manga" font, export PNG / layered PSD (Procreate).
   ============================================================ */
'use strict';

const MANGA_STACK = "'MangaLocal','Comic Neue','Comic Sans MS',sans-serif";
const LS_KEY = 'mangaStudio.v1';

/* ---------------- state ---------------- */
let page = { w: 2480, h: 3508 };
let marginPx = 90;      // page margin (panel area inset)
let gutterPx = 28;      // space between panels
let borderPx = 10;      // frame line weight
let cells = [];         // [{poly:[[x,y]..], frame:true}] tiling the margin box
let bubbles = [];       // [{id,kind,x,y,w,h,text,fs,tail:{x,y}|null}]
let seq = 1;

let tool = 'select';    // 'select' | 'split'
let pendingBub = null;  // bubble kind waiting for placement click
let splitAngle = 0;     // degrees, 0 = horizontal cut
let hoverCell = -1;
let hoverPt = null;
let selBub = -1;
let selPanel = -1;
let drag = null;        // {mode:'move'|'resize'|'tail', ...}
let undoStack = [], redoStack = [];

/* ---------------- dom ---------------- */
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const stage = document.getElementById('stage');
const $ = id => document.getElementById(id);

/* ---------------- geometry ---------------- */
const EPS = 0.01;
function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
function centroid(p) {
  let x = 0, y = 0;
  for (const [px, py] of p) { x += px; y += py; }
  return [x / p.length, y / p.length];
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// keep the side of line (p, normal n) where dot(x-p, n) <= 0
function clipHalfPlane(poly, p, n) {
  const out = [];
  const side = q => (q[0] - p[0]) * n[0] + (q[1] - p[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa <= EPS) out.push(a);
    if ((sa < -EPS && sb > EPS) || (sa > EPS && sb < -EPS)) {
      const t = sa / (sa - sb);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out.length >= 3 ? out : null;
}
function cutPoly(poly, pt, angleDeg) {
  const r = angleDeg * Math.PI / 180;
  const n = [-Math.sin(r), Math.cos(r)];
  const a = clipHalfPlane(poly, pt, n);
  const b = clipHalfPlane(poly, pt, [-n[0], -n[1]]);
  return a && b ? [a, b] : null;
}
// inset each edge by its own distance (convex polys), robust to winding
function insetPolyVar(poly, dists) {
  const c = centroid(poly);
  const lines = [];
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
    const ex = p2[0] - p1[0], ey = p2[1] - p1[1];
    const len = Math.hypot(ex, ey);
    if (len < EPS) continue;
    let nx = -ey / len, ny = ex / len;
    if ((c[0] - p1[0]) * nx + (c[1] - p1[1]) * ny < 0) { nx = -nx; ny = -ny; }
    const d = dists[i];
    lines.push({ px: p1[0] + nx * d, py: p1[1] + ny * d, dx: ex / len, dy: ey / len });
  }
  if (lines.length < 3) return null;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const A = lines[(i + lines.length - 1) % lines.length], B = lines[i];
    const den = A.dx * B.dy - A.dy * B.dx;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((B.px - A.px) * B.dy - (B.py - A.py) * B.dx) / den;
    out.push([A.px + t * A.dx, A.py + t * A.dy]);
  }
  // reject collapsed/inverted results
  if (Math.abs(polyArea(out)) < Math.abs(polyArea(poly)) * 0.02) return null;
  if (Math.sign(polyArea(out)) !== Math.sign(polyArea(poly))) return null;
  return out;
}
function marginBox() {
  return { L: marginPx, T: marginPx, R: page.w - marginPx, B: page.h - marginPx };
}
// gutter/2 on interior edges, 0 on edges lying on the margin box
function panelPoly(cell) {
  const { L, T, R, B } = marginBox();
  const poly = cell.poly, dists = [];
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
    const on = (v, t) => Math.abs(v - t) < 0.5;
    const boundary =
      (on(p1[0], L) && on(p2[0], L)) || (on(p1[0], R) && on(p2[0], R)) ||
      (on(p1[1], T) && on(p2[1], T)) || (on(p1[1], B) && on(p2[1], B));
    dists.push(boundary ? 0 : gutterPx / 2);
  }
  return insetPolyVar(poly, dists);
}

/* ---------------- view (page <-> screen) ---------------- */
let view = { scale: 1, ox: 0, oy: 0 };
function fitView() {
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  const s = Math.min(r.width / page.w, r.height / page.h) * 0.94;
  view = { scale: s, ox: (r.width - page.w * s) / 2, oy: (r.height - page.h * s) / 2, dpr };
  draw();
}
const toPage = (sx, sy) => [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale];

/* ---------------- bubble shapes ---------------- */
function bubblePath(b) {
  const p = new Path2D();
  const rx = b.w / 2, ry = b.h / 2;
  if (b.kind === 'speech') {
    p.ellipse(b.x, b.y, rx, ry, 0, 0, Math.PI * 2);
  } else if (b.kind === 'thought') {
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const t1 = (i / n) * Math.PI * 2, t0 = ((i - 0.5) / n) * Math.PI * 2;
      const x1 = b.x + Math.cos(t1) * rx, y1 = b.y + Math.sin(t1) * ry;
      const cxp = b.x + Math.cos(t0) * rx * 1.25, cyp = b.y + Math.sin(t0) * ry * 1.25;
      if (i === 0) p.moveTo(x1, y1); else p.quadraticCurveTo(cxp, cyp, x1, y1);
    }
    p.closePath();
  } else if (b.kind === 'shout') {
    const n = 22;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const k = i % 2 === 0 ? 1 : 0.74;
      const x = b.x + Math.cos(t) * rx * k, y = b.y + Math.sin(t) * ry * k;
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    }
    p.closePath();
  } else if (b.kind === 'caption') {
    p.rect(b.x - rx, b.y - ry, b.w, b.h);
  }
  return p;
}
function tailPath(b) {
  if (!b.tail || b.kind === 'caption' || b.kind === 'text' || b.kind === 'thought') return null;
  const p = new Path2D();
  const ang = Math.atan2(b.tail.y - b.y, b.tail.x - b.x);
  const baseW = Math.min(b.w, b.h) * 0.22;
  const a1 = ang + Math.PI / 2, a2 = ang - Math.PI / 2;
  // base points sit inside the bubble; tip at tail point
  const bx = b.x + Math.cos(ang) * b.w * 0.18, by = b.y + Math.sin(ang) * b.h * 0.18;
  p.moveTo(bx + Math.cos(a1) * baseW / 2, by + Math.sin(a1) * baseW / 2);
  p.lineTo(b.tail.x, b.tail.y);
  p.lineTo(bx + Math.cos(a2) * baseW / 2, by + Math.sin(a2) * baseW / 2);
  p.closePath();
  return p;
}
function drawBubbleShape(g, b) {
  if (b.kind === 'text') return;
  const lw = Math.max(3, page.w / 500);
  const shape = bubblePath(b), tail = tailPath(b);
  g.strokeStyle = '#000'; g.fillStyle = '#fff';
  g.lineJoin = 'round'; g.lineCap = 'round';
  // double-width strokes, then fills on top → clean open seam at the tail
  g.lineWidth = lw * 2;
  g.stroke(shape);
  if (tail) g.stroke(tail);
  if (tail) g.fill(tail);
  g.fill(shape);
  if (b.kind === 'thought' && b.tail) {
    // trailing thought dots
    for (let i = 1; i <= 2; i++) {
      const t = i / 3;
      const dx = b.x + (b.tail.x - b.x) * (0.55 + t * 0.45);
      const dy = b.y + (b.tail.y - b.y) * (0.55 + t * 0.45);
      const r = Math.min(b.w, b.h) * 0.07 * (1.3 - t * 0.8);
      g.beginPath(); g.arc(dx, dy, r, 0, Math.PI * 2);
      g.lineWidth = lw; g.fill(); g.stroke();
    }
  }
}
function wrapLines(g, text, maxW) {
  const out = [];
  for (const raw of text.split('\n')) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = line + ' ' + words[i];
      if (g.measureText(test).width <= maxW) line = test;
      else { out.push(line); line = words[i]; }
    }
    out.push(line);
  }
  return out;
}
function drawBubbleText(g, b) {
  if (!b.text) return;
  const shapeFactor = (b.kind === 'speech' || b.kind === 'thought' || b.kind === 'shout') ? 0.72 : 0.9;
  const maxW = b.w * shapeFactor, maxH = b.h * (b.kind === 'text' ? 0.98 : 0.78);
  let fs = b.fs;
  let lines, lh;
  for (let tries = 0; tries < 30; tries++) {
    g.font = `${fs}px ${MANGA_STACK}`;
    lines = wrapLines(g, b.text, maxW);
    lh = fs * 1.12;
    const tooWide = lines.some(l => g.measureText(l).width > maxW);
    if (!tooWide && lines.length * lh <= maxH) break;
    if (fs <= 10) break;
    fs *= 0.92;
  }
  g.fillStyle = '#000';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const y0 = b.y - (lines.length - 1) * lh / 2;
  lines.forEach((l, i) => g.fillText(l, b.x, y0 + i * lh));
}
function bubbleBBox(b) {
  let x1 = b.x - b.w / 2, y1 = b.y - b.h / 2, x2 = b.x + b.w / 2, y2 = b.y + b.h / 2;
  if (b.tail) {
    x1 = Math.min(x1, b.tail.x); y1 = Math.min(y1, b.tail.y);
    x2 = Math.max(x2, b.tail.x); y2 = Math.max(y2, b.tail.y);
  }
  const pad = page.w / 200;
  return { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad };
}

/* ---------------- rendering ---------------- */
function drawPanels(g, { strokeOnly = false } = {}) {
  for (const cell of cells) {
    const p = panelPoly(cell);
    if (!p) continue;
    g.beginPath();
    p.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
    g.closePath();
    if (!strokeOnly) { g.fillStyle = '#fff'; g.fill(); }
    if (cell.frame) {
      g.strokeStyle = '#000'; g.lineWidth = borderPx; g.lineJoin = 'miter';
      g.stroke();
    }
  }
}
function renderPage(g, { withBubbles = true, paper = true } = {}) {
  if (paper) { g.fillStyle = '#fff'; g.fillRect(0, 0, page.w, page.h); }
  drawPanels(g, { strokeOnly: !paper });
  if (withBubbles) for (const b of bubbles) { drawBubbleShape(g, b); drawBubbleText(g, b); }
}
function splitChord(poly, pt, angleDeg) {
  const r = angleDeg * Math.PI / 180;
  const d = [Math.cos(r), Math.sin(r)];
  const hits = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - pt[0]) * ey - (a[1] - pt[1]) * ex) / den;
    const u = ((a[0] - pt[0]) * d[1] - (a[1] - pt[1]) * d[0]) / -den;
    if (u >= 0 && u <= 1) hits.push([pt[0] + d[0] * t, pt[1] + d[1] * t, t]);
  }
  if (hits.length < 2) return null;
  hits.sort((a, b) => a[2] - b[2]);
  return [hits[0], hits[hits.length - 1]];
}
function draw() {
  const g = ctx;
  g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  g.translate(view.ox, view.oy);
  g.scale(view.scale, view.scale);
  // page shadow + paper
  g.fillStyle = 'rgba(0,0,0,.5)';
  g.fillRect(12 / view.scale, 12 / view.scale, page.w, page.h);
  renderPage(g);

  const hairline = w => Math.max(w / view.scale, w / view.scale);
  // split preview
  if (tool === 'split' && hoverCell >= 0 && hoverPt) {
    const cell = cells[hoverCell];
    g.save();
    g.beginPath();
    cell.poly.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
    g.closePath();
    g.fillStyle = 'rgba(230,0,35,.08)'; g.fill();
    const chord = splitChord(cell.poly, hoverPt, splitAngle);
    if (chord) {
      g.strokeStyle = '#e60023'; g.lineWidth = hairline(2);
      g.setLineDash([hairline(10), hairline(7)]);
      g.beginPath(); g.moveTo(chord[0][0], chord[0][1]); g.lineTo(chord[1][0], chord[1][1]); g.stroke();
    }
    g.restore();
  }
  // selected panel highlight
  if (selPanel >= 0 && cells[selPanel]) {
    const p = panelPoly(cells[selPanel]) || cells[selPanel].poly;
    g.save();
    g.strokeStyle = '#00b3ff'; g.lineWidth = hairline(2.5);
    g.setLineDash([hairline(8), hairline(6)]);
    g.beginPath();
    p.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
    g.closePath(); g.stroke();
    g.restore();
  }
  // selected bubble UI
  if (selBub >= 0 && bubbles[selBub]) {
    const b = bubbles[selBub];
    const hs = 7 / view.scale;
    g.save();
    g.strokeStyle = '#00b3ff'; g.lineWidth = hairline(1.5);
    g.setLineDash([hairline(6), hairline(5)]);
    g.strokeRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
    g.setLineDash([]);
    g.fillStyle = '#00b3ff';
    for (const [cx2, cy2] of bubbleCorners(b)) g.fillRect(cx2 - hs, cy2 - hs, hs * 2, hs * 2);
    if (b.tail) {
      g.save();
      g.translate(b.tail.x, b.tail.y); g.rotate(Math.PI / 4);
      g.fillStyle = '#e60023';
      g.fillRect(-hs, -hs, hs * 2, hs * 2);
      g.restore();
    }
    g.restore();
  }
}
const bubbleCorners = b => [
  [b.x - b.w / 2, b.y - b.h / 2], [b.x + b.w / 2, b.y - b.h / 2],
  [b.x + b.w / 2, b.y + b.h / 2], [b.x - b.w / 2, b.y + b.h / 2]];

/* ---------------- undo / persistence ---------------- */
const snapshot = () => JSON.stringify({ page, marginPx, gutterPx, borderPx, cells, bubbles, seq });
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  updateUndoBtns();
}
function restore(s) {
  const d = JSON.parse(s);
  page = d.page; marginPx = d.marginPx; gutterPx = d.gutterPx; borderPx = d.borderPx;
  cells = d.cells; bubbles = d.bubbles; seq = d.seq;
  selBub = -1; selPanel = -1;
  syncControls(); fitView(); save();
}
function undo() { if (undoStack.length) { redoStack.push(snapshot()); restore(undoStack.pop()); updateUndoBtns(); } }
function redo() { if (redoStack.length) { undoStack.push(snapshot()); restore(redoStack.pop()); updateUndoBtns(); } }
function updateUndoBtns() { $('btnUndo').disabled = !undoStack.length; $('btnRedo').disabled = !redoStack.length; }
let saveT;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(LS_KEY, snapshot()); } catch (e) {} }, 300); }

/* ---------------- templates ---------------- */
const TEMPLATES = [
  { name: 'Splash', cuts: [] },
  { name: '2 rows', cuts: [{ fx: .5, fy: .5, a: 0 }] },
  { name: '3 rows', cuts: [{ fx: .5, fy: .333, a: 0 }, { fx: .5, fy: .667, a: 0 }] },
  { name: '4-koma', cuts: [{ fx: .5, fy: .25, a: 0 }, { fx: .5, fy: .5, a: 0 }, { fx: .5, fy: .75, a: 0 }] },
  { name: '2×2', cuts: [{ fx: .5, fy: .5, a: 0 }, { fx: .5, fy: .25, a: 90 }, { fx: .5, fy: .75, a: 90 }] },
  { name: 'Classic 5', cuts: [{ fx: .5, fy: .3, a: 0 }, { fx: .5, fy: .68, a: 0 }, { fx: .5, fy: .5, a: 90 }, { fx: .45, fy: .85, a: 90 }] },
  { name: '6 grid', cuts: [{ fx: .5, fy: .333, a: 0 }, { fx: .5, fy: .667, a: 0 }, { fx: .5, fy: .17, a: 90 }, { fx: .5, fy: .5, a: 90 }, { fx: .5, fy: .84, a: 90 }] },
  { name: 'Shonen', cuts: [{ fx: .5, fy: .36, a: -8 }, { fx: .5, fy: .7, a: 6 }, { fx: .6, fy: .2, a: 96 }, { fx: .45, fy: .53, a: 84 }] },
  { name: 'Tall left', cuts: [{ fx: .55, fy: .5, a: 90 }, { fx: .78, fy: .333, a: 0 }, { fx: .78, fy: .667, a: 0 }] },
  { name: 'Drama', cuts: [{ fx: .5, fy: .42, a: -14 }, { fx: .5, fy: .75, a: 0 }, { fx: .55, fy: .87, a: 100 }] },
];
function applyCuts(rectPoly, cuts, box) {
  let cs = [{ poly: rectPoly, frame: true }];
  for (const c of cuts) {
    const pt = [box.L + c.fx * (box.R - box.L), box.T + c.fy * (box.B - box.T)];
    const i = cs.findIndex(cell => pointInPoly(pt, cell.poly));
    if (i < 0) continue;
    const halves = cutPoly(cs[i].poly, pt, c.a);
    if (halves) cs.splice(i, 1, { poly: halves[0], frame: true }, { poly: halves[1], frame: true });
  }
  return cs;
}
function applyTemplate(t) {
  pushUndo();
  const { L, T, R, B } = marginBox();
  cells = applyCuts([[L, T], [R, T], [R, B], [L, B]], t.cuts, marginBox());
  selPanel = -1;
  draw(); save();
}
function buildTemplateThumbs() {
  const host = $('templates');
  const W = 60, H = 80, m = 4;
  for (const t of TEMPLATES) {
    const box = { L: m, T: m, R: W - m, B: H - m };
    const cs = applyCuts([[box.L, box.T], [box.R, box.T], [box.R, box.B], [box.L, box.B]], t.cuts, box);
    let paths = '';
    for (const c of cs) {
      const d = c.poly.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('') + 'Z';
      paths += `<path d="${d}" fill="#fff" stroke="#111" stroke-width="2"/>`;
    }
    const el = document.createElement('div');
    el.className = 'tpl';
    el.title = t.name;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${paths}</svg>`;
    el.addEventListener('click', () => applyTemplate(t));
    host.appendChild(el);
  }
}

/* ---------------- hit testing ---------------- */
function hitBubble(pt) {
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    if (Math.abs(pt[0] - b.x) <= b.w / 2 && Math.abs(pt[1] - b.y) <= b.h / 2) return i;
  }
  return -1;
}
function hitHandle(pt) {
  if (selBub < 0) return null;
  const b = bubbles[selBub];
  const r = 14 / view.scale;
  if (b.tail && Math.hypot(pt[0] - b.tail.x, pt[1] - b.tail.y) < r) return { type: 'tail' };
  const corners = bubbleCorners(b);
  for (let i = 0; i < 4; i++)
    if (Math.hypot(pt[0] - corners[i][0], pt[1] - corners[i][1]) < r) return { type: 'resize', corner: i };
  return null;
}
const hitPanel = pt => cells.findIndex(c => pointInPoly(pt, c.poly));

/* ---------------- interactions ---------------- */
function setTool(t) {
  tool = t; pendingBub = null;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active',
    (b.dataset.tool === t) || (b.dataset.bub && b.dataset.bub === pendingBub)));
  $('splitOpts').style.display = t === 'split' ? '' : 'none';
  cv.style.cursor = t === 'split' ? 'crosshair' : 'default';
  draw();
}
function selectBubble(i) {
  selBub = i; selPanel = -1;
  $('inspector').style.display = i >= 0 ? '' : 'none';
  $('panelInspector').style.display = 'none';
  if (i >= 0) {
    $('bubText').value = bubbles[i].text;
    $('fontSize').value = bubbles[i].fs;
    $('fsVal').textContent = Math.round(bubbles[i].fs);
  }
  draw();
}
function selectPanel(i) {
  selPanel = i; selBub = -1;
  $('panelInspector').style.display = i >= 0 ? '' : 'none';
  $('inspector').style.display = 'none';
  draw();
}
function evPt(e) {
  const r = cv.getBoundingClientRect();
  return toPage(e.clientX - r.left, e.clientY - r.top);
}
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  const pt = evPt(e);
  if (pendingBub) {
    pushUndo();
    const w = page.w * (pendingBub === 'caption' ? 0.38 : 0.3);
    const h = pendingBub === 'caption' ? page.w * 0.1 : page.w * 0.2;
    const b = {
      id: seq++, kind: pendingBub, x: pt[0], y: pt[1], w, h,
      text: pendingBub === 'text' ? 'WHAM!' : pendingBub === 'caption' ? 'Meanwhile…' : 'Hello!',
      fs: Math.round(page.w / 26),
      tail: (pendingBub === 'speech' || pendingBub === 'shout' || pendingBub === 'thought')
        ? { x: pt[0] - w * 0.3, y: pt[1] + h * 0.85 } : null,
    };
    bubbles.push(b);
    setTool('select');
    selectBubble(bubbles.length - 1);
    $('bubText').focus(); $('bubText').select();
    save();
    return;
  }
  if (tool === 'split') {
    const i = hitPanel(pt);
    if (i >= 0) {
      const halves = cutPoly(cells[i].poly, pt, splitAngle);
      if (halves) {
        const minA = page.w * page.h * 0.0004;
        if (Math.abs(polyArea(halves[0])) > minA && Math.abs(polyArea(halves[1])) > minA) {
          pushUndo();
          cells.splice(i, 1, { poly: halves[0], frame: true }, { poly: halves[1], frame: true });
          draw(); save();
        }
      }
    }
    return;
  }
  // select tool
  const h = hitHandle(pt);
  if (h) {
    drag = { ...h, start: pt, orig: JSON.parse(JSON.stringify(bubbles[selBub])) };
    pushUndo();
    return;
  }
  const bi = hitBubble(pt);
  if (bi >= 0) {
    selectBubble(bi);
    drag = { type: 'move', start: pt, orig: JSON.parse(JSON.stringify(bubbles[bi])) };
    pushUndo();
    return;
  }
  const pi = hitPanel(pt);
  if (pi >= 0) { selectPanel(pi); return; }
  selectBubble(-1); selectPanel(-1);
});
cv.addEventListener('pointermove', e => {
  const pt = evPt(e);
  if (drag && selBub >= 0) {
    const b = bubbles[selBub], o = drag.orig;
    const dx = pt[0] - drag.start[0], dy = pt[1] - drag.start[1];
    if (drag.type === 'move') {
      b.x = o.x + dx; b.y = o.y + dy;
      if (o.tail) { b.tail.x = o.tail.x + dx; b.tail.y = o.tail.y + dy; }
    } else if (drag.type === 'tail') {
      b.tail.x = o.tail.x + dx; b.tail.y = o.tail.y + dy;
    } else if (drag.type === 'resize') {
      const cs = bubbleCorners(o);
      const fixed = cs[(drag.corner + 2) % 4];
      const cur = [cs[drag.corner][0] + dx, cs[drag.corner][1] + dy];
      b.w = Math.max(60, Math.abs(cur[0] - fixed[0]));
      b.h = Math.max(50, Math.abs(cur[1] - fixed[1]));
      b.x = (cur[0] + fixed[0]) / 2; b.y = (cur[1] + fixed[1]) / 2;
    }
    draw();
    return;
  }
  if (tool === 'split') {
    hoverPt = pt; hoverCell = hitPanel(pt);
    draw();
  }
});
cv.addEventListener('pointerup', () => { if (drag) { drag = null; save(); } });
cv.addEventListener('wheel', e => {
  if (tool !== 'split') return;
  e.preventDefault();
  splitAngle += (e.deltaY > 0 ? 5 : -5);
  if (splitAngle > 135) splitAngle -= 180;
  if (splitAngle < -45) splitAngle += 180;
  $('angSlider').value = splitAngle;
  $('angVal').textContent = `${splitAngle}° — scroll wheel also rotates`;
  draw();
}, { passive: false });
cv.addEventListener('dblclick', e => {
  if (hitBubble(evPt(e)) >= 0) { $('bubText').focus(); $('bubText').select(); }
});

/* ---------------- controls ---------------- */
document.querySelectorAll('.tool[data-tool]').forEach(b =>
  b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('.tool.bub').forEach(b =>
  b.addEventListener('click', () => {
    pendingBub = b.dataset.bub; tool = 'select';
    document.querySelectorAll('.tool').forEach(x => x.classList.toggle('active', x === b));
    $('splitOpts').style.display = 'none';
    cv.style.cursor = 'copy';
  }));
document.querySelectorAll('.ang').forEach(b =>
  b.addEventListener('click', () => {
    splitAngle = +b.dataset.ang;
    $('angSlider').value = splitAngle;
    $('angVal').textContent = `${splitAngle}° — scroll wheel also rotates`;
    draw();
  }));
$('angSlider').addEventListener('input', e => {
  splitAngle = +e.target.value;
  $('angVal').textContent = `${splitAngle}° — scroll wheel also rotates`;
  draw();
});
function bindSlider(id, valId, get, set) {
  $(id).addEventListener('input', e => { set(+e.target.value); $(valId).textContent = get(); draw(); save(); });
  $(valId).textContent = get();
}
bindSlider('gutter', 'gutterVal', () => gutterPx, v => gutterPx = v);
bindSlider('border', 'borderVal', () => borderPx, v => borderPx = v);
bindSlider('margin', 'marginVal', () => marginPx, v => { rescaleMargin(v); });
function rescaleMargin(v) {
  // move cell vertices lying on the old margin box onto the new one
  const old = marginBox();
  marginPx = v;
  const nb = marginBox();
  for (const c of cells)
    for (const p of c.poly) {
      if (Math.abs(p[0] - old.L) < 0.6) p[0] = nb.L;
      if (Math.abs(p[0] - old.R) < 0.6) p[0] = nb.R;
      if (Math.abs(p[1] - old.T) < 0.6) p[1] = nb.T;
      if (Math.abs(p[1] - old.B) < 0.6) p[1] = nb.B;
    }
}
function syncControls() {
  $('gutter').value = gutterPx; $('gutterVal').textContent = gutterPx;
  $('border').value = borderPx; $('borderVal').textContent = borderPx;
  $('margin').value = marginPx; $('marginVal').textContent = marginPx;
  const preset = `${page.w}x${page.h}`;
  const sel = $('pagePreset');
  if ([...sel.options].some(o => o.value === preset)) sel.value = preset;
}
$('pagePreset').addEventListener('change', e => {
  const [w, h] = e.target.value.split('x').map(Number);
  pushUndo();
  const sx = w / page.w, sy = h / page.h;
  page = { w, h };
  for (const c of cells) for (const p of c.poly) { p[0] *= sx; p[1] *= sy; }
  for (const b of bubbles) {
    b.x *= sx; b.y *= sy; b.w *= sx; b.h *= sy; b.fs *= sx;
    if (b.tail) { b.tail.x *= sx; b.tail.y *= sy; }
  }
  fitView(); save();
});
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);
$('btnNew').addEventListener('click', () => {
  if (!confirm('Start a blank page? (Undo can bring this one back)')) return;
  pushUndo();
  const { L, T, R, B } = marginBox();
  cells = [{ poly: [[L, T], [R, T], [R, B], [L, B]], frame: true }];
  bubbles = [];
  selectBubble(-1); selectPanel(-1);
  draw(); save();
});
$('bubText').addEventListener('input', e => {
  if (selBub >= 0) { bubbles[selBub].text = e.target.value; draw(); save(); }
});
$('fontSize').addEventListener('input', e => {
  if (selBub >= 0) {
    bubbles[selBub].fs = +e.target.value;
    $('fsVal').textContent = e.target.value;
    draw(); save();
  }
});
$('btnDelBub').addEventListener('click', () => {
  if (selBub >= 0) { pushUndo(); bubbles.splice(selBub, 1); selectBubble(-1); save(); }
});
$('btnFront').addEventListener('click', () => {
  if (selBub >= 0 && selBub < bubbles.length - 1) {
    pushUndo();
    const [b] = bubbles.splice(selBub, 1); bubbles.push(b); selBub = bubbles.length - 1;
    draw(); save();
  }
});
$('btnBack').addEventListener('click', () => {
  if (selBub > 0) {
    pushUndo();
    const [b] = bubbles.splice(selBub, 1); bubbles.unshift(b); selBub = 0;
    draw(); save();
  }
});
$('btnDelPanel').addEventListener('click', () => {
  if (selPanel >= 0) { pushUndo(); cells.splice(selPanel, 1); selectPanel(-1); save(); }
});
$('btnPanelBorder').addEventListener('click', () => {
  if (selPanel >= 0) { pushUndo(); cells[selPanel].frame = !cells[selPanel].frame; draw(); save(); }
});
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selBub >= 0) { pushUndo(); bubbles.splice(selBub, 1); selectBubble(-1); save(); }
  }
  else if (e.key.toLowerCase() === 'v') setTool('select');
  else if (e.key.toLowerCase() === 's') setTool('split');
});

/* ---------------- export ---------------- */
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function fullRenderCanvas(opts) {
  const c = document.createElement('canvas');
  c.width = page.w; c.height = page.h;
  renderPage(c.getContext('2d'), opts);
  return c;
}
$('btnPng').addEventListener('click', () =>
  fullRenderCanvas({}).toBlob(b => downloadBlob(b, 'manga-page.png'), 'image/png'));
$('btnPngFrames').addEventListener('click', () =>
  fullRenderCanvas({ withBubbles: false }).toBlob(b => downloadBlob(b, 'manga-frames.png'), 'image/png'));

$('btnPsd').addEventListener('click', () => {
  try {
    const paper = document.createElement('canvas');
    paper.width = page.w; paper.height = page.h;
    const pg = paper.getContext('2d');
    pg.fillStyle = '#fff'; pg.fillRect(0, 0, page.w, page.h);

    const frames = document.createElement('canvas');
    frames.width = page.w; frames.height = page.h;
    drawPanels(frames.getContext('2d'), { strokeOnly: true });

    const bubbleGroups = bubbles.map((b, i) => {
      const bb = bubbleBBox(b);
      const x1 = Math.max(0, Math.floor(bb.x1)), y1 = Math.max(0, Math.floor(bb.y1));
      const x2 = Math.min(page.w, Math.ceil(bb.x2)), y2 = Math.min(page.h, Math.ceil(bb.y2));
      const w = Math.max(1, x2 - x1), h = Math.max(1, y2 - y1);
      const mk = fn => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.translate(-x1, -y1);
        fn(g);
        return c;
      };
      const label = (b.text || b.kind).replace(/\s+/g, ' ').slice(0, 24) || `bubble ${i + 1}`;
      const children = [];
      if (b.kind !== 'text')
        children.push({ name: 'balloon', left: x1, top: y1, canvas: mk(g => drawBubbleShape(g, b)) });
      children.push({ name: 'text', left: x1, top: y1, canvas: mk(g => drawBubbleText(g, b)) });
      return { name: `${i + 1} · ${label}`, opened: false, children };
    });

    const psd = {
      width: page.w, height: page.h,
      canvas: fullRenderCanvas({}),
      children: [
        { name: 'Paper', canvas: paper },
        { name: 'Frames (ink)', canvas: frames },
        { name: 'Bubbles', opened: true, children: bubbleGroups },
      ],
    };
    const buf = agPsd.writePsd(psd, { generateThumbnail: true });
    downloadBlob(new Blob([buf], { type: 'application/octet-stream' }), 'manga-page.psd');
  } catch (err) {
    alert('PSD export failed: ' + err.message);
    console.error(err);
  }
});

/* ---------------- init ---------------- */
function init() {
  const saved = localStorage.getItem(LS_KEY);
  if (saved) {
    try { restore(saved); } catch (e) { saved && localStorage.removeItem(LS_KEY); }
  }
  if (!cells.length) {
    const { L, T, R, B } = marginBox();
    cells = applyCuts([[L, T], [R, T], [R, B], [L, B]], TEMPLATES[5].cuts, marginBox());
  }
  syncControls();
  buildTemplateThumbs();
  updateUndoBtns();
  fitView();
  // font availability note
  const note = $('fontNote');
  document.fonts.load(`32px MangaLocal`).then(() => {
    if (document.fonts.check('32px MangaLocal')) {
      note.textContent = '✓ Manga font active (local)';
      note.classList.add('ok');
    } else {
      note.textContent = '⚠ "Manga" font not installed on this device — using Comic Neue';
      note.classList.add('warn');
    }
    draw();
  });
  document.fonts.ready.then(draw);
}
window.addEventListener('resize', fitView);
init();
