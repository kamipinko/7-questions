// ═══════════════════════════════════════════════════════════════
// LOBBY.JS — 7 Questions Multiplayer Client
// ═══════════════════════════════════════════════════════════════

const socket = io();

// ── State ───────────────────────────────────────────────────────
let myTeamId    = null;
let myRoomCode  = null;
let isHost      = false;
let timerMin    = 12;
let gameStart   = null;   // Date.now() when game-started received
let timerEnd    = null;   // absolute ms timestamp
let myQuestions = [];
let currentQIdx = 0;
let allTeams    = [];    // [{ id, name, p1, p2 }]
let teamProgress= {};    // teamId → { answered, done }
let voteQuestions = [];
let hasVotedThisQ = false;
let warningShown  = {};  // qIdx → true (per-question warning guard)

// ── Screens ──────────────────────────────────────────────────────
const SCREENS = {};
document.querySelectorAll('.screen').forEach(s => {
  SCREENS[s.id.replace('screen-', '')] = s;
});

function showScreen(name) {
  Object.values(SCREENS).forEach(s => s.classList.remove('active'));
  if (SCREENS[name]) SCREENS[name].classList.add('active');
}

// ── Theme ────────────────────────────────────────────────────────
const themeToggle = document.getElementById('theme-toggle');
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  themeToggle.textContent = t === 'dark' ? '☀️' : '🌙';
}
applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('7q_theme', next);
  applyTheme(next);
});

// ── Entry ────────────────────────────────────────────────────────
document.getElementById('btn-host').addEventListener('click', () => showScreen('host-setup'));
document.getElementById('btn-join').addEventListener('click', () => showScreen('join-setup'));

// ── Host Setup ───────────────────────────────────────────────────
let hostTimerMin = 12;

document.querySelectorAll('#screen-host-setup .timer-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#screen-host-setup .timer-opt').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    hostTimerMin = parseInt(btn.dataset.min);
  });
});

function validateHostForm() {
  const ok = document.getElementById('host-team-name').value.trim()
    && document.getElementById('host-p1').value.trim()
    && document.getElementById('host-p2').value.trim();
  document.getElementById('host-create-btn').disabled = !ok;
}
['host-team-name', 'host-p1', 'host-p2'].forEach(id =>
  document.getElementById(id).addEventListener('input', validateHostForm)
);

document.getElementById('host-create-btn').addEventListener('click', () => {
  socket.emit('create-room', {
    timerMinutes: hostTimerMin,
    teamName: document.getElementById('host-team-name').value.trim(),
    p1: document.getElementById('host-p1').value.trim(),
    p2: document.getElementById('host-p2').value.trim(),
  });
});

document.getElementById('host-setup-back').addEventListener('click', () => showScreen('entry'));

// ── Join Setup ───────────────────────────────────────────────────
function validateJoinForm() {
  const ok = document.getElementById('join-code').value.trim().length === 4
    && document.getElementById('join-team-name').value.trim()
    && document.getElementById('join-p1').value.trim()
    && document.getElementById('join-p2').value.trim();
  document.getElementById('join-btn').disabled = !ok;
}
['join-code', 'join-team-name', 'join-p1', 'join-p2'].forEach(id =>
  document.getElementById(id).addEventListener('input', validateJoinForm)
);
document.getElementById('join-code').addEventListener('input', function() {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  validateJoinForm();
});

document.getElementById('join-btn').addEventListener('click', () => {
  document.getElementById('join-error').style.display = 'none';
  socket.emit('join-room', {
    code: document.getElementById('join-code').value.trim().toUpperCase(),
    teamName: document.getElementById('join-team-name').value.trim(),
    p1: document.getElementById('join-p1').value.trim(),
    p2: document.getElementById('join-p2').value.trim(),
  });
});

document.getElementById('join-setup-back').addEventListener('click', () => showScreen('entry'));

// ── Host Waiting Room ────────────────────────────────────────────
document.getElementById('host-start-btn').addEventListener('click', () => {
  socket.emit('start-game', { code: myRoomCode });
});

