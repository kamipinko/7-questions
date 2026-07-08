require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const multer = require('multer');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || null;
const questions = require('./data/questions.json');
const promptsData = require('./data/prompts.json');

// ── Durable runtime-data root ──
// User-generated data (accounts, progress, sessions, analytics) must survive deploys.
// On Railway the repo directory is rebuilt from git on every push, so anything written
// under __dirname/data was wiped each deploy — silently logging every Word-a-Day user
// out and resetting server-side progress on every release. A Railway volume mounted at
// /data (or a WAD_DATA_DIR env override) gives runtime data a permanent home.
const RUNTIME_DATA_ROOT = (() => {
  if (process.env.WAD_DATA_DIR) {
    fs.mkdirSync(process.env.WAD_DATA_DIR, { recursive: true });
    return process.env.WAD_DATA_DIR;
  }
  try { if (fs.statSync('/data').isDirectory()) return '/data'; } catch {}
  return path.join(__dirname, 'data'); // local dev: keep everything in the repo dir
})();
const IS_DURABLE_DATA = RUNTIME_DATA_ROOT !== path.join(__dirname, 'data');
// One-time seed: when a durable root first appears, carry over any runtime data the
// repo-local dir still holds so nothing is lost in the switch.
(function seedRuntimeData() {
  if (!IS_DURABLE_DATA) return;
  const legacyRoot = path.join(__dirname, 'data');
  for (const rel of ['word-a-day/users', 'word-a-day/progress', 'sessions']) {
    const src = path.join(legacyRoot, rel), dst = path.join(RUNTIME_DATA_ROOT, rel);
    try {
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        const to = path.join(dst, f);
        if (!fs.existsSync(to)) fs.copyFileSync(path.join(src, f), to);
      }
    } catch (e) { console.error('[data seed]', rel, e.message); }
  }
  try {
    const src = path.join(legacyRoot, 'analytics.json'), dst = path.join(RUNTIME_DATA_ROOT, 'analytics.json');
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
  } catch (e) { console.error('[data seed] analytics', e.message); }
})();
console.log(`[data] runtime data root: ${RUNTIME_DATA_ROOT}${IS_DURABLE_DATA ? ' (durable volume)' : ' (EPHEMERAL on Railway — mount a volume at /data)'}`);

const ANALYTICS_PATH = path.join(RUNTIME_DATA_ROOT, 'analytics.json');
const SESSIONS_DIR = path.join(RUNTIME_DATA_ROOT, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function readAnalytics() {
  try { return JSON.parse(fs.readFileSync(ANALYTICS_PATH, 'utf8')); }
  catch { return { sessions: [], emails: [], feedback: [] }; }
}
function writeAnalytics(data) {
  fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(data, null, 2));
}

app.use(express.json({ limit: '50mb' }));

app.use(require('./impeach-api')({ dataRoot: RUNTIME_DATA_ROOT })); // "A President Is Impeached" API (self-contained router)

