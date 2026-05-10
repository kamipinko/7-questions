// --- Visit logging ---
const SESSION_ID = Math.random().toString(36).slice(2, 10);
const SESSION_START = Date.now();

function logVisit(event) {
  const payload = { event, session: SESSION_ID };
  if (event === 'exit') payload.duration = Math.round((Date.now() - SESSION_START) / 1000);
  const body = JSON.stringify(payload);
  if (event === 'exit') {
    navigator.sendBeacon('/api/log', new Blob([body], { type: 'application/json' }));
  } else {
    fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
  }
}

logVisit('enter');
window.addEventListener('pagehide', () => logVisit('exit'));

const screens = {
  relation: document.getElementById('screen-relation'),
  question: document.getElementById('screen-question'),
  done:     document.getElementById('screen-done'),
  spin:     document.getElementById('screen-spin'),
};

const RELATION_LABELS = {
  family: '👨‍👩‍👧 Family',
  friends: '👥 Friends',
  date: '💕 Date',
  spicy: '🌶️ Spicy',
};

// Engagement thresholds (seconds, avg per question answered)
const ENGAGE_DEEP = 60;  // ≥60s avg → encouraging popup from Q2
const ENGAGE_MID  = 30;  // 30–60s avg → encouraging popup from Q3

const TOTAL_QUESTIONS = 7;

let state = {
  relation: null,
  questions: [],
  currentIndex: 0,
  tier: 1,
  totalAnswered: 0,
  skippedCount: 0,
  questionStartTime: null,
  elapsedTimes: [],
  depthOffered: [],
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// --- Age Gate ---
const ageGate = document.getElementById('age-gate');
document.getElementById('age-gate-confirm').addEventListener('click', () => {
  ageGate.style.display = 'none';
  startGame();
});
document.getElementById('age-gate-cancel').addEventListener('click', () => {
  ageGate.style.display = 'none';
  state.relation = null;
});

// --- Start Modal ---
const startModal = document.getElementById('start-modal');

function showStartModal(relation, onConfirm) {
  startModal.style.display = 'flex';
  startModal._onConfirm = onConfirm;
}

document.getElementById('start-modal-back').addEventListener('click', () => {
  startModal.style.display = 'none';
  state.relation = null;
});

document.getElementById('start-modal-confirm').addEventListener('click', () => {
  startModal.style.display = 'none';
  showPlayerSetupModal(startModal._onConfirm);
});

// --- Relation Selection ---
document.querySelectorAll('.relation-card').forEach(btn => {
  btn.addEventListener('click', () => {
    state.relation = btn.dataset.relation;
    showStartModal(state.relation, () => startGame());
  });
});

const spicyBtn = document.querySelector('.spicy-btn');
const lustWarning = document.getElementById('lust-warning');

spicyBtn.addEventListener('click', () => {
  state.relation = 'spicy';
  spicyBtn.classList.add('tapped');
  setTimeout(() => {
    spicyBtn.classList.remove('tapped');
    showStartModal('spicy', () => { lustWarning.style.display = 'flex'; });
  }, 420);
});

document.getElementById('lust-back').addEventListener('click', () => {
  lustWarning.style.display = 'none';
  state.relation = null;
});

document.getElementById('lust-continue').addEventListener('click', () => {
  lustWarning.style.display = 'none';
  ageGate.style.display = 'flex';
});

// --- Secret spicy reveal: 10 taps at bottom center of screen ---
let spicyTapCount = 0;
const TAP_REVEAL = 10;
const tapZone = document.getElementById('spicy-tap-zone');

tapZone.addEventListener('click', () => {
  if (!screens.relation.classList.contains('active')) return;
  spicyTapCount++;
  if (spicyTapCount >= TAP_REVEAL) {
    spicyBtn.style.display = 'flex';
    tapZone.style.display = 'none';
  }
});

// --- Theme toggle ---
(function() {
  const btn = document.getElementById('theme-toggle');
  const mq  = window.matchMedia('(prefers-color-scheme: light)');

  function effectiveTheme() {
    const saved = document.documentElement.getAttribute('data-theme');
    if (saved) return saved;
    return mq.matches ? 'light' : 'dark';
  }

  function updateIcon() {
    btn.textContent = effectiveTheme() === 'dark' ? '☀️' : '🌙';
  }

  updateIcon();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('7q_theme', next);
    updateIcon();
  });

  mq.addEventListener('change', () => {
    const override = localStorage.getItem('7q_theme');
    if (!override) {
      document.documentElement.setAttribute('data-theme', mq.matches ? 'light' : 'dark');
    } else {
      const newSystem = mq.matches ? 'light' : 'dark';
      if (override === newSystem) {
        localStorage.removeItem('7q_theme');
      }
    }
    updateIcon();
  });
})();

