// ═══════════════════════════════════════════════════════════════════════
// A PRESIDENT IS IMPEACHED — API router (self-contained)
// Mounted from server.js with a single line:
//   app.use(require('./impeach-api')({ dataRoot: RUNTIME_DATA_ROOT }));
// Serves: /impeach/api/* (users, comments, editable content, classroom rooms)
// Storage: JSON files under <dataRoot>/impeach/ (Railway /data volume in prod).
// Auth: stateless HMAC-signed tokens (`i1.<payload>.<sig>`), same pattern as
// Word-a-Day — a deploy or disk wipe never logs a device out.
// Admin: IMPEACH_ADMIN_KEY env var (falls back to a persisted random key,
// printed to the server log once when generated).
// ═══════════════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ── Default content (canonical copy — the professor's edits override this
//    via <dataRoot>/impeach/content.json; index.html holds a fallback copy) ──
const ACTOR_IDS = ['pres', 'congress', 'courts', 'mil', 'states', 'people', 'world'];

const DEFAULT_CONTENT = {
  openings: [
    "The President is impeached by the House and convicted by the Senate — high crimes and misdemeanors: self-dealing, violation of the Emoluments Clause, and war-making without the advice and consent of Congress. The President declares martial law and arrests the congressional leaders who led the vote. . . .",
    "By a two-thirds majority the Senate votes to convict. Within the hour the President appears on live television to announce that the vote is 'null, illegitimate, and an act of insurrection' — and that the Republic is now under emergency executive authority. . . .",
    "The gavel falls: convicted, removed, barred from future office. The President does not concede. The Secret Service detail at the residence is doubled. The Vice President cannot be reached. Outside, the crowd has not gone home. . . .",
    "The impeachment holds. But when the Sergeant-at-Arms arrives to escort the former President from the building, the soldiers at the door will not say whose orders they are following. . . .",
    "Convicted, 67 to 33. Before the Chief Justice can finish reading the verdict the chamber lights go dark. When they come back the President's motorcade is already moving — not toward the exit, but toward the Pentagon. . . .",
    "The Articles are sustained on every count. The President signs an executive order titled 'Continuity of Government,' declares the impeachment itself a foreign-backed coup, and federal agents appear outside three network newsrooms before midnight. . . .",
    "Removed. Within minutes, two people claim the office: the Vice President, sworn in at an undisclosed location, and the President, who has not risen from the Resolute Desk. Both are scheduled to address the nation at 9 p.m., on the same channels. . . .",
    "The verdict lands at 4:12 a.m. By sunrise the National Guard in two states has been federalized, every airport is closed 'for security,' and no one in the Cabinet will confirm who is giving the orders. . . .",
    "Guilty on all counts. The President accepts the verdict — then announces that, as their 'final lawful act,' they have pardoned themselves, dissolved the special counsel, and ordered the Treasury sealed. The Speaker calls it treason. . . .",
    "The Senate convicts. The President's approval, somehow, climbs ten points overnight. Millions call the trial a stitch-up. By noon, rival rallies fill the same square in the capital, and the police have quietly gone home. . . ."
  ],
  preOpenings: [
    "It begins with a courier who never arrives. A whistleblower inside the Treasury walks a sealed envelope to a newspaper instead of a shredder: wire transfers, a foreign registry, and the President's own initials in the margin. By morning the word 'impeachment' is said aloud on the House floor for the first time. . . .",
    "A deputy national security adviser resigns without explanation on a Tuesday. On Thursday her lawyer releases a nine-page memo describing an order she refused to carry out. The White House calls it fiction. The House Judiciary Committee calls it Exhibit A. . . .",
    "The videotape is grainy, time-stamped, and unmistakable. Within an hour of its release, three cabinet secretaries are 'unreachable,' the President's counsel resigns, and the Speaker of the House stands at a podium and says the word everyone has been avoiding. . . .",
    "An audit no one ordered surfaces in a committee mailbox: the war was funded before it was authorized, and the money moved through accounts bearing the President's family name. The White House press office cancels the daily briefing. It does not resume. . . ."
  ],
  deck: [
    { a: 'pres', w: 14, t: "The President declares martial law and orders the arrest of the congressional leaders who voted to convict." },
    { a: 'pres', w: 12, t: "The President invokes the Insurrection Act and orders federal troops into the streets of the capital." },
    { a: 'pres', w: 13, t: "The President fires the Joint Chiefs of Staff and installs loyal generals in their place." },
    { a: 'pres', w: 11, t: "The President issues a blanket self-pardon and pardons the entire inner circle before dawn." },
    { a: 'pres', w: 12, t: "The President seizes the national broadcast networks and addresses the country over every channel at once." },
    { a: 'pres', w: 13, t: "The President suspends habeas corpus and refuses to vacate the White House." },
    { a: 'pres', w: 10, t: "The President orders the Treasury to freeze the accounts of every state that defies the order." },
    { a: 'congress', w: 11, t: "Congress reconvenes in a secret location and declares the Senate's conviction stands: the President is removed, and the line of succession is invoked." },
    { a: 'congress', w: 10, t: "The Speaker of the House declares themselves Acting President and is sworn in over the phone." },
    { a: 'congress', w: 9, t: "Congress issues federal warrants for the President's arrest and cuts off all executive funding." },
    { a: 'congress', w: 8, t: "A bloc of senators defects to the President's side, splitting the legislature into two rival bodies." },
    { a: 'courts', w: 9, t: "The Supreme Court rules the martial law order unconstitutional in an emergency 5–4 decision." },
    { a: 'courts', w: 8, t: "The Chief Justice quietly administers the oath of office to the Vice President in an undisclosed chamber." },
    { a: 'courts', w: 10, t: "Federal judges are placed under house arrest; the lower courts go dark." },
    { a: 'courts', w: 9, t: "Two Supreme Courts now claim authority — one loyal to the President, one to Congress." },
    { a: 'mil', w: 15, t: "The Joint Chiefs issue a joint statement: the armed forces will not carry out unlawful orders against citizens." },
    { a: 'mil', w: 16, t: "A four-star general begins marching an armored column toward the capital — no one knows for which side." },
    { a: 'mil', w: 14, t: "The Pacific Fleet declares neutrality and sails to open water, refusing all orders." },
    { a: 'mil', w: 13, t: "At a checkpoint, soldiers lower their weapons and refuse to fire on the crowd. The video is everywhere within minutes." },
    { a: 'mil', w: 16, t: "The chain of command fractures: two Pentagons, two sets of orders, one army." },
    { a: 'states', w: 13, t: "Twelve governors announce their National Guards will not comply with any federal order." },
    { a: 'states', w: 12, t: "California, Texas, and New York form an emergency compact and pledge mutual defense." },
    { a: 'states', w: 15, t: "A state legislature votes to suspend its ties to the federal government 'until constitutional order is restored.'" },
    { a: 'states', w: 11, t: "Governors order state police to seize the federal buildings within their borders." },
    { a: 'people', w: 12, t: "Millions fill the streets of every major city at once. The capital is a sea of bodies." },
    { a: 'people', w: 13, t: "A general strike shuts down the ports, the rails, and the power grid in three states." },
    { a: 'people', w: 14, t: "Rival militias mobilize on both sides; the first checkpoints go up on interstate highways." },
    { a: 'people', w: 11, t: "The internet goes dark nationwide. People begin organizing by ham radio and word of mouth." },
    { a: 'world', w: 9, t: "A foreign power formally recognizes the rival government and recalls its ambassador." },
    { a: 'world', w: 11, t: "Markets collapse 40% in a single session; the currency is in free fall by nightfall." },
    { a: 'world', w: 12, t: "A leaked recording surfaces that changes which side the country believes — overnight." },
    { a: 'world', w: 8, t: "Neighboring nations close their borders and mass troops, 'for stability.'" }
  ],
  // Road to Conviction deck — phase-gated. phases: 1 Allegations · 2 House Inquiry ·
  // 3 Articles of Impeachment · 4 House Vote · 5 Senate Trial (conviction → crisis deck)
  preDeck: [
    { p: 1, a: 'world', w: 4, t: "A second newspaper independently confirms the story — and adds a name the first one didn't have." },
    { p: 1, a: 'pres', w: 5, t: "The President denies everything in a 2 a.m. statement that contradicts the official record released hours earlier." },
    { p: 1, a: 'people', w: 4, t: "A crowd gathers outside the federal building holding printouts of the leaked documents. It doubles by nightfall." },
    { p: 1, a: 'world', w: 5, t: "The whistleblower's identity leaks. Their lawyer announces they are 'safe, for now, and have more.'" },
    { p: 1, a: 'congress', w: 5, t: "The ranking members of two committees issue a rare joint letter demanding the administration preserve all records." },
    { p: 1, a: 'pres', w: 6, t: "A cabinet secretary resigns 'to spend time with family' — and is photographed that evening entering a grand jury annex." },
    { p: 2, a: 'congress', w: 5, t: "The House opens a formal impeachment inquiry. Subpoenas go out to the chief of staff, the counsel's office, and the President's private accountant." },
    { p: 2, a: 'pres', w: 6, t: "The White House orders every subpoenaed official to refuse to appear, claiming 'absolute immunity.'" },
    { p: 2, a: 'world', w: 5, t: "A career diplomat testifies behind closed doors for nine hours. Leaving, she says only: 'I told the truth.'" },
    { p: 2, a: 'courts', w: 6, t: "A federal judge rules the subpoenas valid and gives the White House one week to comply." },
    { p: 2, a: 'congress', w: 6, t: "The House votes to hold the chief of staff in contempt. He is photographed at dinner with the President that night." },
    { p: 2, a: 'people', w: 5, t: "Town halls turn hostile in swing districts. Three representatives who called the inquiry 'a circus' stop holding them." },
    { p: 3, a: 'congress', w: 6, t: "The Judiciary Committee drafts three Articles of Impeachment: abuse of power, obstruction of Congress, and war-making without authorization." },
    { p: 3, a: 'world', w: 7, t: "A witness the committee didn't know existed walks in with a lawyer and a locked briefcase." },
    { p: 3, a: 'pres', w: 6, t: "The President's allies introduce a resolution to censure instead — 'accountability without chaos.' It fails by four votes." },
    { p: 3, a: 'pres', w: 7, t: "A co-conspirator flips. His plea agreement mentions 'Individual-1' fourteen times." },
    { p: 3, a: 'congress', w: 5, t: "The markup session runs past midnight, on live television, to the largest audience in the network's history." },
    { p: 4, a: 'congress', w: 7, t: "The floor debate opens. The Speaker's gavel cracks; the chamber is full for the first time in years." },
    { p: 4, a: 'congress', w: 8, t: "Five members of the President's own party announce they will vote to impeach. One reads a resignation letter from the well." },
    { p: 4, a: 'people', w: 6, t: "Overnight vigils form outside the Capitol — candles on one side of the barricades, flags on the other." },
    { p: 4, a: 'congress', w: 8, t: "The House votes to impeach. The Speaker signs the Articles at a desk once used to sign a declaration of war." },
    { p: 4, a: 'pres', w: 7, t: "Minutes after the vote, the President tells a rally: 'They have not removed me. They have declared war on you.'" },
    { p: 5, a: 'courts', w: 7, t: "The Chief Justice is sworn in to preside, and administers an oath of impartial justice to one hundred senators. Several look at their shoes." },
    { p: 5, a: 'congress', w: 8, t: "The Senate votes 51–49 to call witnesses. The President's counsel objects for two full hours." },
    { p: 5, a: 'world', w: 8, t: "A witness produces the recording. The chamber hears the President's own voice give the order." },
    { p: 5, a: 'pres', w: 8, t: "The President's lawyers rest on a single argument: even if true, none of it is impeachable. The gallery audibly reacts." },
    { p: 5, a: 'congress', w: 9, t: "Closing arguments end. The Senate goes into closed deliberation. Outside, the plaza holds its breath." }
  ]
};