// ── Static file serving ──
app.use('/play', express.static(path.join(__dirname, 'public/7q')));
app.use('/autobiography', express.static(path.join(__dirname, 'public/autobiography')));
app.use('/thumbnails', express.static(path.join(__dirname, 'public/thumbnails')));
// Word-a-Day: never expose the user account store (auth tokens, emails) via the static /data mount
app.use('/data/word-a-day/users', (req, res) => res.status(403).json({ error: 'Forbidden' }));
app.use('/data', express.static(path.join(__dirname, 'data')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Page routes ──
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public/7q/index.html')));
app.get('/play/lobby', (req, res) => res.sendFile(path.join(__dirname, 'public/7q/lobby.html')));
app.get('/autobiography', (req, res) => res.sendFile(path.join(__dirname, 'public/autobiography/index.html')));
app.get('/autobiography/feedback', (req, res) => res.sendFile(path.join(__dirname, 'public/autobiography/feedback.html')));
app.get('/thumbnails', (req, res) => res.sendFile(path.join(__dirname, 'public/thumbnails/index.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'public/contact.html')));
app.get('/word-a-day', (req, res) => res.sendFile(path.join(__dirname, 'public/word-a-day/index.html')));
app.get('/word-a-day/resume', (req, res) => res.redirect(`/word-a-day?token=${req.query.token}`));
// Magic-link login: validate single-use login token, mint a long-lived authToken, redirect into the app logged in
app.get('/word-a-day/login', (req, res) => {
  const lt = String(req.query.lt || '');
  const result = wadConsumeLoginToken(lt);
  if (!result) {
    return res.redirect('/word-a-day?login_error=expired');
  }
  wadLogRegister(result.event, result.user, req); // back-in register: 'login' | 'register'
  res.redirect(`/word-a-day?auth=${result.authToken}`);
});

// ════════════════════════════════════════
// WORD-A-DAY API
// ════════════════════════════════════════

const WAD_PROGRESS_DIR = path.join(RUNTIME_DATA_ROOT, 'word-a-day/progress');
const WAD_WORDS_DIR    = path.join(__dirname, 'data/word-a-day/words');
if (!fs.existsSync(WAD_PROGRESS_DIR)) fs.mkdirSync(WAD_PROGRESS_DIR, { recursive: true });

function wadReadProgress(token) {
  const file = path.join(WAD_PROGRESS_DIR, `${token}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function wadWriteProgress(token, data) {
  fs.writeFileSync(path.join(WAD_PROGRESS_DIR, `${token}.json`), JSON.stringify(data, null, 2));
}
function wadTodayStr() { return new Date().toISOString().slice(0,10); }
function wadAddDays(dateStr, n) { const d=new Date(dateStr); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }

function newProgress(email, language) {
  return {
    email, language,
    tier: 1, week: 1, day: 1,
    streak: 0, longestStreak: 0,
    studyDays: [],
    completedWords: [],
    exams: [],
    lastStudied: null,
    createdAt: wadTodayStr(),
  };
}

function computeStreak(studyDays) {
  if (!studyDays.length) return 0;
  const sorted = [...studyDays].sort();
  let streak = 0, d = wadTodayStr();
  // count backward from today
  while (sorted.includes(d)) { streak++; d = wadAddDays(d, -1); }
  // also count from yesterday if today not yet studied
  if (streak === 0) {
    d = wadAddDays(wadTodayStr(), -1);
    while (sorted.includes(d)) { streak++; d = wadAddDays(d, -1); }
  }
  return streak;
}

function advanceProgressDay(p) {
  // Move to next day / week / tier
  if (p.day < 7) {
    p.day++;
  } else {
    p.day = 1;
    // Check if next week exists in word data (cap at week 4 per tier, 3 tiers)
    const maxWeekPerTier = 4;
    if (p.week < maxWeekPerTier) {
      p.week++;
    } else {
      p.week = 1;
      if (p.tier < 3) p.tier++;
      // else stay on tier 3 — expand vocabulary loop
    }
  }
}

// ════════════════════════════════════════
// WORD-A-DAY ACCOUNT SYSTEM (magic-link, multi-language per user)
// ════════════════════════════════════════
const crypto = require('crypto');
const WAD_USERS_DIR     = path.join(RUNTIME_DATA_ROOT, 'word-a-day/users');
const WAD_EMAIL_INDEX   = path.join(WAD_USERS_DIR, '_emailIndex.json');   // { emailLower: userId }
const WAD_AUTH_INDEX    = path.join(WAD_USERS_DIR, '_authIndex.json');    // { authToken: userId }
const WAD_LOGIN_TOKENS  = path.join(WAD_USERS_DIR, '_loginTokens.json');  // { loginToken: {email, code, expires, used} }
const WAD_MIGRATED      = path.join(WAD_USERS_DIR, '_migrated.json');     // [ legacyToken, ... ]
if (!fs.existsSync(WAD_USERS_DIR)) fs.mkdirSync(WAD_USERS_DIR, { recursive: true });

const WAD_LANGS_MAP = { es:'Spanish', zh:'Chinese', ja:'Japanese', vi:'Vietnamese', sw:'Swahili', ki:'Kikuyu' };
const WAD_LOGIN_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ── Signed (stateless) auth tokens ──
// authTokens used to be random strings valid only while _authIndex.json existed — a
// deploy wiped the index and logged every device out. Tokens are now HMAC-signed and
// self-contained (`w2.<payload>.<sig>`), so a device stays logged in across deploys
// and restarts even if the on-disk store is lost; email accounts self-heal from the
// email embedded in the token. Set WAD_SECRET in the environment so the signature
// stays valid across deploys regardless of disk state.
const WAD_SECRET = (() => {
  if (process.env.WAD_SECRET) return process.env.WAD_SECRET;
  // No dedicated secret set: derive a stable one from existing long-lived server
  // secrets, so signatures stay valid across deploys with zero new infrastructure.
  // (Rotating the underlying secret just means devices log in once more.)
  const seed = process.env.GOOGLE_CLIENT_SECRET || process.env.OPENAI_API_KEY;
  if (seed) return crypto.createHmac('sha256', 'wad-token-secret-v1').update(seed).digest('hex');
  // Last resort: persist a random secret (durable only if a /data volume exists).
  const f = path.join(WAD_USERS_DIR, '_secret');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (s) return s; } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(f, s); } catch (e) { console.error('[wad] could not persist secret:', e.message); }
  return s;
})();
function wadSignPayload(payloadB64) {
  return crypto.createHmac('sha256', WAD_SECRET).update(payloadB64).digest('base64url');
}
function wadVerifySignedToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'w2') return null;
  const a = Buffer.from(parts[2]), b = Buffer.from(wadSignPayload(parts[1]));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}
function wadTokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
}

function wadReadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function wadWriteJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function wadNormEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function wadValidEmail(email) {
  const e = wadNormEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}

function wadNewLangProgress() {
  return {
    tier: 1, week: 1, day: 1,
    streak: 0, longestStreak: 0,
    studyDays: [],
    completedWords: [],
    wordStats: {},
    exams: [],
    lastStudied: null,
    createdAt: wadTodayStr(),
  };
}

// ── User record I/O ──
function wadUserPath(userId) { return path.join(WAD_USERS_DIR, `${userId}.json`); }
function wadReadUser(userId) {
  if (!userId || /[^a-f0-9]/i.test(userId)) return null; // userIds are hex only
  return wadReadJson(wadUserPath(userId), null);
}
function wadWriteUser(user) {
  wadWriteJson(wadUserPath(user.userId), user);
}
function wadUserIdForEmail(email, createIfMissing) {
  const e = wadNormEmail(email);
  const idx = wadReadJson(WAD_EMAIL_INDEX, {});
  if (idx[e]) return idx[e];
  if (!createIfMissing) return null;
  const userId = crypto.randomBytes(16).toString('hex');
  idx[e] = userId;
  wadWriteJson(WAD_EMAIL_INDEX, idx);
  const user = {
    userId, email: e,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    authTokens: [],
    languages: {},
  };
  wadWriteUser(user);
  return userId;
}
function wadGetOrCreateUser(email) {
  const userId = wadUserIdForEmail(email, true);
  let user = wadReadUser(userId);
  if (!user) { // index existed but file missing — rebuild
    user = { userId, email: wadNormEmail(email), createdAt: new Date().toISOString(), lastLogin: null, authTokens: [], languages: {} };
    wadWriteUser(user);
  }
  return user;
}
// Create an emailless ("anonymous" / device-local) account. Same shape as an email
// account but with email:null + anon:true. Progress tracks via its authToken just
// like a logged-in user; the user can attach an email later (see wadAttachEmail).
function wadCreateAnonUser() {
  const userId = crypto.randomBytes(16).toString('hex');
  const user = {
    userId, email: null, anon: true,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    authTokens: [],
    languages: {},
  };
  wadWriteUser(user);
  return user;
}
// Attach an email to an existing (anonymous) account, upgrading it in place so the
// device's progress is preserved. Returns the upgraded user, or null if attach isn't
// possible (no such session, already has an email, or email already taken by someone).
function wadAttachEmail(attachFromToken, email) {
  if (!attachFromToken) return null;
  // Resolve the session like every other endpoint does (signed w2 tokens AND legacy
  // index tokens). The old lookup only consulted the legacy _authIndex.json, which
  // signed tokens never enter — so guest→email upgrades silently created a brand-new
  // empty account and the guest's progress was left behind.
  const user = wadUserByAuth(attachFromToken);
  if (!user || user.email) return null; // only emailless anon accounts can be upgraded
  const e = wadNormEmail(email);
  const emailIdx = wadReadJson(WAD_EMAIL_INDEX, {});
  if (emailIdx[e]) return null; // email already owned — caller falls back to that account
  user.email = e;
  user.anon = false;
  emailIdx[e] = user.userId;
  wadWriteJson(WAD_EMAIL_INDEX, emailIdx);
  wadWriteUser(user);
  return user;
}
function wadUserByAuth(authToken) {
  if (!authToken) return null;
  // Signed stateless tokens (current format)
  if (String(authToken).startsWith('w2.')) {
    const payload = wadVerifySignedToken(authToken);
    if (!payload || !payload.u) return null;
    let user = wadReadUser(payload.u);
    if (!user) {
      // Store was lost (deploy without the volume / disk reset). The signature proves
      // the session, so self-heal instead of 401-ing the device.
      if (payload.e) user = wadGetOrCreateUser(payload.e);
      else {
        user = { userId: payload.u, email: null, anon: true, createdAt: new Date().toISOString(), lastLogin: null, authTokens: [], languages: {} };
        wadWriteUser(user);
      }
    }
    if ((user.revokedTokens || []).includes(wadTokenHash(authToken))) return null;
    return user;
  }
  // Legacy random tokens (pre-signed era) still honored via the on-disk index.
  const idx = wadReadJson(WAD_AUTH_INDEX, {});
  const userId = idx[authToken];
  if (!userId) return null;
  const user = wadReadUser(userId);
  if (!user || !Array.isArray(user.authTokens) || !user.authTokens.includes(authToken)) return null;
  return user;
}
function wadMintAuthToken(user) {
  const payloadB64 = Buffer.from(JSON.stringify({ u: user.userId, e: user.email || null, t: Date.now() })).toString('base64url');
  const authToken = `w2.${payloadB64}.${wadSignPayload(payloadB64)}`;
  user.lastLogin = new Date().toISOString();
  wadWriteUser(user);
  return authToken;
}
function wadRevokeAuthToken(authToken) {
  if (String(authToken || '').startsWith('w2.')) {
    const payload = wadVerifySignedToken(authToken);
    if (!payload) return;
    const user = wadReadUser(payload.u) || (payload.e ? wadGetOrCreateUser(payload.e) : null);
    if (!user) return;
    user.revokedTokens = user.revokedTokens || [];
    const h = wadTokenHash(authToken);
    if (!user.revokedTokens.includes(h)) {
      user.revokedTokens.push(h);
      if (user.revokedTokens.length > 50) user.revokedTokens = user.revokedTokens.slice(-50);
      wadWriteUser(user);
    }
    return;
  }
  const idx = wadReadJson(WAD_AUTH_INDEX, {});
  const userId = idx[authToken];
  if (userId) {
    const user = wadReadUser(userId);
    if (user && Array.isArray(user.authTokens)) {
      user.authTokens = user.authTokens.filter(t => t !== authToken);
      wadWriteUser(user);
    }
    delete idx[authToken];
    wadWriteJson(WAD_AUTH_INDEX, idx);
  }
}

// ── Login (magic-link) tokens ──
function wadCreateLoginToken(email) {
  const tokens = wadReadJson(WAD_LOGIN_TOKENS, {});
  const now = Date.now();
  // prune expired/used while we're here
  for (const k of Object.keys(tokens)) {
    if (tokens[k].used || tokens[k].expires < now) delete tokens[k];
  }
  const loginToken = crypto.randomBytes(32).toString('hex');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  tokens[loginToken] = { email: wadNormEmail(email), code, expires: now + WAD_LOGIN_TTL_MS, used: false };
  wadWriteJson(WAD_LOGIN_TOKENS, tokens);
  return { loginToken, code };
}
// Validate + consume a login token (by link). Returns { authToken, user, event } or null.
// event = 'login' (existing email account returning) or 'register' (brand-new email),
// so the caller can feed the back-in register.
function wadConsumeLoginToken(loginToken) {
  if (!loginToken) return null;
  const tokens = wadReadJson(WAD_LOGIN_TOKENS, {});
  const rec = tokens[loginToken];
  if (!rec || rec.used || rec.expires < Date.now()) return null;
  rec.used = true;
  wadWriteJson(WAD_LOGIN_TOKENS, tokens);
  const existed = !!wadUserIdForEmail(rec.email, false);
  const user = wadGetOrCreateUser(rec.email);
  return { authToken: wadMintAuthToken(user), user, event: existed ? 'login' : 'register' };
}
// Validate + consume by email + 6-digit code. Returns { authToken, user, event } or null.
// If attachFromToken is an anonymous session, the email is attached to that account
// (preserving its progress) instead of spinning up a fresh one.
// event = 'login' (returning email), 'guest_upgrade' (anon session attached this
// email), or 'register' (brand-new email, no guest session to carry over).
function wadConsumeLoginCode(email, code, attachFromToken) {
  const e = wadNormEmail(email);
  const c = String(code || '').trim();
  const tokens = wadReadJson(WAD_LOGIN_TOKENS, {});
  const now = Date.now();
  let matchKey = null;
  for (const k of Object.keys(tokens)) {
    const r = tokens[k];
    if (!r.used && r.expires >= now && r.email === e && r.code === c) { matchKey = k; break; }
  }
  if (!matchKey) return null;
  tokens[matchKey].used = true;
  wadWriteJson(WAD_LOGIN_TOKENS, tokens);
  let user, event;
  if (wadUserIdForEmail(e, false)) {
    user = wadGetOrCreateUser(e); event = 'login';           // returning email account
  } else {
    const upgraded = wadAttachEmail(attachFromToken, e);      // guest keeps its progress
    if (upgraded) { user = upgraded; event = 'guest_upgrade'; }
    else { user = wadGetOrCreateUser(e); event = 'register'; }
  }
  return { authToken: wadMintAuthToken(user), user, event };
}

// ── "Back-in register" — server-side login/guest event ledger ──
// Pinko's ask: when someone loses their localStorage and logs back in (or a guest
// device returns), the event must be LOGGED with the exact spot their progress is
// at, so we can track from the back-in. One JSON line per event in _register.jsonl
// plus a per-user loginHistory trail (survives even if the JSONL is lost).
const WAD_REGISTER_PATH = path.join(WAD_USERS_DIR, '_register.jsonl');
// Compact per-language snapshot of where the user's progress sits right now.
function wadSpotSnapshot(user) {
  const spot = {};
  for (const [lang, p] of Object.entries((user && user.languages) || {})) {
    if (!p || typeof p !== 'object') continue;
    spot[lang] = {
      tier: p.tier || 1, week: p.week || 1, day: p.day || 1,
      streak: p.streak || 0, lastStudied: p.lastStudied || null,
    };
  }
  return spot;
}
// Append one register event. Logging must NEVER break auth — everything is wrapped.
// NEVER log auth tokens, login tokens, or codes here.
function wadLogRegister(event, user, req, extra) {
  try {
    if (!user || !user.userId) return;
    const entry = {
      ts: new Date().toISOString(),
      event,
      userId: user.userId,
      email: user.email || null,
      anon: !user.email,
      spot: wadSpotSnapshot(user),
      ua: String((req && req.headers && req.headers['user-agent']) || '').slice(0, 120),
      ip: (req && req.ip) || null,
      ...(extra || {}),
    };
    fs.appendFileSync(WAD_REGISTER_PATH, JSON.stringify(entry) + '\n');
    // Per-user back-in trail: each account carries its own history (last 100).
    try {
      if (!Array.isArray(user.loginHistory)) user.loginHistory = [];
      user.loginHistory.push({ ts: entry.ts, event, spot: entry.spot });
      if (user.loginHistory.length > 100) user.loginHistory = user.loginHistory.slice(-100);
      wadWriteUser(user);
    } catch (e) { console.error('[wad register] loginHistory:', e.message); }
  } catch (e) { console.error('[wad register]', e.message); }
}
// Newest-first read of the ledger; tolerates corrupt/partial lines.
function wadReadRegister(limit) {
  let lines = [];
  try { lines = fs.readFileSync(WAD_REGISTER_PATH, 'utf8').split('\n'); } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {} // corrupt line — skip
  }
  return out;
}

// ── Public-safe account view (never leak authTokens) ──
function wadPublicAccount(user) {
  return {
    userId: user.userId,
    email: user.email,
    anon: !user.email,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin,
    nativeLanguage: user.nativeLanguage || null,
    languages: user.languages || {},
  };
}

// ── Shared study mutations (used by both account + legacy paths) ──
function wadApplyCompleteWord(p, wordId, accuracy) {
  if (!wordId) return;
  if (!Array.isArray(p.completedWords)) p.completedWords = [];
  if (!p.completedWords.includes(wordId)) p.completedWords.push(wordId);
  const acc = Number(accuracy);
  if (!isNaN(acc) && accuracy !== null && accuracy !== undefined && accuracy !== '') {
    const clamped = Math.max(0, Math.min(100, Math.round(acc)));
    if (!p.wordStats || typeof p.wordStats !== 'object') p.wordStats = {};
    const prev = p.wordStats[wordId] || { bestAccuracy: 0, timesSeen: 0 };
    p.wordStats[wordId] = {
      accuracy: clamped,
      bestAccuracy: Math.max(prev.bestAccuracy || 0, clamped),
      timesSeen: (prev.timesSeen || 0) + 1,
      lastSeen: new Date().toISOString().slice(0, 10),
    };
  }
}
function wadApplyCompleteDay(p) {
  const today = wadTodayStr();
  if (!Array.isArray(p.studyDays)) p.studyDays = [];
  if (!p.studyDays.includes(today)) p.studyDays.push(today);
  p.lastStudied = today;
  p.streak = computeStreak(p.studyDays);
  p.longestStreak = Math.max(p.longestStreak || 0, p.streak);
  advanceProgressDay(p);
}
function wadApplySubmitExam(p, { tier, week, score, grade, passed }) {
  const canRetakeAt = passed ? null : wadAddDays(wadTodayStr(), 7);
  p.exams = (p.exams || []).filter(e => !(e.tier === tier && e.week === week));
  p.exams.push({ tier, week, score, grade, passed, takenAt: wadTodayStr(), canRetakeAt });
}

// Resolve a study request to a progress object + a save() fn.
// Prefers account auth (authToken + language); falls back to legacy per-language token.
function wadResolveStudy(body) {
  if (body && body.authToken) {
    const user = wadUserByAuth(body.authToken);
    if (!user) return { error: 401 };
    const lang = body.language || body.lang;
    if (!lang || !WAD_LANGS_MAP[lang]) return { error: 400 };
    if (!user.languages) user.languages = {};
    if (!user.languages[lang]) user.languages[lang] = wadNewLangProgress();
    const p = user.languages[lang];
    if (!p.wordStats) p.wordStats = {};
    return { p, lang, user, account: true, save: () => wadWriteUser(user) };
  }
  if (body && body.token) {
    const p = wadReadProgress(body.token);
    if (!p) return { error: 404 };
    if (!p.wordStats) p.wordStats = {};
    return { p, account: false, save: () => wadWriteProgress(body.token, p) };
  }
  return { error: 400 };
}

// RFC 2047 encoded-word; only encode the Subject if it contains non-ASCII.
function encodeSubject(s) {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

// ── Email helper (reuses existing Gmail OAuth creds) ──
async function wadSendMail(to, subject, body) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const message = [
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ].join('\n');
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(message).toString('base64url') },
  });
}

function wadBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

// ── One-time migration of legacy progress files into the new account store ──
function wadMigrateLegacy() {
  let migrated = 0;
  try {
    const legacyIndex = wadReadJson(path.join(WAD_PROGRESS_DIR, '_index.json'), {});
    const done = new Set(wadReadJson(WAD_MIGRATED, []));
    let files = [];
    try { files = fs.readdirSync(WAD_PROGRESS_DIR).filter(f => f.endsWith('.json') && f !== '_index.json'); } catch {}
    for (const file of files) {
      const legacyToken = file.replace(/\.json$/, '');
      if (done.has(legacyToken)) continue;
      const lp = wadReadJson(path.join(WAD_PROGRESS_DIR, file), null);
      if (!lp || !lp.email || !lp.language) { done.add(legacyToken); continue; }
      const user = wadGetOrCreateUser(lp.email);
      if (!user.languages) user.languages = {};
      if (!user.languages[lp.language]) {
        user.languages[lp.language] = {
          tier: lp.tier || 1, week: lp.week || 1, day: lp.day || 1,
          streak: lp.streak || 0, longestStreak: lp.longestStreak || 0,
          studyDays: lp.studyDays || [],
          completedWords: lp.completedWords || [],
          wordStats: lp.wordStats || {},
          exams: lp.exams || [],
          lastStudied: lp.lastStudied || null,
          createdAt: lp.createdAt || wadTodayStr(),
          migratedFrom: legacyToken,
        };
        wadWriteUser(user);
        migrated++;
      }
      done.add(legacyToken);
    }
    wadWriteJson(WAD_MIGRATED, [...done]);
    if (migrated > 0) console.log(`[wad] migrated ${migrated} legacy progress record(s) into accounts`);
  } catch (e) {
    console.error('[wad migrate]', e.message);
  }
  return migrated;
}
wadMigrateLegacy();

// ════════════════════════════════════════
// WORD-A-DAY AUTH ROUTES
// ════════════════════════════════════════

// POST /api/wad/auth/request {email} — email a magic link + 6-digit code
app.post('/api/wad/auth/request', async (req, res) => {
  const email = wadNormEmail(req.body && req.body.email);
  if (!wadValidEmail(email)) return res.status(400).json({ error: 'A valid email is required' });

  const { loginToken, code } = wadCreateLoginToken(email);
  const loginUrl = `${wadBaseUrl(req)}/word-a-day/login?lt=${loginToken}`;
  const body = [
    `Welcome to A Word a Day 📚`,
    ``,
    `Click the link below to log in (valid for 15 minutes):`,
    loginUrl,
    ``,
    `Or enter this 6-digit code in the app:`,
    `    ${code}`,
    ``,
    `If you didn't request this, you can safely ignore this email.`,
    ``,
    `— A Word a Day`,
  ].join('\n');

  // Always log a redacted confirmation; never log the full token/code in production.
  console.log(`[wad auth] login link issued for ${email}`);
  try {
    await wadSendMail(email, 'Your login link — A Word a Day 📚', body);
    res.json({ ok: true, sent: true });
  } catch (e) {
    console.error('[wad auth/request] email failed:', e.message);
    // Still return ok so the code path (verify-code) remains usable; token is stored.
    res.json({ ok: true, sent: false });
  }
});

// POST /api/wad/auth/verify-code {email, code, authToken?} — same effect as clicking
// the link. An optional authToken is an existing anonymous session to upgrade in place.
app.post('/api/wad/auth/verify-code', (req, res) => {
  const email = wadNormEmail(req.body && req.body.email);
  const code = String((req.body && req.body.code) || '').trim();
  const attachFromToken = (req.body && req.body.authToken) || null;
  if (!wadValidEmail(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Email and 6-digit code required' });
  }
  const result = wadConsumeLoginCode(email, code, attachFromToken);
  if (!result) return res.status(401).json({ error: 'Invalid or expired code' });
  const user = wadUserByAuth(result.authToken);
  wadLogRegister(result.event, user, req); // back-in register: 'login' | 'register' | 'guest_upgrade'
  res.json({ ok: true, authToken: result.authToken, account: wadPublicAccount(user), resume: wadSpotSnapshot(user) });
});

// POST /api/wad/auth/email-login {email, authToken?} — frictionless email login.
// Typing an email routes straight into that email's account (all previous progress)
// with no code step — Pinko's explicit call for this app: the data is low-stakes
// vocab progress and re-entering emailed codes on every device was killing usage.
// The magic-link/code endpoints above stay for backward compatibility. If a current
// anonymous session is passed and the email is new, the guest progress carries over.
app.post('/api/wad/auth/email-login', (req, res) => {
  const email = wadNormEmail(req.body && req.body.email);
  if (!wadValidEmail(email)) return res.status(400).json({ error: 'A valid email is required' });
  const attachFromToken = (req.body && req.body.authToken) || null;
  const existingId = wadUserIdForEmail(email, false);
  let user, regEvent;
  if (existingId) {
    user = wadGetOrCreateUser(email); regEvent = 'login';         // known email → their account, returning
  } else {
    const upgraded = wadAttachEmail(attachFromToken, email);       // new email → upgrade guest (progress carries) …
    if (upgraded) { user = upgraded; regEvent = 'guest_upgrade'; }
    else { user = wadGetOrCreateUser(email); regEvent = 'register'; } // … or brand-new account
  }
  const authToken = wadMintAuthToken(user);
  console.log(`[wad auth] email-login ${email} (${existingId ? 'returning' : 'new'})`);
  wadLogRegister(regEvent, user, req); // back-in register
  res.json({ ok: true, authToken, account: wadPublicAccount(user), returning: !!existingId, resume: wadSpotSnapshot(user) });
});

// POST /api/wad/auth/anon — create an emailless, device-local account so the user can
// start learning immediately. Progress is saved against the returned authToken (persist
// it client-side in localStorage). The user can attach an email later via verify-code.
app.post('/api/wad/auth/anon', (req, res) => {
  const user = wadCreateAnonUser();
  const authToken = wadMintAuthToken(user);
  console.log(`[wad auth] anonymous account created ${user.userId}`);
  wadLogRegister('guest_start', user, req); // back-in register: guest tracking starts here
  res.json({ ok: true, authToken, account: wadPublicAccount(user) });
});

// POST /api/wad/auth/me {authToken} — restore session.
// Logged as 'session_restore' for BOTH email users and guests — this is the guest
// tracking: a returning device that still has its token gets registered every time
// it comes back, spot snapshot included.
app.post('/api/wad/auth/me', (req, res) => {
  const user = wadUserByAuth(req.body && req.body.authToken);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  wadLogRegister('session_restore', user, req); // back-in register
  res.json({ ok: true, account: wadPublicAccount(user), resume: wadSpotSnapshot(user) });
});

// POST /api/wad/auth/logout {authToken}
app.post('/api/wad/auth/logout', (req, res) => {
  const authToken = req.body && req.body.authToken;
  // Resolve the user BEFORE revoking (a revoked token no longer resolves), but log
  // from a FRESH read AFTER the revoke so the loginHistory write can't clobber the
  // just-written revokedTokens list.
  const user = authToken ? wadUserByAuth(authToken) : null;
  if (authToken) wadRevokeAuthToken(authToken);
  if (user) wadLogRegister('logout', wadReadUser(user.userId) || user, req); // back-in register
  res.json({ ok: true });
});

// POST /api/wad/auth/native {authToken, nativeLanguage} — set the language the user SPEAKS.
// Chosen from the signup dropdown; drives the default learning direction per course.
app.post('/api/wad/auth/native', (req, res) => {
  const user = wadUserByAuth(req.body && req.body.authToken);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const nl = String((req.body && req.body.nativeLanguage) || '').trim();
  const allowed = ['en', ...Object.keys(WAD_LANGS_MAP)];
  if (!allowed.includes(nl)) return res.status(400).json({ error: 'Unsupported language' });
  user.nativeLanguage = nl;
  wadWriteUser(user);
  res.json({ ok: true, account: wadPublicAccount(user) });
});

// ── Back-in register: admin views (same ADMIN_KEY pattern as /admin) ──
// GET /api/wad/register?key=...&limit=200 — newest-first JSON ledger
app.get('/api/wad/register', (req, res) => {
  const key = process.env.ADMIN_KEY || 'admin';
  if (req.query.key !== key) return res.status(403).json({ error: 'Forbidden' });
  const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit, 10) || 200));
  const entries = wadReadRegister(limit);
  res.json({ ok: true, count: entries.length, entries });
});

// GET /word-a-day/register?key=... — minimal dark-theme HTML table of the ledger
app.get('/word-a-day/register', (req, res) => {
  const key = process.env.ADMIN_KEY || 'admin';
  if (req.query.key !== key) return res.status(403).send('<h2>403 Forbidden — add ?key=YOUR_ADMIN_KEY</h2>');
  const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit, 10) || 200));
  const entries = wadReadRegister(limit);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const spotSummary = (spot) => Object.entries(spot || {})
    .map(([lang, s]) => `${lang} T${s.tier} W${s.week} D${s.day}${s.streak ? ` x${s.streak}` : ''}`)
    .join(' · ') || '—';
  const rows = entries.map(e => `<tr>
      <td>${esc((e.ts || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${esc(e.email || `Guest ${String(e.userId || '').slice(0, 8)}`)}</td>
      <td><span class="ev ev-${esc(e.event)}">${esc(e.event)}</span></td>
      <td>${esc(spotSummary(e.spot))}</td>
    </tr>`).join('\n');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Word-a-Day — Back-In Register</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{background:#0d0d10;color:#e8e2d0;font-family:'Consolas','Menlo',monospace;font-size:13px;margin:24px;}
  h1{color:#d4af37;font-size:16px;letter-spacing:.12em;text-transform:uppercase;}
  .sub{color:#8a8578;font-size:11px;margin-bottom:16px;}
  table{border-collapse:collapse;width:100%;}
  th,td{border-bottom:1px solid #2a2a30;padding:6px 12px;text-align:left;vertical-align:top;}
  th{color:#d4af37;font-size:11px;letter-spacing:.1em;text-transform:uppercase;}
  tr:hover td{background:#16161c;}
  .ev{padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #3a3a42;}
  .ev-login{color:#4ade80;border-color:#1e5c38;}
  .ev-register{color:#60a5fa;border-color:#1e3a5c;}
  .ev-guest_start{color:#a78bfa;border-color:#3b2d5c;}
  .ev-guest_upgrade{color:#facc15;border-color:#5c521e;}
  .ev-session_restore{color:#8a8578;border-color:#3a3a42;}
  .ev-logout{color:#f87171;border-color:#5c1e1e;}
</style></head><body>
<h1>Back-In Register</h1>
<div class="sub">${entries.length} event(s), newest first · Word-a-Day login/guest ledger</div>
<table><thead><tr><th>Time (UTC)</th><th>Who</th><th>Event</th><th>Spot</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">No events yet.</td></tr>'}</tbody></table>
</body></html>`);
});

// POST /api/wad/set-focus {authToken+language | token, focus} — set the learning DIRECTION
// for a course. focus = the language being LEARNED (answer side): 'en' or the dataset code.
app.post('/api/wad/set-focus', (req, res) => {
  const focus = String((req.body && req.body.focus) || '').trim();
  const r = wadResolveStudy(req.body);
  if (r.error) return wadStudyError(res, r.error);
  const datasetCode = r.lang || (r.p && r.p.language);
  if (focus !== 'en' && focus !== datasetCode) return res.status(400).json({ error: 'Invalid focus' });
  r.p.focus = focus;
  r.save();
  res.json({ ok: true, focus });
});

// GET /api/wad/words/:lang — serve word list
app.get('/api/wad/words/:lang', (req, res) => {
  const file = path.join(WAD_WORDS_DIR, `${req.params.lang}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Language not found' });
  res.sendFile(file);
});

// GET /api/wad/progress/:token
app.get('/api/wad/progress/:token', (req, res) => {
  const p = wadReadProgress(req.params.token);
  if (!p) return res.status(404).json({ error: 'Session not found' });
  res.json(p);
});

// ── Pronunciation transcription (server-side Whisper) ──
// Browser SpeechRecognition was unreliable: it can't run alongside the attempt
// MediaRecorder on many devices (the recognizer hears silence — why the mic "stopped
// picking up" every language), and it has no Swahili/Kikuyu support at all. The app
// now records ONE audio blob and scores that via Whisper, so the playback the learner
// hears is exactly the audio that was graded — on every browser, in every language.
const WAD_WHISPER_LANG = { es:'es', vi:'vi', sw:'sw', zh:'zh', ja:'ja', ki:'sw', en:'en' };
app.post('/api/wad/transcribe', upload.single('audio'), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'Transcription not configured' });
  if (!req.file || !req.file.buffer || req.file.buffer.length < 200) {
    return res.status(400).json({ error: 'No audio captured' });
  }
  const mt = String(req.file.mimetype || '');
  const ext = mt.includes('mp4') ? '.mp4' : mt.includes('ogg') ? '.ogg' : mt.includes('wav') ? '.wav' : '.webm';
  const tempPath = path.join(os.tmpdir(), `wad-rec-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  try {
    fs.writeFileSync(tempPath, req.file.buffer);
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const language = WAD_WHISPER_LANG[String(req.body.lang || '')] || undefined;
    // Biasing the decoder toward the target phrase is the intended "give": a close
    // attempt resolves to the target, genuinely wrong audio still comes back different.
    const hint = String(req.body.hint || '').slice(0, 200) || undefined;
    const t = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
      language,
      prompt: hint,
      temperature: 0,
    });
    res.json({ ok: true, text: t.text || '' });
  } catch (err) {
    console.error('[wad transcribe]', err.message);
    res.status(502).json({ error: 'Transcription failed' });
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
});

// POST /api/wad/session — create or resume session
app.post('/api/wad/session', async (req, res) => {
  const { email, language } = req.body;
  if (!email || !language) return res.status(400).json({ error: 'email and language required' });

  // Check for existing token for this email + language
  const tokenFile = path.join(WAD_PROGRESS_DIR, '_index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch {}

  const key = `${email}:${language}`;
  let token = index[key];
  let progress = token ? wadReadProgress(token) : null;

  if (!token || !progress) {
    token = require('crypto').randomBytes(24).toString('hex');
    index[key] = token;
    fs.writeFileSync(tokenFile, JSON.stringify(index, null, 2));
    progress = newProgress(email, language);
    wadWriteProgress(token, progress);
  }

  // Log to sheets if configured
  if (SHEETS_WEBHOOK_URL && !progress.createdAt || progress.createdAt === wadTodayStr()) {
    try {
      fetch(SHEETS_WEBHOOK_URL, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ type:'wad_session', email, language, date: wadTodayStr() })
      }).catch(() => {});
    } catch {}
  }

  res.json({ token, progress });
});

function wadStudyError(res, code) {
  const map = { 400: 'authToken+language or token required', 401: 'Not authenticated', 404: 'Session not found' };
  return res.status(code).json({ error: map[code] || 'Error' });
}

// POST /api/wad/complete-word — records the word AND persists its accuracy (per-word stats)
app.post('/api/wad/complete-word', (req, res) => {
  const { wordId, accuracy } = req.body || {};
  const r = wadResolveStudy(req.body);
  if (r.error) return wadStudyError(res, r.error);
  wadApplyCompleteWord(r.p, wordId, accuracy);
  r.save();
  res.json({ ok: true, wordStats: (r.p.wordStats && r.p.wordStats[wordId]) || null });
});

// POST /api/wad/complete-day
app.post('/api/wad/complete-day', (req, res) => {
  const r = wadResolveStudy(req.body);
  if (r.error) return wadStudyError(res, r.error);
  wadApplyCompleteDay(r.p);
  r.save();
  res.json(r.p);
});

// POST /api/wad/submit-exam
app.post('/api/wad/submit-exam', (req, res) => {
  const { week, tier, score, grade, passed } = req.body || {};
  const r = wadResolveStudy(req.body);
  if (r.error) return wadStudyError(res, r.error);
  wadApplySubmitExam(r.p, { tier, week, score, grade, passed });
  r.save();
  res.json(r.p);
});

// POST /api/wad/save-spot — email user their resume link
app.post('/api/wad/save-spot', async (req, res) => {
  const { token } = req.body;
  const p = wadReadProgress(token);
  if (!p) return res.status(404).json({ error: 'Session not found' });

  const LANGS_MAP = {es:'Spanish',zh:'Chinese',ja:'Japanese',vi:'Vietnamese',sw:'Swahili',ki:'Kikuyu'};
  const langName = LANGS_MAP[p.language] || p.language;
  const resumeUrl = `${req.protocol}://${req.get('host')}/word-a-day/resume?token=${token}`;
  const tierName = ['','Survival','Communicate','General Vocabulary'][p.tier];

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const subject = `Your ${langName} spot — A Word a Day 📚`;
    const body = [
      `You're studying ${langName} — Tier ${p.tier} (${tierName}), Week ${p.week}, Day ${p.day}.`,
      ``,
      `Streak: ${p.streak || 0} day${p.streak!==1?'s':''} 🔥`,
      `Words learned: ${p.completedWords.length}`,
      ``,
      `Click below to pick up right where you left off:`,
      `${resumeUrl}`,
      ``,
      `Keep going — 3 words a day changes everything.`,
      ``,
      `— A Word a Day`,
    ].join('\n');

    const message = [
      `To: ${p.email}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body
    ].join('\n');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(message).toString('base64url') }
    });

    res.json({ ok: true });
  } catch(e) {
    console.error('[wad save-spot]', e.message);
    res.status(500).json({ error: 'Could not send email' });
  }
});

// ════════════════════════════════════════
// THUMBNAIL — AI BACKGROUND GENERATION
// ════════════════════════════════════════

// ── Nano Banana Pro: render Pinko INTO the scene (identity-locked, 8 refs) ──
const PK_REFS_DIR = path.join(__dirname, 'public/thumbnails/assets/refs');

function pkLoadRefImages() {
  const out = [];
  for (let i = 1; i <= 8; i++) {
    const p = path.join(PK_REFS_DIR, `ref${i}.jpg`);
    if (fs.existsSync(p)) out.push({ mimeType: 'image/jpeg', data: fs.readFileSync(p).toString('base64') });
  }
  return out;
}

function pkSubjectScenePrompt(scene, styleGuide) {
  const s = (scene && scene.trim()) || 'standing in a dark, moody space, contemplative, one hard key light';
  // The client's 60:30:10 style guide (palette + aesthetic + heavy contrast) drives
  // the whole look. The fallback mood is the same language in brand colors — a
  // heavy-contrast graphic poster, never a soft naturalistic photo.
  const mood = (styleGuide && styleGuide.trim())
    ? styleGuide.trim()
    : 'STYLE GUIDE — high-contrast graphic poster. COLOR — 60:30:10 rule: near-black #0a0a0a floods ~60% of the frame, deep red #680707 carries ~30%, gold #ECAA27 is ~10% — the only accent, placed on the focal point. CONTRAST — crushed blacks, hard-edged shadow shapes, heavy chiaroscuro, no soft ambient wash.';
  return `Dramatic high-contrast poster of the SAME man shown in the provided reference photos — his identity must be unmistakable: exact face, skin tone, light beard, and especially his hair — distinct twisted locs / two-strand twists with reddish-brown tips (NOT a smooth round afro). Scene: ${s}. He is fully integrated into the scene — shared lighting, shadows, and palette, never a pasted cutout — composed like the hero of a movie poster. ${mood} No text.`;
}

// "Scene only — take me out": the same poster language with NO subject at all.
function pkSceneOnlyPrompt(scene, styleGuide) {
  const s = (scene && scene.trim()) || 'a dark, moody space, one hard key light';
  const mood = (styleGuide && styleGuide.trim())
    ? styleGuide.trim()
    : 'STYLE GUIDE — high-contrast graphic poster. COLOR — 60:30:10 rule: near-black #0a0a0a floods ~60% of the frame, deep red #680707 carries ~30%, gold #ECAA27 is ~10% — the only accent, placed on the focal point. CONTRAST — crushed blacks, hard-edged shadow shapes, heavy chiaroscuro, no soft ambient wash.';
  return `Dramatic high-contrast poster scene: ${s}. ABSOLUTELY NO people, no human figures, no faces, no silhouettes of people anywhere in the image — the scenery and its shapes carry the whole composition. ${mood} No text.`;
}

// Calls gemini-3-pro-image-preview with the scene prompt + all 8 reference images.
// The model can be slow (25-90s) and occasionally returns 503/UNAVAILABLE under load,
// so each call uses a generous timeout and retries transient failures with backoff.
async function pkRenderSubjectScene(scene, aspectRatio, styleGuide, noSubject = false) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const ar = (aspectRatio === '9:16') ? '9:16' : '16:9';
  const parts = noSubject
    ? [{ text: pkSceneOnlyPrompt(scene, styleGuide) }]
    : [{ text: pkSubjectScenePrompt(scene, styleGuide) }];
  if (!noSubject) {
    const refs = pkLoadRefImages();
    if (!refs.length) throw new Error('No reference images found in assets/refs');
    for (const r of refs) parts.push({ inlineData: { mimeType: r.mimeType, data: r.data } });
  }
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ar, imageSize: '2K' } }
  });

  const MAX_ATTEMPTS = 4;
  let lastErr = 'Nano Banana Pro generation failed';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body,
          signal: AbortSignal.timeout(240000)
        }
      );
      const d = await resp.json();
      if (resp.ok) {
        const outParts = d.candidates?.[0]?.content?.parts || [];
        const imgPart = outParts.find(p => p.inlineData?.data || p.inline_data?.data);
        if (!imgPart) throw new Error('No image returned by model');
        const inl = imgPart.inlineData || imgPart.inline_data;
        const mime = inl.mimeType || inl.mime_type || 'image/jpeg';
        return `data:${mime};base64,${inl.data}`;
      }
      // Non-OK: retry on transient overload/rate-limit/server errors.
      lastErr = d.error?.message || `HTTP ${resp.status}`;
      const transient = [429, 500, 503, 504].includes(resp.status) || /UNAVAILABLE|RESOURCE_EXHAUSTED|overload|high demand/i.test(lastErr);
      if (!transient || attempt === MAX_ATTEMPTS) throw new Error(lastErr);
      console.warn(`[subject-scene] attempt ${attempt} got "${lastErr}" — retrying…`);
    } catch (e) {
      lastErr = e.message || String(e);
      const retriable = /aborted|timeout|UNAVAILABLE|overload|high demand|HTTP 5|429/i.test(lastErr);
      if (!retriable || attempt === MAX_ATTEMPTS) throw new Error(lastErr);
      console.warn(`[subject-scene] attempt ${attempt} error "${lastErr}" — retrying…`);
    }
    await new Promise(r => setTimeout(r, 4000 * attempt)); // backoff: 4s, 8s, 12s
  }
  throw new Error(lastErr);
}

app.post('/api/generate-bg', express.json(), async (req, res) => {
  const { prompt, provider = 'dalle', aspectRatio, styleGuide } = req.body;
  if (!prompt && provider !== 'subject-scene' && provider !== 'scene-only') return res.status(400).json({ error: 'Prompt is required' });

  try {
    if (provider === 'subject-scene' || provider === 'scene-only') {
      const dataUrl = await pkRenderSubjectScene(prompt, aspectRatio, styleGuide, provider === 'scene-only');
      return res.json({ dataUrl });
    }

    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set in Railway env vars' });
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1 } })
        }
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Gemini generation failed');
      const b64 = d.predictions[0].bytesBase64Encoded;
      const mime = d.predictions[0].mimeType || 'image/jpeg';
      return res.json({ dataUrl: `data:${mime};base64,${b64}` });
    }

    // DALL-E 3 (default)
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const result = await openai.images.generate({
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size: '1536x1024',
      quality: 'high'
    });
    // Newer OpenAI images API dropped `response_format`; it may return b64_json or a url.
    const img = result.data[0];
    let dataUrl;
    if (img.b64_json) {
      dataUrl = `data:image/png;base64,${img.b64_json}`;
    } else if (img.url) {
      const imgResp = await fetch(img.url);
      if (!imgResp.ok) throw new Error(`Failed to fetch generated image (HTTP ${imgResp.status})`);
      const buf = Buffer.from(await imgResp.arrayBuffer());
      const mime = imgResp.headers.get('content-type') || 'image/png';
      dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    } else {
      throw new Error('OpenAI returned no image data (neither b64_json nor url)');
    }
    res.json({ dataUrl });

  } catch (err) {
    console.error('[generate-bg]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// THUMBNAIL — STYLE GUIDE ENGINE  (POST /api/analyze-style)
// ════════════════════════════════════════

const PK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function pkExtractVideoId(url) {
  if (!url) return null;
  let m;
  if ((m = url.match(/[?&]v=([\w-]{11})/)))        return m[1];
  if ((m = url.match(/youtu\.be\/([\w-]{11})/)))    return m[1];
  if ((m = url.match(/\/shorts\/([\w-]{11})/)))     return m[1];
  if ((m = url.match(/\/embed\/([\w-]{11})/)))      return m[1];
  return null;
}

function pkExtractChannelId(url) {
  const m = (url || '').match(/\/channel\/(UC[\w-]+)/);
  return m ? m[1] : null;
}

// Resolve a /@handle, /c/name or /user/name page to its UC… channel id
async function pkResolveChannelIdFromPage(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': PK_UA } });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/"channelId":"(UC[\w-]+)"/) || html.match(/"externalId":"(UC[\w-]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Search a creator name → first channel result's UC… id
async function pkSearchChannelId(name) {
  try {
    const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(name),
      { headers: { 'User-Agent': PK_UA } });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/"channelId":"(UC[\w-]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Most-recent video ids from a channel RSS feed
async function pkRecentVideoIds(channelId, limit = 6) {
  try {
    const r = await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId,
      { headers: { 'User-Agent': PK_UA } });
    if (!r.ok) return [];
    const xml = await r.text();
    return [...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map(x => x[1]).slice(0, limit);
  } catch { return []; }
}

// Fetch a video's thumbnail (maxres → hqdefault fallback) as base64
async function pkFetchThumbBase64(videoId) {
  for (const q of ['maxresdefault', 'hqdefault']) {
    try {
      const r = await fetch(`https://img.youtube.com/vi/${videoId}/${q}.jpg`, { headers: { 'User-Agent': PK_UA } });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 1500) return { mime: 'image/jpeg', data: buf.toString('base64') }; // skip 1x1 gray placeholder
      }
    } catch {}
  }
  return null;
}

function pkParseJson(txt) {
  if (!txt) throw new Error('Empty response from model.');
  try { return JSON.parse(txt); } catch {}
  const obj = txt.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }
  const arr = txt.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }
  throw new Error('Model returned unparseable JSON.');
}

const PK_STYLE_SCHEMA = `{
  "summary": "2-3 sentence description of the shared visual style",
  "palette": { "dominant": ["#.."], "accent": ["#.."], "mood": "warm|cool|high-contrast|muted|..." },
  "textPlacement": "top|center|bottom|left|right|split",
  "textTreatment": "huge-bold|outlined|boxed|minimal|gradient",
  "composition": "centric|rule-of-thirds|negative-space|busy|symmetrical",
  "contrast": "extreme|high|medium|low",
  "emotionalHook": "curiosity|fear|aspiration|controversy|calm|...",
  "faceUsage": "big-face|small-face|no-face",
  "fontWeightFeel": "ultra-heavy|heavy|medium|light",
  "recurringMotifs": ["..."],
  "applyHints": { "scene": "funvsgrowth|thinker|none", "headlineStyle": "...", "recommendedBgPrompt": "a Proles Kitchen on-brand background prompt distilled from this style, black bg, gold/red accents, NO faces" }
}`;

function pkStylePrompt() {
  return `You are a YouTube thumbnail art director. Study the shared visual style across the attached thumbnails and return STRICT JSON ONLY (no markdown, no prose) matching exactly this schema:
${PK_STYLE_SCHEMA}
Base every field on what you actually observe across the images. For applyHints.recommendedBgPrompt, distill the style into an on-brand background prompt for "Proles Kitchen" (a philosophy/lifestyle channel): pure black background, gold (#ECAA27) and red (#e05252) accents, cinematic and atmospheric, NO faces, NO text, NO logos.`;
}

// Vision analysis: Gemini primary, OpenAI GPT-4o fallback
async function pkAnalyzeImages(images) {
  const promptText = pkStylePrompt();

  if (process.env.GEMINI_API_KEY) {
    try {
      const parts = [{ text: promptText }];
      for (const img of images) parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } })
        }
      );
      const d = await r.json();
      if (r.ok) {
        const txt = d.candidates?.[0]?.content?.parts?.[0]?.text;
        if (txt) return pkParseJson(txt);
      } else {
        console.error('[analyze-style gemini]', d.error?.message || 'gemini vision failed');
      }
    } catch (e) { console.error('[analyze-style gemini]', e.message); }
  }

  if (process.env.OPENAI_API_KEY) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const content = [{ type: 'text', text: promptText }];
    for (const img of images) content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
    const result = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: 1200
    });
    return pkParseJson(result.choices?.[0]?.message?.content);
  }

  throw new Error('No vision API key available (set GEMINI_API_KEY or OPENAI_API_KEY).');
}