// --- Banner / Back → home ---
document.querySelector('.site-banner').addEventListener('click', goHome);
document.getElementById('back-to-relation').addEventListener('click', goHome);

function goHome() {
  state.relation = null;
  showScreen('relation');
}

// --- Start game ---
async function startGame() {
  state.questions = [];
  state.currentIndex = 0;
  state.tier = 1;
  state.totalAnswered = 0;
  state.skippedCount = 0;
  state.questionStartTime = null;
  state.elapsedTimes = [];
  state.depthOffered = [];
  await loadQuestionsForTier(1);
  showQuestion();
  showScreen('question');
}

// --- Load questions for a given tier (server-shuffled, sliced to remaining count) ---
async function loadQuestionsForTier(tier) {
  const res = await fetch(`/api/questions?relation=${state.relation}&tier=${tier}`);
  const all = await res.json();
  const remaining = TOTAL_QUESTIONS - state.totalAnswered;
  state.questions = all.slice(0, Math.max(remaining, 1));
  state.currentIndex = 0;
}

// --- Render current question ---
function showQuestion() {
  const q = state.questions[state.currentIndex];
  document.getElementById('question-text').textContent = q.text;

  const relBadge = document.getElementById('relation-badge');
  relBadge.textContent = RELATION_LABELS[state.relation];
  relBadge.className = `badge ${state.relation}`;

  state.questionStartTime = Date.now();

  if (playerState.players.length >= 2) {
    runMiniSpin();
  }
}

// --- Next: track time, check depth prompt, advance ---
document.getElementById('btn-next').addEventListener('click', () => {
  const elapsed = (Date.now() - state.questionStartTime) / 1000;
  state.elapsedTimes.push(elapsed);
  state.totalAnswered++;

  if (state.totalAnswered >= TOTAL_QUESTIONS) {
    showPreDoneModal();
    return;
  }

  state.currentIndex++;

  if (state.currentIndex >= state.questions.length) {
    showPreDoneModal();
    return;
  }

  if (shouldShowDepthPrompt()) {
    state.depthOffered.push(state.tier);
    showEngagePopup();
    return;
  }

  showQuestion();
});

// --- Skip: advance without time tracking ---
document.getElementById('btn-skip').addEventListener('click', () => {
  state.skippedCount++;
  state.totalAnswered++;

  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'question_skipped', session: SESSION_ID, answer: 'SKIPPED' }),
  }).catch(() => {});

  if (state.totalAnswered >= TOTAL_QUESTIONS) {
    showPreDoneModal();
    return;
  }

  state.currentIndex++;

  if (state.currentIndex >= state.questions.length) {
    showPreDoneModal();
    return;
  }

  showQuestion();
});

// --- Depth prompt logic ---
function shouldShowDepthPrompt() {
  if (state.tier >= 3) return false;
  if (state.depthOffered.includes(state.tier)) return false;

  const times = state.elapsedTimes;
  if (times.length === 0) return false;
  const avg = times.reduce((a, b) => a + b, 0) / times.length;

  if (avg >= ENGAGE_DEEP && state.currentIndex >= 1) return true;  // slow: prompt from Q2
  if (avg >= ENGAGE_MID  && state.currentIndex >= 2) return true;  // medium: prompt from Q3
  return false;
}

const engageModal = document.getElementById('engage-modal');

function showEngagePopup() {
  engageModal.style.display = 'flex';
}

document.getElementById('depth-keep').addEventListener('click', () => {
  engageModal.style.display = 'none';
  showQuestion();
});

document.getElementById('depth-go-deeper').addEventListener('click', async () => {
  engageModal.style.display = 'none';
  state.tier++;
  state.elapsedTimes = [];
  await loadQuestionsForTier(state.tier);
  showQuestion();
});

