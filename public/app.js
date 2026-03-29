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
  if (startModal._onConfirm) startModal._onConfirm();
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
    showScreen('done');
  }, 1500);
});

document.getElementById('pre-done-skip').addEventListener('click', () => {
  preDoneModal.style.display = 'none';
  resetPreDoneModal();
  showScreen('done');
});

function resetPreDoneModal() {
  document.getElementById('pre-done-email-form').style.display = '';
  document.getElementById('pre-done-skip').style.display = '';
  document.getElementById('pre-done-thanks').style.display = 'none';
  document.getElementById('pre-done-email-input').value = '';
}

// --- Done screen ---
document.getElementById('done-restart').addEventListener('click', () => {
  state.relation = null;
  showScreen('relation');
});

// --- Feedback ---
const feedbackModal = document.getElementById('feedback-modal');

document.getElementById('feedback-tab').addEventListener('click', () => {
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
      body: JSON.stringify({ message, email }),
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