app.post('/api/analyze-style', async (req, res) => {
  const { urls = [], images = [], creators = [] } = req.body || {};
  const MAX = 10;
  const collected = [];      // { mime, data }
  const skipped = [];

  try {
    // 1. Video / channel URLs
    for (const raw of urls) {
      if (collected.length >= MAX) break;
      const u = (raw || '').trim();
      if (!u) continue;
      try {
        const vid = pkExtractVideoId(u);
        if (vid) {
          const img = await pkFetchThumbBase64(vid);
          if (img) collected.push(img); else skipped.push(`${u} (no thumbnail)`);
          continue;
        }
        let chId = pkExtractChannelId(u);
        if (!chId && /youtube\.com\/(@|c\/|user\/)/.test(u)) chId = await pkResolveChannelIdFromPage(u);
        if (chId) {
          const vids = await pkRecentVideoIds(chId, 6);
          if (!vids.length) skipped.push(`${u} (no videos in RSS)`);
          for (const v of vids) {
            if (collected.length >= MAX) break;
            const img = await pkFetchThumbBase64(v);
            if (img) collected.push(img);
          }
        } else {
          skipped.push(`${u} (could not resolve)`);
        }
      } catch (e) { skipped.push(`${u} (${e.message})`); }
    }

    // 2. Creator names
    for (const raw of creators) {
      if (collected.length >= MAX) break;
      const name = (raw || '').trim();
      if (!name) continue;
      try {
        const chId = await pkSearchChannelId(name);
        if (!chId) { skipped.push(`${name} (creator not found)`); continue; }
        const vids = await pkRecentVideoIds(chId, 6);
        if (!vids.length) skipped.push(`${name} (no videos in RSS)`);
        for (const v of vids) {
          if (collected.length >= MAX) break;
          const img = await pkFetchThumbBase64(v);
          if (img) collected.push(img);
        }
      } catch (e) { skipped.push(`${name} (${e.message})`); }
    }

    // 3. Uploaded data URLs
    for (const raw of images) {
      if (collected.length >= MAX) break;
      const m = (raw || '').match(/^data:([^;]+);base64,(.+)$/);
      if (m) collected.push({ mime: m[1], data: m[2] });
      else skipped.push('uploaded image (invalid data URL)');
    }

    if (!collected.length) {
      return res.status(400).json({ error: 'No images could be resolved from the provided inputs.', skipped });
    }

    const styleGuide = await pkAnalyzeImages(collected);
    res.json({ styleGuide, analyzedCount: collected.length, skipped });
  } catch (err) {
    console.error('[analyze-style]', err.message);
    res.status(500).json({ error: err.message, skipped });
  }
});