// --- Pre-done email modal (after question 7) ---
const preDoneModal = document.getElementById('pre-done-modal');

function showPreDoneModal() {
  preDoneModal.style.display = 'flex';
}

document.getElementById('pre-done-email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('pre-done-email-input').value.trim();
  if (!email) return;

  try {
    await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  } catch (_) {}

  document.getElementById('pre-done-email-form').style.display = 'none';
  document.getElementById('pre-done-skip').style.display = 'none';
  const thanks = document.getElementById('pre-done-thanks');
  thanks.textContent = "You're on the list ✓";
  thanks.style.display = 'block';

  setTimeout(() => {
    preDoneModal.style.display = 'none';
    resetPreDoneModal();
    showDoneScreen();
  }, 1500);
});

document.getElementById('pre-done-skip').addEventListener('click', () => {
  preDoneModal.style.display = 'none';
  resetPreDoneModal();
  showDoneScreen();
});

function resetPreDoneModal() {
  document.getElementById('pre-done-email-form').style.display = '';
  document.getElementById('pre-done-skip').style.display = '';
  document.getElementById('pre-done-thanks').style.display = 'none';
  document.getElementById('pre-done-email-input').value = '';
}

// --- Done screen ---
function showDoneScreen() {
  const note = document.getElementById('done-skip-note');
  if (state.skippedCount > 0) {
    note.textContent = `You skipped ${state.skippedCount} question${state.skippedCount > 1 ? 's' : ''}.`;
    note.style.display = '';
  } else {
    note.style.display = 'none';
  }
  showScreen('done');
}

document.getElementById('done-restart').addEventListener('click', () => {
  state.relation = null;
  showScreen('relation');
});

// --- Feedback ---
const feedbackModal = document.getElementById('feedback-modal');
let fbRating = 0;

document.getElementById('feedback-rating-row').addEventListener('click', e => {
  const btn = e.target.closest('.fb-rating-btn');
  if (!btn) return;
  fbRating = parseInt(btn.dataset.val);
  document.querySelectorAll('.fb-rating-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.val) <= fbRating);
  });
});

document.getElementById('feedback-tab').addEventListener('click', () => {
  fbRating = 0;
  document.querySelectorAll('.fb-rating-btn').forEach(b => b.classList.remove('active'));
  feedbackModal.style.display = 'flex';
});

document.getElementById('feedback-close').addEventListener('click', () => {
  feedbackModal.style.display = 'none';
});

feedbackModal.addEventListener('click', (e) => {
  if (e.target === feedbackModal) feedbackModal.style.display = 'none';
});

document.getElementById('feedback-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = document.getElementById('feedback-message').value.trim();
  const email = document.getElementById('feedback-email').value.trim();
  if (!message) return;

  try {
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, email, rating: fbRating || null }),
    });
  } catch (_) {}

  document.getElementById('feedback-form').style.display = 'none';
  document.getElementById('feedback-close').style.display = 'none';
  document.getElementById('feedback-thanks').style.display = 'block';

  setTimeout(() => {
    feedbackModal.style.display = 'none';
    document.getElementById('feedback-form').style.display = '';
    document.getElementById('feedback-close').style.display = '';
    document.getElementById('feedback-thanks').style.display = 'none';
    document.getElementById('feedback-message').value = '';
    document.getElementById('feedback-email').value = '';
  }, 2000);
});

// ════════════════════════════════════════════════
// PLAYER SETUP + SPIN WHEEL SYSTEM
// ════════════════════════════════════════════════

const playerState = {
  players: [],
  lastPicked: null,
  currentPicker: null,
};

function resetPlayerState() {
  playerState.players = [];
  playerState.lastPicked = null;
  playerState.currentPicker = null;
  document.getElementById('player-turn-banner').style.display = 'none';
}

const playerSetupModal = document.getElementById('player-setup-modal');
const playerNameInput  = document.getElementById('player-name-input');
const playerChipsList  = document.getElementById('player-chips-list');
const playerSpinBtn    = document.getElementById('player-setup-spin');

