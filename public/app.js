const screens = {
  relation: document.getElementById('screen-relation'),
  tier: document.getElementById('screen-tier'),
  question: document.getElementById('screen-question'),
};

let state = {
  relation: null,
  tier: null,
  questions: [],
  index: 0,
};

const relationLabels = { family: '👨‍👩‍👧 Family', friends: '👥 Friends', date: '💕 Date', spicy: '🌶️ Spicy' };
const tierLabels = { 1: '🌱 Casual', 2: '🔥 Deeper', 3: '💫 Intimate' };

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// Age gate
const ageGate = document.getElementById('age-gate');
document.getElementById('age-gate-confirm').addEventListener('click', () => {
  ageGate.style.display = 'none';
  showScreen('tier');
});
document.getElementById('age-gate-cancel').addEventListener('click', () => {
  ageGate.style.display = 'none';
  state.relation = null;
});

// Step 1: Pick relation
document.querySelectorAll('.relation-card').forEach(btn => {
  btn.addEventListener('click', () => {
    state.relation = btn.dataset.relation;
    if (state.relation === 'spicy') {
      ageGate.style.display = 'flex';
    } else {
      showScreen('tier');
    }
  });
});

// Step 2: Pick tier
document.querySelectorAll('.tier-card').forEach(btn => {
  btn.addEventListener('click', async () => {
    state.tier = parseInt(btn.dataset.tier);
    await loadQuestions();
    renderQuestion();
    showScreen('question');
  });
});

// Back buttons
document.getElementById('back-to-relation').addEventListener('click', () => showScreen('relation'));
document.getElementById('back-to-tier').addEventListener('click', () => showScreen('tier'));

// Prev / Next
document.getElementById('btn-prev').addEventListener('click', () => {
  if (state.index > 0) {
    state.index--;
    renderQuestion();
  }
});
document.getElementById('btn-next').addEventListener('click', () => {
  if (state.index < state.questions.length - 1) {
    state.index++;
    renderQuestion();
  }
});

// Reshuffle
document.getElementById('btn-shuffle').addEventListener('click', async () => {
  await loadQuestions();
  renderQuestion();
});

async function loadQuestions() {
  const res = await fetch(`/api/questions?relation=${state.relation}&tier=${state.tier}`);
  state.questions = await res.json();
  state.index = 0;
}

function renderQuestion() {
  const q = state.questions[state.index];

  // Question text
  document.getElementById('question-text').textContent = q.text;

  // Counter
  document.getElementById('question-counter').textContent =
    `${state.index + 1} / ${state.questions.length}`;

  // Badges
  const relBadge = document.getElementById('relation-badge');
  relBadge.textContent = relationLabels[state.relation];
  relBadge.className = `badge ${state.relation}`;

  const tierBadge = document.getElementById('tier-badge');
  tierBadge.textContent = tierLabels[state.tier];
  tierBadge.className = `badge tier${state.tier}`;

  // Prev/Next button states
  document.getElementById('btn-prev').disabled = state.index === 0;
  document.getElementById('btn-next').disabled = state.index === state.questions.length - 1;
}