// ════════════════════════════════════════
// THUMBNAIL — POPULARITY BUILDER  (POST /api/popularity-suggest)
// ════════════════════════════════════════

// Curated knowledge base of winning thumbnail patterns for
// philosophy / lifestyle / health / mindset YouTube.
const PK_POPULARITY_RULES = [
  '3-5 word headlines outperform long ones — the eye reads them in a single glance at feed size.',
  'One focal point only. Competing elements split attention and lower click-through.',
  'Maximize contrast: bright text/subject against a dark background survives compression and small sizes.',
  'Curiosity-gap phrasing (open loops, "the truth about", "why nobody…") beats plain description.',
  'A single emphasized word in an accent color anchors the gaze and adds rhythm.',
  'Number or stark contrast hooks ("0 vs 100", "1 habit") trigger pattern-interrupt.',
  'Emotional single-word punch (OVERRATED, BROKEN, LIED) carries more weight than a sentence.',
  'Keep text in a safe zone (bottom-left or bottom band) away from the duration stamp.',
  'Avoid clutter — generous negative space reads as premium and confident.',
  'Consistency across thumbnails (palette, font, motif) compounds channel recognition.',
];

// ── Proven high-CTR title FORMULAS for philosophy / mindset / lifestyle ──
// {X} is the topic the user is making a thumbnail about.
const PK_TITLE_FORMULAS = [
  'The truth about {X}',
  'Why nobody {X}',
  '{X} is OVERRATED',
  'What they don\'t tell you about {X}',
  '0 vs 100: {X}',
  'Stop {X}',
  'The {X} nobody talks about',
  'This is why you {X}',
  '{X} changed everything',
  'You are not {X}',
  'Nobody is coming to {X}',
  'The dark side of {X}',
  'How {X} broke me',
  'Read this before you {X}',
];