function showPlayerSetupModal(onSkip) {
  playerSetupModal.style.display = 'flex';
  playerSetupModal._onSkip = onSkip;
  renderPlayerChips();
  updateSpinBtnState();
  playerNameInput.value = '';
  setTimeout(() => playerNameInput.focus(), 100);
}

function renderPlayerChips() {
  playerChipsList.innerHTML = '';
  playerState.players.forEach((name, i) => {
    const chip = document.createElement('div');
    chip.className = 'player-chip-item';
    chip.innerHTML = '<span>' + name + '</span><button class="player-chip-remove" data-i="' + i + '" aria-label="Remove ' + name + '">×</button>';
    playerChipsList.appendChild(chip);
  });
}

function updateSpinBtnState() {
  playerSpinBtn.disabled = playerState.players.length < 2;
}

function addPlayer() {
  const name = playerNameInput.value.trim();
  if (!name) return;
  if (playerState.players.includes(name)) { playerNameInput.select(); return; }
  playerState.players.push(name);
  playerNameInput.value = '';
  renderPlayerChips();
  updateSpinBtnState();
}

document.getElementById('player-add-btn').addEventListener('click', addPlayer);
playerNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addPlayer(); }
});
playerChipsList.addEventListener('click', (e) => {
  const btn = e.target.closest('.player-chip-remove');
  if (!btn) return;
  const i = parseInt(btn.dataset.i);
  playerState.players.splice(i, 1);
  renderPlayerChips();
  updateSpinBtnState();
});

// Prevent overlay clicks from propagating to document-level handlers and accidentally closing the modal
playerSetupModal.addEventListener('click', (e) => { e.stopPropagation(); });
document.querySelector('#player-setup-modal .player-setup-box').addEventListener('click', (e) => { e.stopPropagation(); });

document.getElementById('player-setup-skip').addEventListener('click', () => {
  playerSetupModal.style.display = 'none';
  resetPlayerState();
  if (playerSetupModal._onSkip) playerSetupModal._onSkip();
});

document.getElementById('player-setup-spin').addEventListener('click', () => {
  if (playerState.players.length < 2) return;
  playerSetupModal.style.display = 'none';
  showSpinScreen(() => {
    if (playerSetupModal._onSkip) playerSetupModal._onSkip();
  });
});

// ── Wheel colours ──────────────────────────────
const WHEEL_COLORS = ['#ECAA27', '#680707'];
const WHEEL_TEXT_COLORS = ['#000000', '#ffffff'];

// ── Audio ──────────────────────────────────────
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function playTick() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = 1200;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.022);
    osc.start(now); osc.stop(now + 0.03);
  } catch (_) {}
}

function playWinSound() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    function tone(freq, startAt, dur) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(0.3, startAt + 0.01);
      gain.gain.linearRampToValueAtTime(0, startAt + dur);
      osc.start(startAt); osc.stop(startAt + dur + 0.01);
    }
    const now = ctx.currentTime;
    tone(440, now, 0.08); tone(880, now + 0.09, 0.08);
  } catch (_) {}
}

// ── Pointer bounce on tick ─────────────────────
const spinPointerEl = document.getElementById('spin-pointer');
function bouncePointer() {
  if (!spinPointerEl) return;
  spinPointerEl.classList.remove('tick');
  void spinPointerEl.offsetWidth; // force reflow to restart transition
  spinPointerEl.classList.add('tick');
  setTimeout(() => spinPointerEl.classList.remove('tick'), 120);
}

// ── Responsive canvas sizing ───────────────────
function getWheelSize() {
  const byWidth  = Math.min(window.innerWidth - 32, 620) * 0.88;
  const byHeight = window.innerHeight * 0.46;
  return Math.max(300, Math.min(500, Math.floor(Math.min(byWidth, byHeight))));
}

// ── Spin Screen ────────────────────────────────
function showSpinScreen(onComplete) {
  showScreen('spin');
  const panel = document.getElementById('spin-result');
  panel.style.display = 'none';
  panel.classList.remove('visible');
  const spinBtn = document.getElementById('spin-btn');
  spinBtn.disabled = false;
  const canvas = document.getElementById('spin-canvas');
  canvas.classList.remove('spinning');
  const size = getWheelSize();
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  drawWheel(canvas, playerState.players, 0);
  spinBtn.onclick = () => {
    try { getAudioCtx(); } catch (_) {}
    doSpin(canvas, playerState.players, (winner) => {
      playerState.currentPicker = winner;
      playerState.lastPicked = winner;
      revealSpinWinner(winner, onComplete);
    });
  };
}