function renderHostTeamList() {
  const el = document.getElementById('host-team-list');
  if (!el) return;
  el.innerHTML = allTeams.map((t, i) => `
    <div class="waiting-team-row">
      <span class="waiting-team-num">${i + 1}</span>
      <span class="waiting-team-name">${t.name}</span>
      ${i === 0 ? '<span class="host-chip">HOST</span>' : ''}
    </div>
  `).join('');
  updateHostStartBtn();
}

function updateHostStartBtn() {
  const btn  = document.getElementById('host-start-btn');
  const hint = document.getElementById('host-waiting-hint');
  const can  = allTeams.length >= 2;
  btn.disabled = !can;
  if (hint) hint.textContent = can
    ? `${allTeams.length} teams ready — start whenever you're set!`
    : 'Waiting for more teams to join... (need at least 2)';
}

// ── Join Waiting Room ────────────────────────────────────────────
function renderJoinTeamList() {
  const el = document.getElementById('join-team-list');
  if (!el) return;
  el.innerHTML = allTeams.map((t, i) => `
    <div class="waiting-team-row">
      <span class="waiting-team-num">${i + 1}</span>
      <span class="waiting-team-name">${t.name}${t.id === myTeamId ? ' <em style="opacity:.6;font-style:normal;">(you)</em>' : ''}</span>
    </div>
  `).join('');
}

// ── Game Screen ──────────────────────────────────────────────────
let timerInterval = null;
let voteCountdown = null;

function startGameTimer() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, timerEnd - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const el = document.getElementById('game-timer-display');
    if (el) {
      el.textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
      el.classList.toggle('warning', remaining > 0 && remaining < 60000);
    }
    checkPaceWarning();
    if (remaining <= 0) clearInterval(timerInterval);
  }, 1000);
}

function checkPaceWarning() {
  if (!gameStart || !timerEnd || currentQIdx >= 7) return;
  const totalMs = timerMin * 60 * 1000;
  const perQ    = totalMs / 7;
  const elapsed = Date.now() - gameStart;

  // Trigger if team has burned through 1.5x the budget for their current question
  if (elapsed >= (currentQIdx + 1.5) * perQ && !warningShown[currentQIdx]) {
    warningShown[currentQIdx] = true;
    const timeLeftMs  = Math.max(0, timerEnd - Date.now());
    const timeLeftMin = Math.ceil(timeLeftMs / 60000);
    const qsLeft      = 7 - currentQIdx;
    showPaceWarning(
      `Q${currentQIdx + 1} of 7 · ${timeLeftMin} min left · ${qsLeft} question${qsLeft !== 1 ? 's' : ''} to go — keep the conversation moving!`
    );
  }
}

function showPaceWarning(msg) {
  const el = document.getElementById('game-pace-warning');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 10000);
}

function renderGameQuestion() {
  const q = myQuestions[currentQIdx];
  if (!q) return;
  document.getElementById('game-question-text').textContent = q.text;
  document.getElementById('game-q-counter').textContent = `${currentQIdx + 1} / 7`;
}

function advanceQ() {
  socket.emit('progress-update', { code: myRoomCode, answered: currentQIdx + 1 });
  currentQIdx++;
  if (currentQIdx >= 7) {
    socket.emit('team-done', { code: myRoomCode });
    clearInterval(timerInterval);
    renderDoneProgress();
    if (isHost) document.getElementById('host-force-vote-btn').style.display = 'block';
    showScreen('team-done');
  } else {
    renderGameQuestion();
    checkPaceWarning();
  }
}

document.getElementById('game-btn-next').addEventListener('click', advanceQ);
document.getElementById('game-btn-skip').addEventListener('click', advanceQ);