// Emotional single-word punches that survive feed compression.
const PK_POWER_WORDS = [
  'OVERRATED', 'BROKEN', 'LIED', 'TRUTH', 'SECRET', 'NOBODY', 'NEVER', 'WRONG',
  'POWER', 'WEAK', 'FAKE', 'REAL', 'ALONE', 'FREE', 'PAIN', 'PEAK', 'LOST',
  'SOFT', 'HARD', 'COMFORT', 'DISCIPLINE', 'QUIT', 'WIN', 'DELUSION',
];

// Named TEMPLATE DESIGNS — each pairs a layout with accent + emphasis + scene.
// `apply` carries concrete control values the frontend can set directly.
const PK_TEMPLATE_DESIGNS = [
  {
    name: 'Bottom-Left Authority',
    detail: 'Massive Anton headline anchored bottom-left, the final word in a red box, single focal subject to the right. Commands the frame.',
    apply: { scene: 'thinker' }
  },
  {
    name: 'Centered Punch',
    detail: 'Two stacked lines centered, one gold accent word, heavy negative space. Reads in a single glance.',
    apply: { scene: 'none' }
  },
  {
    name: 'Contrast Hook',
    detail: 'A 0-vs-100 / before-after split with the headline as a number hook. Pattern-interrupt for the feed.',
    apply: { scene: 'funvsgrowth' }
  },
];

// ── Reference-thumbnail analysis (Gemini VISION over the 8 refs) ──
const PK_REF_ANALYSIS_FILE = path.join(PK_REFS_DIR, '_analysis.json');

async function pkAnalyzeRefs(force = false) {
  if (!force && fs.existsSync(PK_REF_ANALYSIS_FILE)) {
    try { return JSON.parse(fs.readFileSync(PK_REF_ANALYSIS_FILE, 'utf8')); } catch (_) {}
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const refs = pkLoadRefImages();
  if (!refs.length) return null;
  const prompt = `You are analyzing reference thumbnails the channel owner hand-picked as the look he wants to emulate. Study the WORDING and the TEMPLATE/LAYOUT DESIGN across all of them.
Return STRICT JSON ONLY (no prose):
{
  "wording": { "avgWordCount": number, "commonPowerWords": ["..."], "phrasingPatterns": ["short description of recurring phrasing"], "tone": "one phrase" },
  "design": { "textPosition": "where headline sits", "accentStyle": "how a word is emphasized (color/box)", "emphasis": "font weight/size feel", "layoutNotes": ["..."] },
  "templates": [ { "name": "short name", "description": "the recurring layout recipe" } ]
}`;
  const parts = [{ text: prompt }];
  for (const r of refs) parts.push({ inlineData: { mimeType: r.mimeType, data: r.data } });
  const resp = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }),
      signal: AbortSignal.timeout(60000)
    }
  );
  const d = await resp.json();
  if (!resp.ok) throw new Error(d.error?.message || 'ref analysis failed');
  const parsed = pkParseJson(d.candidates?.[0]?.content?.parts?.[0]?.text);
  if (parsed) { try { fs.writeFileSync(PK_REF_ANALYSIS_FILE, JSON.stringify(parsed, null, 2)); } catch (_) {} }
  return parsed;
}