// ── Draw wheel (highlightIdx = -1 → no highlight) ─
function drawWheel(canvas, players, rotationAngle, highlightIdx) {
  if (highlightIdx === undefined) highlightIdx = -1;
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.offsetWidth || 320;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  const cx = size / 2, cy = size / 2, r = size / 2 - 4;
  const n = players.length;
  const arc = (Math.PI * 2) / n;
  players.forEach((name, i) => {
    const startAngle = rotationAngle + i * arc - Math.PI / 2;
    const endAngle = startAngle + arc;
    const midAngle = startAngle + arc / 2;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, endAngle); ctx.closePath();
    ctx.fillStyle = (i === highlightIdx) ? '#fff5cc' : WHEEL_COLORS[i % 2];
    ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, endAngle); ctx.closePath();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(midAngle);
    ctx.fillStyle = (i === highlightIdx) ? '#000' : WHEEL_TEXT_COLORS[i % 2];
    const fontSize = Math.max(10, Math.min(16, Math.floor(r * 0.22)));
    ctx.font = '700 ' + fontSize + "px 'Space Mono', monospace";
    ctx.textAlign = 'center';
    const displayName = name.length > 9 ? name.slice(0, 8) + '…' : name;
    ctx.fillText(displayName, r * 0.65, fontSize * 0.35);
    ctx.restore();
  });
  ctx.beginPath(); ctx.arc(cx, cy, 14, 0, Math.PI * 2);
  ctx.fillStyle = '#000'; ctx.fill();
  ctx.strokeStyle = '#ECAA27'; ctx.lineWidth = 2; ctx.stroke();
}