function renderDoneProgress() {
  const el = document.getElementById('done-progress-list');
  if (!el) return;
  el.innerHTML = allTeams.map(t => {
    const p = teamProgress[t.id] || { answered: 0, done: false };
    const pct = Math.round((p.answered / 7) * 100);
    return `
      <div class="progress-row">
        <span class="progress-name">${t.name}</span>
        <span class="progress-bar-wrap"><span class="progress-bar" style="width:${pct}%"></span></span>
        <span class="progress-count">${p.done ? '✅' : `${p.answered}/7`}</span>
      </div>
    `;
  }).join('');
}

document.getElementById('host-force-vote-btn').addEventListener('click', () => {
  if (!confirm('Skip to voting? Teams that aren\'t finished will move along too.')) return;
  socket.emit('force-vote', { code: myRoomCode });
});

// ── Vote Question ────────────────────────────────────────────────
function renderVoteQuestion(qIdx, question) {
  hasVotedThisQ = false;
  document.getElementById('vote-q-counter').textContent = `${qIdx + 1} of 7`;
  document.getElementById('vote-question-text').textContent = question.text;

  const area = document.getElementById('vote-stage-area');
  let countdown = 10;
  area.innerHTML = `
    <p class="vote-stage-label">Have your team answer this question out loud to the group.</p>
    <div class="vote-countdown" id="vote-cd">${countdown}</div>
    <p class="vote-muted" id="vote-cd-label">Voting opens in ${countdown}s…</p>
  `;

  clearInterval(voteCountdown);
  voteCountdown = setInterval(() => {
    countdown--;
    const cd = document.getElementById('vote-cd');
    const lb = document.getElementById('vote-cd-label');
    if (cd) cd.textContent = countdown;
    if (lb) lb.textContent = countdown > 0 ? `Voting opens in ${countdown}s…` : 'Time to vote!';
    if (countdown <= 0) {
      clearInterval(voteCountdown);
      renderVoteButtons();
    }
  }, 1000);

  showScreen('vote-question');
}

function renderVoteButtons() {
  const area = document.getElementById('vote-stage-area');
  const others = allTeams.filter(t => t.id !== myTeamId);
  area.innerHTML = `
    <p class="vote-stage-label">Who gave the most interesting answer?</p>
    <div class="vote-team-options">
      ${others.map(t => `<button class="vote-team-btn" data-id="${t.id}">${t.name}</button>`).join('')}
    </div>
  `;
  area.querySelectorAll('.vote-team-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (hasVotedThisQ) return;
      hasVotedThisQ = true;
      socket.emit('cast-vote', { code: myRoomCode, forTeamId: btn.dataset.id });
      area.innerHTML = `<div class="vote-submitted">✓ Vote cast! Waiting for the others...</div>`;
    });
  });
}

// ── Vote Reveal ──────────────────────────────────────────────────
function renderVoteReveal(qIdx, results) {
  clearInterval(voteCountdown);
  document.getElementById('reveal-q-label').textContent = `Q${qIdx + 1} Results`;
  const maxVotes = Math.max(...results.map(r => r.votes), 1);
  document.getElementById('reveal-bars').innerHTML = results.map((r, i) => `
    <div class="reveal-row">
      <span class="reveal-rank">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}</span>
      <div class="reveal-team-info">
        <span class="reveal-name">${r.name}</span>
        <div class="reveal-bar-wrap">
          <div class="reveal-bar" style="width:${Math.round((r.votes / maxVotes) * 100)}%"></div>
        </div>
      </div>
      <div class="reveal-stats">
        <span class="reveal-votes">${r.votes} vote${r.votes !== 1 ? 's' : ''}</span>
        <span class="reveal-score">${r.score} pts</span>
      </div>
    </div>
  `).join('');
  showScreen('vote-reveal');
}

// ── Socket Events ────────────────────────────────────────────────
socket.on('room-created', ({ code, teamId, team }) => {
  myRoomCode = code;
  myTeamId   = teamId;
  isHost     = true;
  allTeams   = [{ id: team.id, name: team.name, p1: team.p1, p2: team.p2 }];
  teamProgress[teamId] = { answered: 0, done: false };

  document.getElementById('room-code-display').textContent = code;

  const joinUrl = `${location.origin}/play/lobby?join=${code}`;
  document.getElementById('host-qr-wrap').innerHTML =
    `<img src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(joinUrl)}" class="qr-img" alt="QR code to join" />`;

  renderHostTeamList();
  showScreen('host-waiting');
});