// ── Live trending titles (best-effort YouTube search scrape, cached ~6h) ──
const PK_TRENDING_QUERIES = [
  'stoic discipline mindset', 'philosophy self improvement',
  'why you feel lost', 'dark psychology truth', 'how to be disciplined',
];
let _pkTrendingCache = { at: 0, titles: [], words: [] };

async function pkFetchTrending() {
  const SIX_H = 6 * 3600 * 1000;
  if (_pkTrendingCache.titles.length && (Date.now() - _pkTrendingCache.at) < SIX_H) return _pkTrendingCache;
  const titles = [];
  for (const q of PK_TRENDING_QUERIES) {
    try {
      const r = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q), {
        headers: { 'User-Agent': PK_UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(8000)
      });
      const html = await r.text();
      const re = /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"\}\]/g;
      let m, c = 0;
      while ((m = re.exec(html)) && c < 25) {
        try { const t = JSON.parse('"' + m[1] + '"'); if (t && t.length > 6) { titles.push(t); c++; } } catch (_) {}
      }
    } catch (_) { /* best effort — trending is optional enrichment */ }
  }
  // Frequency of meaningful UPPER-able words (drop stopwords + short tokens).
  const STOP = new Set(['the','a','an','to','of','and','or','for','in','on','is','are','you','your','my','how','why','this','that','with','what','it','i','be','do','not','was','will']);
  const freq = {};
  for (const t of titles) {
    for (const w of t.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/)) {
      if (w.length < 4 || STOP.has(w)) continue;
      freq[w] = (freq[w] || 0) + 1;
    }
  }
  const words = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([w]) => w);
  _pkTrendingCache = { at: Date.now(), titles: titles.slice(0, 60), words };
  return _pkTrendingCache;
}

function pkRuleSuggestions(current = {}) {
  const out = [];
  const headlineRaw = (current.headline || '').replace(/\|/g, ' ').trim();
  const words = headlineRaw ? headlineRaw.split(/\s+/) : [];

  if (words.length > 5) {
    out.push({
      id: 's_headline_len', type: 'headline', title: 'Shorten the headline to 3-5 words',
      detail: `Your headline is ${words.length} words. Shorter headlines read in one glance at thumbnail size and consistently outperform. Trim to the punchy core.`,
      proposed: { headline: words.slice(0, 4).join(' ') }
    });
  }
  if (!((current.accent || '').trim()) && words.length) {
    out.push({
      id: 's_accent', type: 'color', title: 'Add a gold accent word',
      detail: 'One word in the brand gold creates a single high-contrast anchor the eye lands on first, adding rhythm without new colors.',
      proposed: { accent: (words[words.length - 1] || '').toUpperCase() }
    });
  }
  if (!((current.eyebrow || '').trim()) || /proles kitchen/i.test(current.eyebrow || '')) {
    out.push({
      id: 's_curiosity', type: 'text', title: 'Use a curiosity-gap eyebrow',
      detail: 'A short tension phrase above the headline opens a curiosity loop and lifts click-through without adding clutter.',
      proposed: { eyebrow: 'THE TRUTH ABOUT' }
    });
  }
  if (current.scene === 'none') {
    out.push({
      id: 's_scene', type: 'scene', title: 'Add a single focal illustration',
      detail: 'A lone iconographic figure (the Thinker) gives one clear focal point and reads instantly — better than an empty frame.',
      proposed: { scene: 'thinker' }
    });
  }
  if ((current.subline || '').split(/\s+/).filter(Boolean).length > 4) {
    out.push({
      id: 's_subline', type: 'text', title: 'Tighten the subline',
      detail: 'Keep the subline to 2-3 words so it supports the headline instead of competing with it for attention.',
      proposed: {}
    });
  }
  out.push({
    id: 's_contrast', type: 'composition', title: 'Push contrast to the extreme',
    detail: 'High black-to-gold contrast survives feed compression and small sizes. Keep the background dark and the headline bright — let one element dominate.',
    proposed: {}
  });
  return out;
}

// Gemini synthesis grounded in: curated rules + proven FORMULAS + POWER WORDS +
// the owner's REFERENCE-THUMBNAIL analysis + LIVE TRENDING wording. Returns BOTH
// improvement suggestions (with paired template-design fields) AND fresh headline
// candidates the user can one-click apply.
async function pkHeadlineIntelligence(current, refInsights, trending) {
  const rulesText = PK_POPULARITY_RULES.map(r => '- ' + r).join('\n');
  const formulas = PK_TITLE_FORMULAS.map(f => '- ' + f).join('\n');
  const templates = PK_TEMPLATE_DESIGNS.map(t => `- ${t.name}: ${t.detail}`).join('\n');
  const topic = ((current.headline || '').replace(/\|/g, ' ').trim()) || (current.subline || '') || (current.scene || 'discipline & mindset');

  const prompt = `You are a YouTube thumbnail growth strategist for "Proles Kitchen", a philosophy / lifestyle / mindset channel.
Brand (immutable): pure black background, gold #ECAA27 + red #e05252 accents, Anton uppercase headlines. Never propose changing the brand colors.

Proven winning patterns:
${rulesText}

High-CTR title FORMULAS ({X} = the topic):
${formulas}

Proven emotional POWER WORDS:
${PK_POWER_WORDS.join(', ')}

Named TEMPLATE DESIGNS (pair wording with a layout):
${templates}

OWNER'S REFERENCE THUMBNAILS — analyzed wording + design to emulate:
${refInsights ? JSON.stringify(refInsights, null, 2) : '(none available)'}

LIVE TRENDING wording in this niche right now (most-frequent words in current top search titles):
${trending && trending.words && trending.words.length ? trending.words.join(', ') : '(unavailable)'}
${trending && trending.titles && trending.titles.length ? 'Sample trending titles:\n' + trending.titles.slice(0, 14).map(t => '- ' + t).join('\n') : ''}

Current thumbnail build (the topic to work from):
${JSON.stringify(current, null, 2)}
Topic for formulas: "${topic}"

Return STRICT JSON ONLY in this exact shape:
{
  "headlines": [
    { "text": "HEADLINE | SECOND LINE", "formula": "which formula/pattern it uses", "template": "one of the named template designs", "accent": "the single word to emphasize (UPPERCASE)", "scene": "funvsgrowth|thinker|none", "reason": "why it should perform, grounded in the refs/trending/formulas" }
  ],
  "suggestions": [
    { "id":"s1", "type":"headline|composition|color|scene|text", "title":"short imperative title", "detail":"why it helps + exactly what to change", "proposed": { optional concrete values among headline, subline, eyebrow, accent, scene } }
  ]
}
Rules:
- Provide 6 "headlines" candidates. Each must use "|" for the line break, be 2-5 words total, draw on the FORMULAS/POWER WORDS, and reflect the owner's reference wording + the live trending words where natural.
- "text" uppercase. "accent" must be one word that appears in "text". "scene" must be funvsgrowth|thinker|none.
- Provide 4-5 "suggestions" that improve the CURRENT build; when a suggestion implies a layout, set "proposed.scene" to match a template design.
- Ground every "reason"/"detail" in the refs, trending data, or a named formula — not generic advice.`;

  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.7 } }),
      signal: AbortSignal.timeout(45000)
    }
  );
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'gemini headline synthesis failed');
  const parsed = pkParseJson(d.candidates?.[0]?.content?.parts?.[0]?.text);
  if (!parsed) return null;
  return {
    headlines: Array.isArray(parsed.headlines) ? parsed.headlines : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : (Array.isArray(parsed) ? parsed : [])
  };
}

app.post('/api/popularity-suggest', async (req, res) => {
  const { current = {}, refresh = false } = req.body || {};
  try {
    let suggestions = pkRuleSuggestions(current);
    let headlines = [];
    let refInsights = null;
    let trendingWords = [];

    if (process.env.GEMINI_API_KEY) {
      // Ref-thumbnail analysis (cached on disk) + live trending (cached ~6h),
      // gathered in parallel; both are best-effort enrichment.
      const [refRes, trendRes] = await Promise.allSettled([
        pkAnalyzeRefs(!!refresh),
        pkFetchTrending()
      ]);
      refInsights = refRes.status === 'fulfilled' ? refRes.value : null;
      const trending = trendRes.status === 'fulfilled' ? trendRes.value : { words: [], titles: [] };
      trendingWords = (trending && trending.words) || [];

      try {
        const intel = await pkHeadlineIntelligence(current, refInsights, trending);
        if (intel) {
          if (intel.suggestions && intel.suggestions.length) suggestions = intel.suggestions;
          if (intel.headlines && intel.headlines.length) headlines = intel.headlines;
        }
      } catch (e) { console.error('[popularity-suggest synth]', e.message); }
    }

    res.json({ suggestions, headlines, trendingWords, refInsights });
  } catch (err) {
    console.error('[popularity-suggest]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// THUMBNAIL — SUBJECT BACKGROUND REMOVAL  (POST /api/remove-bg)
// Optional: shells out to Python `rembg`. If that infra is unavailable
// (e.g. Railway without Python/rembg), it gracefully returns the image
// unchanged with removed:false so the client can use it as-is.
// ════════════════════════════════════════
app.post('/api/remove-bg', express.json({ limit: '25mb' }), async (req, res) => {
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image (data URL) required' });

  const m = String(image).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'image must be a base64 data URL' });
  const inputBuf = Buffer.from(m[2], 'base64');

  const py = [
    'import sys, io, base64',
    'from rembg import remove',
    'from PIL import Image',
    'data = sys.stdin.buffer.read()',
    'img = Image.open(io.BytesIO(data)).convert("RGBA")',
    'out = remove(img)',
    'b = io.BytesIO(); out.save(b, "PNG")',
    'sys.stdout.write(base64.b64encode(b.getvalue()).decode())'
  ].join('\n');

  const { spawn } = require('child_process');
  const pyCmd = process.env.PYTHON_BIN || 'python';

  try {
    const out = await new Promise((resolve, reject) => {
      let proc;
      try { proc = spawn(pyCmd, ['-c', py]); }
      catch (e) { return reject(e); }
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('rembg timeout')); }, 60000);
      proc.on('error', err => { clearTimeout(timer); reject(err); });
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) resolve(stdout.trim());
        else reject(new Error(stderr.slice(-200) || ('rembg exit ' + code)));
      });
      proc.stdin.write(inputBuf);
      proc.stdin.end();
    });
    return res.json({ dataUrl: `data:image/png;base64,${out}`, removed: true });
  } catch (err) {
    console.error('[remove-bg] falling back, reason:', err.message);
    // Graceful fallback: return the original image untouched.
    return res.json({ dataUrl: image, removed: false, note: 'Auto background removal unavailable; using image as-is.' });
  }
});

// ════════════════════════════════════════
// 7 QUESTIONS API
// ════════════════════════════════════════

app.get('/api/questions', (req, res) => {
  const { relation, tier } = req.query;
  if (!relation || !tier) return res.status(400).json({ error: 'relation and tier are required' });

  const tierNum = parseInt(tier);
  const filtered = questions.filter(q => q.tier === tierNum && q.relations.includes(relation));
  const shuffled = [...filtered].sort(() => Math.random() - 0.5);
  res.json(shuffled);
});

app.post('/api/subscribe', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

  if (SHEETS_WEBHOOK_URL) {
    try {
      const url = `${SHEETS_WEBHOOK_URL}?type=subscribe&app=7questions&email=${encodeURIComponent(email)}`;
      await fetch(url, { redirect: 'follow' });
    } catch (err) { console.error('Sheets webhook error:', err.message); }
  } else {
    console.log('New subscriber (no webhook configured):', email);
  }
  res.json({ success: true });
});