const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // classroom sessions live for a day
const MAX_COMMENTS = 500;

module.exports = function createImpeachApi(opts) {
  const dataRoot = (opts && opts.dataRoot) || path.join(__dirname, 'data');
  const DIR = path.join(dataRoot, 'impeach');
  fs.mkdirSync(DIR, { recursive: true });

  const CONTENT_PATH = path.join(DIR, 'content.json');
  const COMMENTS_PATH = path.join(DIR, 'comments.json');
  const ROOMS_PATH = path.join(DIR, 'rooms.json');

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  // ── Secrets ──
  const SECRET = (() => {
    if (process.env.IMPEACH_SECRET) return process.env.IMPEACH_SECRET;
    const seed = process.env.WAD_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.OPENAI_API_KEY;
    if (seed) return crypto.createHmac('sha256', 'impeach-token-v1').update(seed).digest('hex');
    const f = path.join(DIR, '_secret');
    try { const s = fs.readFileSync(f, 'utf8').trim(); if (s) return s; } catch {}
    const s = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(f, s); } catch (e) { console.error('[impeach] could not persist secret:', e.message); }
    return s;
  })();

  const ADMIN_KEY = (() => {
    if (process.env.IMPEACH_ADMIN_KEY) return process.env.IMPEACH_ADMIN_KEY;
    const f = path.join(DIR, '_admin_key');
    try { const s = fs.readFileSync(f, 'utf8').trim(); if (s) return s; } catch {}
    const s = crypto.randomBytes(6).toString('hex');
    try { fs.writeFileSync(f, s); console.log(`[impeach] generated admin key: ${s} (set IMPEACH_ADMIN_KEY to choose your own)`); }
    catch (e) { console.error('[impeach] could not persist admin key:', e.message); }
    return s;
  })();

  function isAdmin(req) {
    const k = req.get('x-admin-key') || (req.body && req.body.adminKey) || req.query.adminKey || '';
    const a = Buffer.from(String(k)), b = Buffer.from(ADMIN_KEY);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ── Stateless user tokens (name-only identity; no email, no password) ──
  function sign(payloadB64) {
    return crypto.createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
  }
  function mintToken(userId, name) {
    const payload = Buffer.from(JSON.stringify({ u: userId, n: name, t: Date.now() })).toString('base64url');
    return `i1.${payload}.${sign(payload)}`;
  }
  function verifyToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'i1') return null;
    const a = Buffer.from(parts[2]), b = Buffer.from(sign(parts[1]));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (!p.u || !p.n) return null;
      return { userId: p.u, name: String(p.n) };
    } catch { return null; }
  }
  function cleanName(raw) {
    const n = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return n.length >= 2 ? n : null;
  }

  // ── Content (professor-editable openings + decks) ──
  function currentContent() {
    const saved = readJson(CONTENT_PATH, null);
    if (!saved) return { ...DEFAULT_CONTENT, custom: false, version: 0 };
    return {
      openings: saved.openings || DEFAULT_CONTENT.openings,
      preOpenings: saved.preOpenings || DEFAULT_CONTENT.preOpenings,
      deck: saved.deck || DEFAULT_CONTENT.deck,
      preDeck: saved.preDeck || DEFAULT_CONTENT.preDeck,
      custom: true,
      version: saved.version || 1,
    };
  }
  function validStrings(arr, maxLen, maxCount) {
    return Array.isArray(arr) && arr.length >= 1 && arr.length <= maxCount &&
      arr.every(s => typeof s === 'string' && s.trim().length >= 10 && s.length <= maxLen);
  }
  function validCards(arr, needPhase) {
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > 300) return false;
    return arr.every(c => c && typeof c === 'object' &&
      ACTOR_IDS.includes(c.a) &&
      Number.isInteger(c.w) && c.w >= 1 && c.w <= 20 &&
      typeof c.t === 'string' && c.t.trim().length >= 5 && c.t.length <= 600 &&
      (!needPhase || (Number.isInteger(c.p) && c.p >= 1 && c.p <= 5)));
  }

  // ── Rooms (classroom sessions) — in-memory, persisted with a debounce ──
  const rooms = (() => {
    const loaded = readJson(ROOMS_PATH, {});
    const now = Date.now();
    for (const code of Object.keys(loaded)) {
      if (!loaded[code].createdAt || now - loaded[code].createdAt > ROOM_TTL_MS) delete loaded[code];
    }
    return loaded;
  })();
  let roomsSaveTimer = null;
  function saveRooms() {
    clearTimeout(roomsSaveTimer);
    roomsSaveTimer = setTimeout(() => {
      try { writeJson(ROOMS_PATH, rooms); } catch (e) { console.error('[impeach] rooms save:', e.message); }
    }, 400);
  }
  function newRoomCode() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusable 0/O/1/I/L
    for (let tries = 0; tries < 50; tries++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += alphabet[crypto.randomInt(alphabet.length)];
      if (!rooms[code]) return code;
    }
    return null;
  }
  function getRoom(code) {
    const room = rooms[String(code || '').toUpperCase()];
    if (!room) return null;
    if (Date.now() - room.createdAt > ROOM_TTL_MS) { delete rooms[room.code]; saveRooms(); return null; }
    return room;
  }
  function touch(room) { room.v++; saveRooms(); }
  function memberGroup(room, user) {
    const m = room.members[user.userId];
    return m ? room.groups[m.group] : null;
  }

  // ═════════════════════════════════════════
  const router = express.Router();

  // The repo-local data dir is statically served at /data in dev; never expose
  // the impeach runtime store (admin key, secret) through it.
  router.use('/data/impeach', (req, res) => res.status(403).json({ error: 'Forbidden' }));

  const api = express.Router();
  router.use('/impeach/api', api);

  // ── identity ──
  api.post('/hello', (req, res) => {
    const name = cleanName(req.body && req.body.name);
    if (!name) return res.status(400).json({ error: 'Give a name (2–24 characters).' });
    const userId = crypto.randomBytes(8).toString('hex');
    res.json({ token: mintToken(userId, name), userId, name });
  });

  api.get('/whoami', (req, res) => {
    const user = verifyToken(req.get('x-impeach-token') || req.query.token);
    if (!user) return res.status(401).json({ error: 'No valid session.' });
    res.json(user);
  });

  // ── content (openings + decks; professor edits via /impeach/admin) ──
  api.get('/content', (req, res) => res.json(currentContent()));

  api.put('/content', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Bad admin key.' });
    const b = req.body || {};
    if (!validStrings(b.openings, 2000, 50)) return res.status(400).json({ error: 'openings: 1–50 entries, each 10–2000 chars.' });
    if (!validStrings(b.preOpenings, 2000, 50)) return res.status(400).json({ error: 'preOpenings: 1–50 entries, each 10–2000 chars.' });
    if (!validCards(b.deck, false)) return res.status(400).json({ error: 'deck: invalid cards (actor, weight 1–20, text 5–600 chars).' });
    if (!validCards(b.preDeck, true)) return res.status(400).json({ error: 'preDeck: invalid cards (actor, weight 1–20, phase 1–5, text 5–600 chars).' });
    const prev = readJson(CONTENT_PATH, null);
    const doc = {
      openings: b.openings.map(s => s.trim()),
      preOpenings: b.preOpenings.map(s => s.trim()),
      deck: b.deck.map(c => ({ a: c.a, w: c.w, t: c.t.trim() })),
      preDeck: b.preDeck.map(c => ({ p: c.p, a: c.a, w: c.w, t: c.t.trim() })),
      version: ((prev && prev.version) || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    writeJson(CONTENT_PATH, doc);
    res.json({ ok: true, version: doc.version });
  });

  api.post('/content/reset', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Bad admin key.' });
    try { fs.unlinkSync(CONTENT_PATH); } catch {}
    res.json({ ok: true });
  });

  api.get('/admin/check', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Bad admin key.' });
    res.json({ ok: true });
  });

  // ── comments (one global wall) ──
  const lastCommentAt = new Map(); // userId → ts (in-memory rate limit)

  api.get('/comments', (req, res) => {
    const all = readJson(COMMENTS_PATH, []);
    res.json({ comments: all.slice(-120).reverse() }); // newest first
  });

  api.post('/comments', (req, res) => {
    const user = verifyToken(req.get('x-impeach-token') || (req.body && req.body.token));
    if (!user) return res.status(401).json({ error: 'Set your name first.' });
    const text = String((req.body && req.body.text) || '').replace(/\s+/g, ' ').trim();
    if (text.length < 2) return res.status(400).json({ error: 'Write something first.' });
    if (text.length > 500) return res.status(400).json({ error: 'Keep it under 500 characters.' });
    const last = lastCommentAt.get(user.userId) || 0;
    if (Date.now() - last < 15000) return res.status(429).json({ error: 'One comment per 15 seconds.' });
    lastCommentAt.set(user.userId, Date.now());
    const all = readJson(COMMENTS_PATH, []);
    const comment = { id: crypto.randomBytes(6).toString('hex'), userId: user.userId, name: user.name, text, ts: Date.now() };
    all.push(comment);
    while (all.length > MAX_COMMENTS) all.shift();
    writeJson(COMMENTS_PATH, all);
    res.json({ ok: true, comment });
  });

  api.delete('/comments/:id', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Bad admin key.' });
    const all = readJson(COMMENTS_PATH, []);
    const next = all.filter(c => c.id !== req.params.id);
    if (next.length === all.length) return res.status(404).json({ error: 'No such comment.' });
    writeJson(COMMENTS_PATH, next);
    res.json({ ok: true });
  });

  // ── classroom rooms ──
  api.post('/rooms', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Bad admin key.' });
    const b = req.body || {};
    const groupCount = Math.min(12, Math.max(1, parseInt(b.groups, 10) || 4));
    const mode = b.mode === 'A' ? 'A' : 'B';
    const code = newRoomCode();
    if (!code) return res.status(500).json({ error: 'Could not allocate a room code.' });
    const content = currentContent();
    const seed = mode === 'A' ? content.preOpenings[0] : content.openings[0];
    const groups = {};
    for (let i = 1; i <= groupCount; i++) {
      groups[i] = { id: i, seed, mode, phase: mode === 'A' ? 1 : 6, events: [], proposals: [] };
    }
    rooms[code] = { code, mode, createdAt: Date.now(), v: 1, members: {}, groups };
    saveRooms();
    res.json({ ok: true, code, mode, groups: groupCount });
  });

  api.get('/rooms/:code', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'No such session. Check the code.' });
    const counts = {};
    for (const uid of Object.keys(room.members)) {
      const g = room.members[uid].group;
      counts[g] = (counts[g] || 0) + 1;
    }
    res.json({ code: room.code, mode: room.mode, groups: Object.keys(room.groups).map(Number), memberCounts: counts });
  });

  api.post('/rooms/:code/join', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'No such session. Check the code.' });
    const user = verifyToken(req.get('x-impeach-token') || (req.body && req.body.token));
    if (!user) return res.status(401).json({ error: 'Set your name first.' });
    let group = parseInt(req.body && req.body.group, 10);
    if (!room.groups[group]) {
      // no/invalid pick → the emptiest group
      const counts = {};
      Object.keys(room.groups).forEach(g => { counts[g] = 0; });
      Object.values(room.members).forEach(m => { counts[m.group] = (counts[m.group] || 0) + 1; });
      group = Number(Object.keys(counts).sort((a, b) => counts[a] - counts[b])[0]);
    }
    room.members[user.userId] = { name: user.name, group, joinedAt: Date.now() };
    touch(room);
    res.json({ ok: true, code: room.code, group, mode: room.mode });
  });

  api.get('/rooms/:code/state', (req, res) => {
    const room = getRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'Session ended.' });
    const since = parseInt(req.query.v, 10) || 0;
    if (since && since === room.v) return res.json({ v: room.v, changed: false });
    const members = {};
    for (const uid of Object.keys(room.members)) {
      const m = room.members[uid];
      (members[m.group] = members[m.group] || []).push(m.name);
    }
    res.json({ v: room.v, changed: true, code: room.code, mode: room.mode, groups: room.groups, members });
  });

  function roomAction(req, res, fn) {
    const room = getRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'Session ended.' });
    const user = verifyToken(req.get('x-impeach-token') || (req.body && req.body.token));
    if (!user) return res.status(401).json({ error: 'Set your name first.' });
    const group = memberGroup(room, user);
    if (!group) return res.status(403).json({ error: 'Join the session first.' });
    const out = fn(room, group, user);
    if (out) return; // fn already responded with an error
    touch(room);
    res.json({ ok: true, v: room.v });
  }

  api.post('/rooms/:code/propose', (req, res) => roomAction(req, res, (room, group, user) => {
    const text = String((req.body && req.body.text) || '').trim();
    const actor = ACTOR_IDS.includes(req.body && req.body.actor) ? req.body.actor : 'pres';
    let w = parseInt(req.body && req.body.w, 10); if (!Number.isInteger(w) || w < 1 || w > 20) w = 11;
    if (text.length < 5 || text.length > 1200) { res.status(400).json({ error: 'Development must be 5–1200 characters.' }); return true; }
    if (group.proposals.length >= 20) { res.status(400).json({ error: 'Too many open proposals — commit or withdraw some first.' }); return true; }
    group.proposals.push({ id: crypto.randomBytes(5).toString('hex'), by: user.userId, name: user.name, actor, w, text, ts: Date.now() });
  }));

  api.post('/rooms/:code/commit', (req, res) => roomAction(req, res, (room, group, user) => {
    const i = group.proposals.findIndex(p => p.id === (req.body && req.body.pid));
    if (i < 0) { res.status(404).json({ error: 'Proposal is gone (already committed or withdrawn).' }); return true; }
    const p = group.proposals.splice(i, 1)[0];
    group.events.push({ actor: p.actor, text: p.text, w: p.w, by: p.name, committedBy: user.name, phase: group.phase, ts: Date.now() });
  }));

  api.post('/rooms/:code/withdraw', (req, res) => roomAction(req, res, (room, group) => {
    const i = group.proposals.findIndex(p => p.id === (req.body && req.body.pid));
    if (i < 0) { res.status(404).json({ error: 'Proposal is gone.' }); return true; }
    group.proposals.splice(i, 1);
  }));

  api.post('/rooms/:code/remove-event', (req, res) => roomAction(req, res, (room, group) => {
    const i = parseInt(req.body && req.body.index, 10);
    if (!Number.isInteger(i) || i < 0 || i >= group.events.length) { res.status(404).json({ error: 'No such entry.' }); return true; }
    group.events.splice(i, 1);
  }));

  // Path A: advance the proceedings (phase 1–5, then 6 = convicted → crisis play)
  api.post('/rooms/:code/phase', (req, res) => roomAction(req, res, (room, group) => {
    if (group.mode !== 'A') { res.status(400).json({ error: 'This session starts after the verdict — there are no proceedings to advance.' }); return true; }
    if (group.phase >= 6) { res.status(400).json({ error: 'The verdict is already in.' }); return true; }
    group.phase++;
    group.events.push({ marker: true, phase: group.phase, ts: Date.now() });
  }));

  api.post('/rooms/:code/seed', (req, res) => roomAction(req, res, (room, group) => {
    const seed = String((req.body && req.body.seed) || '').trim();
    if (seed.length < 10 || seed.length > 3000) { res.status(400).json({ error: 'Opening must be 10–3000 characters.' }); return true; }
    group.seed = seed;
  }));

  api.post('/rooms/:code/close', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Bad admin key.' });
    const room = getRoom(req.params.code);
    if (!room) return res.status(404).json({ error: 'No such session.' });
    delete rooms[room.code];
    saveRooms();
    res.json({ ok: true });
  });

  api.get('/rooms', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Bad admin key.' });
    res.json({
      rooms: Object.values(rooms).map(r => ({
        code: r.code, mode: r.mode, createdAt: r.createdAt, v: r.v,
        members: Object.keys(r.members).length, groups: Object.keys(r.groups).length,
      })),
    });
  });

  api.use((req, res) => res.status(404).json({ error: 'No such endpoint.' }));

  console.log('[impeach] api mounted at /impeach/api (data: ' + DIR + ')');
  return router;
};
