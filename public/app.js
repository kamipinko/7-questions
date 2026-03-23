const screens = {
  relation: document.getElementById('screen-relation'),
  question: document.getElementById('screen-question'),
  done:     document.getElementById('screen-done'),
};

const TIER_NAMES = { 1: 'Casual', 2: 'Deeper', 3: 'Intimate' };
const TIER_ICONS = { 1: '🌱', 2: '🔥', 3: '💫' };
const RELATION_LABELS = {
  family: '👨‍👩‍👧 Family',
  friends: '👥 Friends',
  date: '💕 Date',
  spicy: '🌶️ Spicy',
};

// Temperature thresholds
const LINGER_SECS     = 120; // 2 min = lingering (deep convo)
const RUSH_SECS       = 30;  // under 30s = rushing (not warmed up)
const STREAK_TO_PROMPT = 2;  // consecutive lingers before offering advance
const MAX_PER_ROUND   = 4;   // max questions before forcing the prompt

let state = {
  relation: null,
  tier: 1,
  questions: [],    // all shuffled questions for current tier
  tierIndex: 0,     // position in questions array
  roundCount: 0,    // questions answered (not skipped) since last prompt
  lingerStreak: 0,  // consecutive lingered questions
  questionStartTime: null,
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

// --- Relation Selection (always starts at Casual) ---
document.querySelectorAll('.relation-card').forEach(btn => {
  btn.addEventListener('click', () => {
    state.relation = btn.dataset.relation;
    startGame();
  });
});

const spicyBtn = document.querySelector('.spicy-btn');
spicyBtn.addEventListener('click', () => {
  state.relation = 'spicy';
  spicyBtn.classList.add('tapped');
  spicyBtn.addEventListener('animationend', () => {
    spicyBtn.classList.remove('tapped');
    ageGate.style.display = 'flex';
  }, { once: true });
});

// --- Banner / Back → home ---
document.querySelector('.site-banner').addEventListener('click', goHome);
document.getElementById('back-to-relation').addEventListener('click', goHome);

function goHome() {
  state.relation = null;
  showScreen('relation');
}

// --- Start game (always tier 1) ---
async function startGame() {
  state.tier = 1;
  state.questions = [];
  state.tierIndex = 0;
  state.roundCount = 0;
  state.lingerStreak = 0;
  state.questionStartTime = null;
  resetDoneScreen();
  await loadTier();
  showQuestion();
  showScreen('question');
}

function resetDoneScreen() {
  document.getElementById('email-form').style.display = '';
  document.getElementById('email-skip').style.display = '';
  document.getElementById('email-thanks').style.display = 'none';
  document.getElementById('email-input').value = '';
}

// --- Load all questions for current tier (server shuffles them) ---
async function loadTier() {
  const res = await fetch(`/api/questions?relation=${state.relation}&tier=${state.tier}`);
  state.questions = await res.json();
  state.tierIndex = 0;
  state.roundCount = 0;
  state.lingerStreak = 0;
}

// --- Render current question and start timer ---
function showQuestion() {
  const q = state.questions[state.tierIndex];
  document.getElementById('question-text').textContent = q.text;

  const relBadge = document.getElementById('relation-badge');
  relBadge.textContent = RELATION_LABELS[state.relation];
  relBadge.className = `badge ${state.relation}`;

  const tierBadge = document.getElementById('tier-badge');
  tierBadge.textContent = `${TIER_ICONS[state.tier]} ${TIER_NAMES[state.tier]}`;
  tierBadge.className = `badge tier${state.tier}`;

  state.questionStartTime = Date.now();
}

// --- Next: measure time and update temperature ---
document.getElementById('btn-next').addEventListener('click', () => {
  const elapsed = (Date.now() - state.questionStartTime) / 1000;

  if (elapsed >= LINGER_SECS) {
    state.lingerStreak++;          // long convo → warmer
  } else if (elapsed < RUSH_SECS) {
    state.lingerStreak = 0;        // rushed → reset streak
  }
  // 30–120s neutral zone: no change

  state.roundCount++;
  state.tierIndex++;
  checkAndAdvance(false);
});

// --- Skip: kills the linger streak, no prompt trigger ---
document.getElementById('btn-skip').addEventListener('click', () => {
  state.lingerStreak = 0;  // skip resets streak — they're not ready
  state.tierIndex++;
  // note: roundCount not incremented on skip
  checkAndAdvance(true);
});

function checkAndAdvance(isSkip) {
  const outOfQuestions = state.tierIndex >= state.questions.length;
  const warmEnough = !isSkip && (
    state.lingerStreak >= STREAK_TO_PROMPT ||
    state.roundCount >= MAX_PER_ROUND
  );

  if (outOfQuestions || warmEnough) {
    if (state.tier >= 3) {
      showScreen('done');
    } else {
      showDepthPrompt();
    }
  } else {
    showQuestion();
  }
}

// --- Depth Prompt ---
const depthPrompt = document.getElementById('depth-prompt');

function showDepthPrompt() {
  document.getElementById('depth-keep').textContent = `Keep it ${TIER_NAMES[state.tier]}`;
  document.getElementById('depth-advance').textContent = `Go to ${TIER_NAMES[state.tier + 1]}`;
  depthPrompt.style.display = 'flex';
}

document.getElementById('depth-keep').addEventListener('click', async () => {
  depthPrompt.style.display = 'none';
  if (state.tierIndex >= state.questions.length) {
    // Exhausted this tier's questions — reload (fresh shuffle from server)
    await loadTier();
  } else {
    // Still have questions — just reset counters and keep going
    state.roundCount = 0;
    state.lingerStreak = 0;
  }
  showQuestion();
});

document.getElementById('depth-advance').addEventListener('click', async () => {
  depthPrompt.style.display = 'none';
  state.tier++;
  await loadTier();
  showQuestion();
  // Stay on question screen — badge updates automatically in showQuestion
});

// --- Email capture ---
document.getElementById('email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email-input').value.trim();
  if (!email) return;

  try {
    await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  } catch (_) {}

  document.getElementById('email-form').style.display = 'none';
  document.getElementById('email-skip').style.display = 'none';
  const thanks = document.getElementById('email-thanks');
  thanks.textContent = "You're on the list ✓";
  thanks.style.display = 'block';
});

document.getElementById('email-skip').addEventListener('click', () => {
  document.getElementById('email-form').style.display = 'none';
  document.getElementById('email-skip').style.display = 'none';
  const thanks = document.getElementById('email-thanks');
  thanks.textContent = 'See you next time.';
  thanks.style.display = 'block';
});

document.getElementById('done-restart').addEventListener('click', () => {
  state.relation = null;
  showScreen('relation');
});