app.post('/api/log', async (req, res) => {
  const { event, session, duration } = req.body;
  if (!['enter', 'exit'].includes(event)) return res.status(400).json({ error: 'Invalid event' });

  if (SHEETS_WEBHOOK_URL) {
    try {
      const params = new URLSearchParams({ type: 'visit', app: '7questions', event, session: session || '' });
      if (duration !== undefined) params.append('duration', duration);
      await fetch(`${SHEETS_WEBHOOK_URL}?${params.toString()}`, { redirect: 'follow' });
    } catch (err) { console.error('Visit log error:', err.message); }
  } else {
    console.log('Visit:', { event, session, duration });
  }
  res.json({ success: true });
});

app.post('/api/feedback', async (req, res) => {
  const { message, email, rating } = req.body;
  if (!message && !rating) return res.status(400).json({ error: 'Message or rating required' });

  if (SHEETS_WEBHOOK_URL) {
    try {
      const params = new URLSearchParams({ type: 'feedback', app: '7questions' });
      if (message) params.append('message', message);
      if (email) params.append('email', email);
      if (rating) params.append('rating', rating);
      await fetch(`${SHEETS_WEBHOOK_URL}?${params.toString()}`, { redirect: 'follow' });
    } catch (err) { console.error('Sheets webhook error:', err.message); }
  } else {
    console.log('New feedback:', { message, email });
  }
  res.json({ success: true });
});

// ════════════════════════════════════════
// AUTO-BIOGRAPHY API
// ════════════════════════════════════════

app.post('/api/generate', async (req, res) => {
  const { subject, authorName, answers } = req.body;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const chaptersText = Object.entries(answers).map(([chapterId, chapterAnswers]) => {
    const chapter = promptsData.chapters.find(c => c.id === chapterId);
    if (!chapter) return '';
    const qa = Object.entries(chapterAnswers)
      .filter(([, answer]) => answer && answer.trim())
      .map(([promptId, answer]) => {
        const prompt = chapter.prompts.find(p => p.id === promptId);
        if (!prompt) return '';
        const q = prompt.question.replace(/{name}/g, subject.name);
        return `Q: ${q}\nA: ${answer}`;
      })
      .filter(Boolean)
      .join('\n\n');
    if (!qa) return '';
    return `CHAPTER: ${chapter.title}\n${qa}`;
  }).filter(Boolean).join('\n\n---\n\n');

  const systemPrompt = `You are a gifted biographer and storyteller. You write warm, personal, beautifully crafted memoirs as gifts for families to treasure. Your writing is rich, intimate, and celebratory — like a book someone would hold onto for the rest of their life.`;

  const userPrompt = `Please write a memoir for ${subject.name} based on the following journal answers collected by ${authorName}.

IMPORTANT INSTRUCTIONS:
- Write in third person for all chapters ("${subject.name} was born...", "${subject.name} remembers...")
- EXCEPT the "Our Story Together" chapter — write that as a personal letter FROM ${authorName} TO ${subject.name}, using "you" and addressing them directly. Make it the most emotional chapter.
- Each chapter should be 2–4 flowing paragraphs of narrative prose
- Don't invent facts not in the answers, but do add warmth, vivid context, and emotional resonance
- Connect chapters naturally when relevant
- Keep the tone celebratory and personal — this is a gift

Also provide:
- A title for the book (more personal than just their name)
- A short dedication (1–2 sentences, from ${authorName} to ${subject.name})

Return your response as a valid JSON object with this exact structure:
{
  "title": "Book title here",
  "dedication": "Dedication text here",
  "chapters": [
    {
      "id": "chapter_id",
      "title": "Chapter Title",
      "content": "<p>Paragraph one...</p><p>Paragraph two...</p>"
    }
  ]
}

The chapter IDs must match exactly: ${Object.keys(answers).join(', ')}

Here are the journal answers:

${chaptersText}`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Could not parse the generated narrative. Please try again.' });
    const narrative = JSON.parse(jsonMatch[0]);
    res.json({ narrative, subject, authorName });
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/export/epub', async (req, res) => {
  const { title, author, dedication, chapters } = req.body;
  try {
    const Epub = require('epub-gen');
    const tempPath = path.join(os.tmpdir(), `book-${Date.now()}.epub`);
    const content = [];
    if (dedication) content.push({ title: 'Dedication', data: `<p style="font-style:italic; text-align:center; padding: 2em;">${dedication}</p>` });
    chapters.forEach(ch => content.push({ title: ch.title, data: ch.content }));
    const epub = new Epub({ title, author: author || 'A Family Story', publisher: 'Auto-Biography', content }, tempPath);
    await epub.promise;
    const filename = `${title.replace(/[^a-z0-9\s]/gi, '').trim().replace(/\s+/g, '_')}.epub`;
    res.download(tempPath, filename, () => { try { fs.unlinkSync(tempPath); } catch {} });
  } catch (err) {
    console.error('EPUB error:', err);
    res.status(500).json({ error: 'EPUB generation failed: ' + err.message });
  }
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

  const ext = (req.file.mimetype || '').includes('mp4') ? '.mp4' : '.webm';
  const tempPath = path.join(os.tmpdir(), `rec-${Date.now()}${ext}`);
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    fs.writeFileSync(tempPath, req.file.buffer);
    const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(tempPath), model: 'whisper-1' });
    res.json({ text: transcription.text });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
});

app.post('/api/send-email', async (req, res) => {
  const { email, phone, subject: subjectData, authorName, answers, narrative, recordings = [] } = req.body;
  if (!process.env.GOOGLE_REFRESH_TOKEN) return res.status(500).json({ error: 'Gmail not configured' });

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'http://localhost:3001/auth/callback'
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const bookHtml = narrative.chapters.map(ch => `
      <div style="margin-bottom:48px;">
        <h2 style="font-family:Georgia,serif;font-size:20px;color:#680707;border-bottom:1px solid #e0c97f;padding-bottom:10px;margin-bottom:20px;">${ch.title}</h2>
        ${ch.content.replace(/<p>/g, '<p style="font-family:Georgia,serif;font-size:16px;line-height:1.85;color:#222;margin-bottom:16px;text-indent:0;">')}
      </div>
    `).join('');

    const qaHtml = Object.entries(answers).map(([chapterId, chapterAnswers]) => {
      const chapter = promptsData.chapters.find(c => c.id === chapterId);
      if (!chapter) return '';
      const qas = Object.entries(chapterAnswers)
        .filter(([, a]) => a && a.trim())
        .map(([promptId, answer]) => {
          const prompt = chapter.prompts.find(p => p.id === promptId);
          if (!prompt) return '';
          const question = prompt.question.replace(/{name}/g, subjectData.name);
          const rec = recordings.find(r => r.chapterId === chapterId && r.promptId === promptId);
          return `
            <div style="margin-bottom:22px;">
              <p style="font-weight:600;font-family:Arial,sans-serif;font-size:13px;color:#666;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.04em;">${question}</p>
              <p style="font-family:Georgia,serif;font-size:15px;color:#222;line-height:1.75;background:#faf8f2;padding:14px 16px;border-left:3px solid #ECAA27;margin:0;">${answer}</p>
              ${rec ? `<p style="font-size:12px;color:#aaa;margin:6px 0 0;font-style:italic;">🎤 Voice recording attached: ${chapterId}_${promptId}.${rec.mimeType.includes('mp4') ? 'mp4' : 'webm'}</p>` : ''}
            </div>
          `;
        }).filter(Boolean).join('');
      if (!qas) return '';
      return `
        <div style="margin-bottom:36px;">
          <h3 style="font-family:Arial,sans-serif;font-size:15px;color:#680707;margin:0 0 14px;padding-bottom:6px;border-bottom:1px solid #eee;">${chapter.title}</h3>
          ${qas}
        </div>
      `;
    }).filter(Boolean).join('');

    const recordingNote = recordings.length > 0
      ? `${recordings.length} voice recording${recordings.length > 1 ? 's' : ''} attached as audio files.`
      : 'Voice recordings are saved in the Auto-Biography app.';

    const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="max-width:680px;margin:0 auto;font-family:Arial,sans-serif;background:#fff;padding:32px 24px;color:#222;">
  <div style="text-align:center;padding:48px 0 52px;border-bottom:3px solid #ECAA27;margin-bottom:48px;">
    <div style="font-size:36px;color:#ECAA27;margin-bottom:20px;">✦</div>
    <h1 style="font-family:Georgia,serif;font-size:32px;font-weight:700;color:#680707;margin:0 0 14px;line-height:1.25;">${narrative.title}</h1>
    ${narrative.dedication ? `<p style="font-family:Georgia,serif;font-style:italic;color:#888;font-size:15px;line-height:1.7;max-width:400px;margin:0 auto;">${narrative.dedication}</p>` : ''}
    <p style="color:#bbb;font-size:12px;margin-top:20px;letter-spacing:0.05em;">Created by ${authorName} &nbsp;·&nbsp; Stop & Connect</p>
  </div>
  ${bookHtml}
  <div style="background:#f8f6f0;border-top:2px solid #e8dbb0;margin-top:48px;padding:36px 32px;">
    <h2 style="font-family:Georgia,serif;font-size:22px;color:#333;margin:0 0 10px;">The Conversation Behind the Story</h2>
    <p style="color:#888;font-size:13px;margin:0 0 30px;line-height:1.6;">${subjectData.name}'s original answers — the heart of this memoir. ${recordingNote}</p>
    ${qaHtml}
  </div>
  ${phone ? `<p style="color:#bbb;font-size:12px;text-align:center;margin-top:20px;">Phone: ${phone}</p>` : ''}
  <p style="color:#ddd;font-size:11px;text-align:center;margin-top:10px;padding-bottom:24px;">Made with Stop & Connect &nbsp;·&nbsp; A memoir created together</p>
</body></html>`;

    const emailSubject = `${subjectData.name}'s Life Story — ${narrative.title}`;
    const boundary = `ab_boundary_${Date.now()}`;

    let mimeMessage = [
      `To: ${email}`,
      `Subject: ${emailSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      htmlBody,
      ''
    ].join('\r\n');

    for (const rec of recordings) {
      const base64Data = rec.data.split(',')[1];
      const ext = (rec.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
      const filename = `${rec.chapterId}_${rec.promptId}.${ext}`;
      const lines = base64Data.match(/.{1,76}/g) || [];
      mimeMessage += [
        `--${boundary}`,
        `Content-Type: ${rec.mimeType || 'audio/webm'}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${filename}"`,
        '',
        lines.join('\r\n'),
        ''
      ].join('\r\n');
    }
    mimeMessage += `--${boundary}--`;

    const raw = Buffer.from(mimeMessage).toString('base64url');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

    const analyticsData = readAnalytics();
    analyticsData.emails.push({
      time: new Date().toISOString(), email, phone: phone || '',
      subjectName: subjectData.name, relationship: subjectData.relationship,
      authorName, recordings: recordings.length, bookTitle: narrative.title
    });
    writeAnalytics(analyticsData);

    if (SHEETS_WEBHOOK_URL) {
      try {
        const params = new URLSearchParams({
          type: 'book_sent', app: 'auto-biography', email,
          subject: subjectData.name, author: authorName,
          relationship: subjectData.relationship, recordings: recordings.length, title: narrative.title
        });
        if (phone) params.append('phone', phone);
        await fetch(`${SHEETS_WEBHOOK_URL}?${params.toString()}`, { redirect: 'follow' });
      } catch (err) { console.error('Sheets webhook error:', err.message); }
    }

    res.json({ success: true, recordingsAttached: recordings.length });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-session', async (req, res) => {
  const { email, state } = req.body;
  if (!email || !state) return res.status(400).json({ error: 'Email and state required' });

  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify({ email, state, savedAt: new Date().toISOString() }));

  const origin = `${req.protocol}://${req.get('host')}`;
  const resumeUrl = `${origin}/autobiography?resume=${id}`;

  if (process.env.GOOGLE_REFRESH_TOKEN) {
    try {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        'http://localhost:3001/auth/callback'
      );
      oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const subjectName = state.subject?.name || 'your story';
      const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="max-width:560px;margin:0 auto;font-family:Arial,sans-serif;background:#fff;padding:40px 24px;color:#222;">
  <div style="text-align:center;margin-bottom:36px;">
    <div style="font-size:32px;color:#ECAA27;margin-bottom:12px;">✦</div>
    <h1 style="font-family:Georgia,serif;font-size:22px;color:#680707;margin:0;">Your Auto-Biography progress is saved</h1>
  </div>
  <p style="font-size:15px;line-height:1.7;color:#444;margin-bottom:28px;">
    Click the button below to pick up exactly where you left off on <strong>${subjectName}'s</strong> story — on any device, any time.
  </p>
  <div style="text-align:center;margin-bottom:32px;">
    <a href="${resumeUrl}" style="display:inline-block;background:#ECAA27;color:#000;font-family:Arial,sans-serif;font-size:15px;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;">Continue the Story →</a>
  </div>
  <p style="font-size:12px;color:#aaa;text-align:center;">Or copy this link: <a href="${resumeUrl}" style="color:#ECAA27;">${resumeUrl}</a></p>
  <p style="font-size:11px;color:#ddd;text-align:center;margin-top:24px;">Stop & Connect · A memoir created together</p>
</body></html>`;

      const emailSubject = `Continue ${subjectName}'s story — your Auto-Biography link`;
      const raw = Buffer.from(
        `To: ${email}\r\nContent-Type: text/html; charset=UTF-8\r\nMIME-Version: 1.0\r\nSubject: ${emailSubject}\r\n\r\n${htmlBody}`
      ).toString('base64url');
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    } catch (err) { console.error('Save session email error:', err.message); }
  }

  res.json({ ok: true, id, resumeUrl });
});