// ── Spin animation ─────────────────────────────
function doSpin(canvas, players, onDone) {
  document.getElementById('spin-btn').disabled = true;
  canvas.classList.add('spinning');
  const n = players.length;
  const arc = (Math.PI * 2) / n;
  const totalAngle = (5 + Math.random() * 4) * Math.PI * 2;
  const duration = 3500 + Math.random() * 1000;
  let startTime = null, currentAngle = 0, lastTickSeg = -1;

  // Slow start → ramp up → quintic deceleration
  function wheelEase(t) {
    if (t < 0.2) return 7.5 * t * t;
    const u = (t - 0.2) / 0.8;
    return 0.3 + 0.7 * (1 - Math.pow(1 - u, 5));
  }

  function animate(ts) {
    if (!startTime) startTime = ts;
    const t = Math.min((ts - startTime) / duration, 1);
    currentAngle = wheelEase(t) * totalAngle;
    drawWheel(canvas, players, currentAngle);

    // Tick on segment boundary cross
    const normalized = ((-currentAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const seg = Math.floor(normalized / arc) % n;
    if (lastTickSeg !== -1 && seg !== lastTickSeg) {
      playTick();
      bouncePointer();
    }
    lastTickSeg = seg;

    if (t < 1) { requestAnimationFrame(animate); return; }

    // Short settle bounce
    const bounceAmt = arc * 0.06;
    const bounceStart = performance.now();
    function bounce(ts2) {
      const bt = Math.min((ts2 - bounceStart) / 200, 1);
      drawWheel(canvas, players, currentAngle + Math.sin(bt * Math.PI) * bounceAmt);
      if (bt < 1) { requestAnimationFrame(bounce); return; }
      drawWheel(canvas, players, currentAngle);
      canvas.classList.remove('spinning');
      const finalNorm = ((-currentAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const segIndex = Math.floor(finalNorm / arc) % n;
      // Flash winning segment
      drawWheel(canvas, players, currentAngle, segIndex);
      setTimeout(() => {
        drawWheel(canvas, players, currentAngle);
        playWinSound();
        onDone(players[segIndex]);
      }, 220);
    }
    requestAnimationFrame(bounce);
  }
  requestAnimationFrame(animate);
}

// ── Winner reveal — slide panel up ────────────
function revealSpinWinner(name, onComplete) {
  const panel = document.getElementById('spin-result');
  document.getElementById('spin-result-name').textContent = name.toUpperCase();
  panel.style.display = 'flex';
  setTimeout(() => panel.classList.add('visible'), 40);
  document.getElementById('spin-continue-btn').onclick = () => {
    panel.classList.remove('visible');
    setTimeout(() => { panel.style.display = 'none'; onComplete(); }, 420);
  };
}

// ── Mini spin ──────────────────────────────────
function runMiniSpin() {
  const allPlayers = playerState.players;
  if (allPlayers.length < 2) return;
  let active = allPlayers.filter(p => p !== playerState.lastPicked);
  if (active.length === 0) active = allPlayers.slice();
  if (active.length === 1) {
    playerState.currentPicker = active[0];
    playerState.lastPicked = active[0];
    showPlayerBanner(active[0]);
    return;
  }
  const modal = document.getElementById('mini-spin-modal');
  const canvas = document.getElementById('mini-spin-canvas');
  const result = document.getElementById('mini-spin-result');
  modal.style.display = 'flex';
  canvas.style.display = 'block';
  result.style.display = 'none';
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 200 * dpr; canvas.height = 200 * dpr;
  canvas.style.width = '200px'; canvas.style.height = '200px';
  drawMiniWheel(canvas, active, 0);
  setTimeout(() => {
    doMiniSpin(canvas, active, (winner) => {
      playerState.currentPicker = winner;
      playerState.lastPicked = winner;
      canvas.style.display = 'none';
      result.textContent = winner.toUpperCase();
      result.style.display = 'block';
      setTimeout(() => {
        modal.style.display = 'none';
        canvas.style.display = 'block';
        result.style.display = 'none';
        showPlayerBanner(winner);
      }, 1100);
    });
  }, 200);
}

function drawMiniWheel(canvas, players, rotationAngle) {
  const dpr = window.devicePixelRatio || 1;
  const size = 200;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save(); ctx.scale(dpr, dpr);
  const cx = size / 2, cy = size / 2, r = size / 2 - 3;
  const n = players.length;
  const arc = (Math.PI * 2) / n;
  players.forEach((name, i) => {
    const startAngle = rotationAngle + i * arc - Math.PI / 2;
    const endAngle = startAngle + arc;
    const midAngle = startAngle + arc / 2;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, endAngle); ctx.closePath();
    ctx.fillStyle = WHEEL_COLORS[i % 2]; ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(midAngle);
    ctx.fillStyle = WHEEL_TEXT_COLORS[i % 2];
    const fontSize = Math.max(8, Math.min(13, Math.floor(r * 0.22)));
    ctx.font = '700 ' + fontSize + "px 'Space Mono', monospace";
    ctx.textAlign = 'center';
    const displayName = name.length > 7 ? name.slice(0, 6) + '…' : name;
    ctx.fillText(displayName, r * 0.55, fontSize * 0.35);
    ctx.restore();
  });
  ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2);
  ctx.fillStyle = '#000'; ctx.fill();
  ctx.strokeStyle = '#ECAA27'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}

function doMiniSpin(canvas, players, onDone) {
  const n = players.length;
  const arc = (Math.PI * 2) / n;
  const totalAngle = (2 + Math.random() * 2) * Math.PI * 2 + Math.random() * Math.PI * 2;
  let startTime = null, currentAngle = 0;
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function animate(ts) {
    if (!startTime) startTime = ts;
    const t = Math.min((ts - startTime) / 1000, 1);
    currentAngle = easeOut(t) * totalAngle;
    drawMiniWheel(canvas, players, currentAngle);
    if (t < 1) { requestAnimationFrame(animate); return; }
    const normalized = ((-currentAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const segIndex = Math.floor(normalized / arc) % n;
    onDone(players[segIndex]);
  }
  requestAnimationFrame(animate);
}

function showPlayerBanner(name) {
  const banner = document.getElementById('player-turn-banner');
  const text = document.getElementById('player-turn-text');
  text.textContent = '🎯 ' + name + "'s turn";
  banner.style.display = 'flex';
}

document.getElementById('back-to-relation').addEventListener('click', () => { resetPlayerState(); }, true);
document.getElementById('done-restart').addEventListener('click', () => { resetPlayerState(); }, true);