socket.on('room-joined', ({ room, teamId }) => {
  myRoomCode = room.code;
  myTeamId   = teamId;
  isHost     = false;
  allTeams   = room.teams;
  room.teams.forEach(t => { teamProgress[t.id] = { answered: t.answered, done: t.done }; });

  document.getElementById('join-room-label').textContent = `Room: ${room.code}`;
  renderJoinTeamList();
  showScreen('join-waiting');
});

socket.on('team-joined', ({ team }) => {
  if (!allTeams.find(t => t.id === team.id)) {
    allTeams.push(team);
    teamProgress[team.id] = { answered: 0, done: false };
  }
  renderHostTeamList();
  renderJoinTeamList();
});

socket.on('game-started', ({ questions, timerMinutes, timerEnd: te, teams, teamId, isHost: iAmHost }) => {
  myQuestions  = questions;
  timerMin     = timerMinutes;
  timerEnd     = te;
  gameStart    = Date.now();
  currentQIdx  = 0;
  warningShown = {};
  allTeams     = teams;
  isHost       = iAmHost;
  // Sync progress state
  allTeams.forEach(t => { if (!teamProgress[t.id]) teamProgress[t.id] = { answered: 0, done: false }; });

  const mine = allTeams.find(t => t.id === myTeamId);
  document.getElementById('game-team-badge').textContent = mine ? mine.name : 'Your Team';

  renderGameQuestion();
  startGameTimer();
  showScreen('game');
});

socket.on('team-progress', ({ teamId, answered, done }) => {
  teamProgress[teamId] = { answered, done: done || false };
  if (SCREENS['team-done'].classList.contains('active')) renderDoneProgress();
});

socket.on('vote-phase-start', ({ voteQs, teams }) => {
  voteQuestions = voteQs;
  allTeams = teams;
  clearInterval(timerInterval);

  document.getElementById('vote-intro-teams').innerHTML = teams
    .map(t => `<div class="vote-team-pill">${t.name}</div>`).join('');
  showScreen('vote-intro');
});

socket.on('vote-question', ({ qIdx, question }) => {
  renderVoteQuestion(qIdx, question);
});

socket.on('vote-results', ({ qIdx, results }) => {
  renderVoteReveal(qIdx, results);
});

socket.on('game-ended', ({ results }) => {
  const winner = results[0];
  document.getElementById('final-title').textContent =
    winner && winner.score > 0 ? `${winner.name} Wins! 🏆` : 'Game Over!';
  document.getElementById('final-subtitle').textContent =
    winner && winner.score > 0
      ? `${winner.p1} & ${winner.p2} took home the most points.`
      : 'Thanks for playing — everyone brought something worth hearing.';

  document.getElementById('final-leaderboard').innerHTML = results.map((r, i) => `
    <div class="leaderboard-row ${i === 0 && r.score > 0 ? 'leader' : ''}">
      <span class="lb-rank">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}</span>
      <div class="lb-team">
        <span class="lb-name">${r.name}</span>
        <span class="lb-players">${r.p1} & ${r.p2}</span>
      </div>
      <span class="lb-votes">${r.score} <small>pts</small></span>
    </div>
  `).join('');

  showScreen('results');
});

socket.on('join-error', ({ message }) => {
  const el = document.getElementById('join-error');
  if (el) { el.textContent = message; el.style.display = 'block'; }
});

socket.on('host-disconnected', () => {
  alert('The host disconnected. The game has ended.');
  window.location.href = '/play/lobby';
});

// ── Auto-fill from QR code scan (?join=CODE) ─────────────────────
const autoCode = new URLSearchParams(window.location.search).get('join');
if (autoCode) {
  document.getElementById('join-code').value = autoCode.toUpperCase();
  showScreen('join-setup');
  validateJoinForm();
}