app.get('/api/session/:id', (req, res) => {
  const filePath = path.join(SESSIONS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session not found' });
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json({ state: data.state, savedAt: data.savedAt });
  } catch {
    res.status(500).json({ error: 'Could not read session' });
  }
});

app.post('/api/log/session', (req, res) => {
  const { id, subjectName, relationship, ua } = req.body;
  if (!id) return res.json({ ok: false });
  const data = readAnalytics();
  const existing = data.sessions.find(s => s.id === id);
  if (!existing) {
    data.sessions.push({
      id, start: new Date().toISOString(), lastSeen: new Date().toISOString(),
      duration: 0, subjectName: subjectName || '', relationship: relationship || '',
      bookGenerated: false, emailSent: false, ua: ua || ''
    });
    writeAnalytics(data);
  }
  res.json({ ok: true });
});

app.post('/api/log/ping', (req, res) => {
  const { id, duration, bookGenerated, emailSent } = req.body;
  if (!id) return res.json({ ok: false });
  const data = readAnalytics();
  const session = data.sessions.find(s => s.id === id);
  if (session) {
    session.lastSeen = new Date().toISOString();
    if (duration != null) session.duration = duration;
    if (bookGenerated) session.bookGenerated = true;
    if (emailSent) session.emailSent = true;
    writeAnalytics(data);
  }
  res.json({ ok: true });
});

app.post('/api/log/feedback', async (req, res) => {
  const { message, rating, email, subjectName, authorName, relationship } = req.body;
  if (!message && !rating) return res.json({ ok: false });

  const data = readAnalytics();
  data.feedback.push({
    time: new Date().toISOString(), message: message || '', rating: rating || null,
    email: email || '', subjectName: subjectName || '', authorName: authorName || '', relationship: relationship || ''
  });
  writeAnalytics(data);

  if (SHEETS_WEBHOOK_URL) {
    try {
      const params = new URLSearchParams({ type: 'feedback', app: 'auto-biography' });
      if (message) params.append('message', message);
      if (rating) params.append('rating', rating);
      if (email) params.append('email', email);
      if (subjectName) params.append('subject', subjectName);
      if (authorName) params.append('author', authorName);
      if (relationship) params.append('relationship', relationship);
      await fetch(`${SHEETS_WEBHOOK_URL}?${params.toString()}`, { redirect: 'follow' });
    } catch (err) { console.error('Sheets webhook error:', err.message); }
  }

  res.json({ ok: true });
});

// ════════════════════════════════════════
// ADMIN (Auto-Biography)
// ════════════════════════════════════════

app.get('/admin', (req, res) => {
  const key = process.env.ADMIN_KEY || 'admin';
  if (req.query.key !== key) return res.status(403).send('<h2>403 Forbidden — add ?key=YOUR_ADMIN_KEY</h2>');
  res.sendFile(path.join(__dirname, 'public/autobiography/admin.html'));
});

app.get('/api/admin/data', (req, res) => {
  const key = process.env.ADMIN_KEY || 'admin';
  if (req.query.key !== key) return res.status(403).json({ error: 'Forbidden' });
  res.json(readAnalytics());
});

// ════════════════════════════════════════

// ════════════════════════════════════════
// LOBBY MULTIPLAYER — Socket.io
// ════════════════════════════════════════

const rooms = new Map(); // code → room

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function sanitizeRoom(room) {
  return {
    code: room.code,
    timerMinutes: room.timerMinutes,
    status: room.status,
    teams: room.teams.map(t => ({ id: t.id, name: t.name, p1: t.p1, p2: t.p2, answered: t.answered, done: t.done })),
  };
}

function startVoting(room) {
  if (room.status !== 'playing') return;
  room.status = 'voting';
  room.voteQIdx = 0;
  room.votedThisQ = new Set();
  io.to(room.code).emit('vote-phase-start', {
    voteQs: room.voteQs,
    teams: room.teams.map(t => ({ id: t.id, name: t.name, p1: t.p1, p2: t.p2 })),
  });
  setTimeout(() => sendVoteQuestion(room), 4000);
}

function sendVoteQuestion(room) {
  if (room.status !== 'voting') return;
  room.votedThisQ = new Set();
  if (!room.votesPerQ[room.voteQIdx]) room.votesPerQ[room.voteQIdx] = {};
  io.to(room.code).emit('vote-question', {
    qIdx: room.voteQIdx,
    question: room.voteQs[room.voteQIdx],
  });
  clearTimeout(room.voteTimeout);
  room.voteTimeout = setTimeout(() => revealVoteResults(room), 60000);
}

function revealVoteResults(room) {
  clearTimeout(room.voteTimeout);
  const qIdx = room.voteQIdx;
  const votes = room.votesPerQ[qIdx] || {};
  const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);

  room.teams.forEach(t => {
    const v = votes[t.id] || 0;
    if (totalVotes > 0) {
      room.scores[t.id] = (room.scores[t.id] || 0) + Math.round((v / totalVotes) * 1000);
    }
  });

  const results = room.teams
    .map(t => ({ id: t.id, name: t.name, p1: t.p1, p2: t.p2, votes: votes[t.id] || 0, score: room.scores[t.id] || 0 }))
    .sort((a, b) => b.votes - a.votes);

  io.to(room.code).emit('vote-results', { qIdx, results });

  setTimeout(() => {
    room.voteQIdx++;
    if (room.voteQIdx >= room.voteQs.length) {
      endGame(room);
    } else {
      sendVoteQuestion(room);
    }
  }, 5000);
}

function endGame(room) {
  room.status = 'done';
  const sorted = room.teams
    .map(t => ({ id: t.id, name: t.name, p1: t.p1, p2: t.p2, score: room.scores[t.id] || 0 }))
    .sort((a, b) => b.score - a.score);
  io.to(room.code).emit('game-ended', { results: sorted });
  setTimeout(() => rooms.delete(room.code), 30 * 60 * 1000);
}

io.on('connection', socket => {
  socket.on('create-room', ({ timerMinutes, teamName, p1, p2 }) => {
    const code = genRoomCode();
    const teamId = 'team_' + Date.now();
    const team = { id: teamId, name: teamName || 'Team 1', p1: p1 || 'Player 1', p2: p2 || 'Player 2', socketId: socket.id, answered: 0, done: false };
    const room = {
      code, hostSocketId: socket.id,
      timerMinutes: timerMinutes || 12,
      teams: [team], status: 'waiting',
      privateQsByTeam: {}, voteQs: [],
      voteQIdx: 0, votesPerQ: {}, votedThisQ: new Set(),
      scores: { [teamId]: 0 },
      timerEnd: null, gameStartedAt: null, voteTimeout: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.teamId = teamId;
    socket.emit('room-created', { code, teamId, team: sanitizeRoom(room).teams[0] });
  });

  socket.on('join-room', ({ code, teamName, p1, p2 }) => {
    const upper = (code || '').toUpperCase();
    const room = rooms.get(upper);
    if (!room) { socket.emit('join-error', { message: 'Room not found. Check the code and try again.' }); return; }
    if (room.status !== 'waiting') { socket.emit('join-error', { message: 'This game has already started.' }); return; }
    if (room.teams.length >= 8) { socket.emit('join-error', { message: 'This room is full (max 8 teams).' }); return; }

    const teamId = 'team_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    const team = { id: teamId, name: teamName || `Team ${room.teams.length + 1}`, p1: p1 || 'Player 1', p2: p2 || 'Player 2', socketId: socket.id, answered: 0, done: false };
    room.teams.push(team);
    room.scores[teamId] = 0;
    socket.join(upper);
    socket.data.roomCode = upper;
    socket.data.teamId = teamId;

    socket.emit('room-joined', { room: sanitizeRoom(room), teamId });
    socket.to(upper).emit('team-joined', { team: { id: team.id, name: team.name, p1: team.p1, p2: team.p2, answered: 0, done: false } });
  });

  socket.on('start-game', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;
    if (room.teams.length < 2) { socket.emit('join-error', { message: 'Need at least 2 teams to start.' }); return; }
    if (room.status !== 'waiting') return;

    const privatePool = questions.filter(q => q.tier === 1 && q.relations.includes('group_private'));
    const votePool = questions.filter(q => q.tier === 1 && q.relations.includes('group_vote'));

    room.teams.forEach(team => {
      room.privateQsByTeam[team.id] = [...privatePool].sort(() => Math.random() - 0.5).slice(0, 7);
    });
    room.voteQs = [...votePool].sort(() => Math.random() - 0.5).slice(0, 7);
    room.status = 'playing';
    room.gameStartedAt = Date.now();
    room.timerEnd = Date.now() + room.timerMinutes * 60 * 1000;

    room.teams.forEach(team => {
      io.to(team.socketId).emit('game-started', {
        questions: room.privateQsByTeam[team.id],
        timerMinutes: room.timerMinutes,
        timerEnd: room.timerEnd,
        teams: room.teams.map(t => ({ id: t.id, name: t.name })),
        teamId: team.id,
        isHost: team.socketId === room.hostSocketId,
      });
    });
  });

  socket.on('progress-update', ({ code, answered }) => {
    const room = rooms.get(code);
    if (!room) return;
    const team = room.teams.find(t => t.socketId === socket.id);
    if (!team) return;
    team.answered = answered;
    io.to(code).emit('team-progress', { teamId: team.id, answered, done: false });
  });

  socket.on('team-done', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    const team = room.teams.find(t => t.socketId === socket.id);
    if (!team) return;
    team.done = true;
    team.answered = 7;
    io.to(code).emit('team-progress', { teamId: team.id, answered: 7, done: true });
    if (room.status === 'playing' && room.teams.every(t => t.done)) {
      startVoting(room);
    }
  });

  socket.on('force-vote', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostSocketId !== socket.id) return;
    startVoting(room);
  });

  socket.on('cast-vote', ({ code, forTeamId }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'voting') return;
    if (room.votedThisQ.has(socket.id)) return;
    room.votedThisQ.add(socket.id);
    const qIdx = room.voteQIdx;
    if (!room.votesPerQ[qIdx]) room.votesPerQ[qIdx] = {};
    room.votesPerQ[qIdx][forTeamId] = (room.votesPerQ[qIdx][forTeamId] || 0) + 1;
    if (room.votedThisQ.size >= room.teams.length) {
      revealVoteResults(room);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.hostSocketId === socket.id && room.status === 'waiting') {
      io.to(code).emit('host-disconnected');
      rooms.delete(code);
    }
  });
});

// ════════════════════════════════════════

httpServer.listen(PORT, () => {
  console.log(`Stop & Connect running on http://localhost:${PORT}`);
});
