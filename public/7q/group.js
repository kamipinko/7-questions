// ═══════════════════════════════════════════════════════════════
// GROUP MODE — 7 Questions
// ═══════════════════════════════════════════════════════════════

// Register group screens with the existing showScreen map
Object.assign(screens, {
  'group-rules':          document.getElementById('screen-group-rules'),
  'group-lobby':          document.getElementById('screen-group-lobby'),
  'group-pair-intro':     document.getElementById('screen-group-pair-intro'),
  'group-question':       document.getElementById('screen-group-question'),
  'group-vote-intro':     document.getElementById('screen-group-vote-intro'),
  'group-vote-question':  document.getElementById('screen-group-vote-question'),
  'group-results':        document.getElementById('screen-group-results'),
});

// ── Persistent tracker (votes + wins across sessions) ──────────
let tracker = (function () {
  try {
    return JSON.parse(localStorage.getItem('7q_group_tracker') || 'null')
      || { players: {}, teams: {}, games: 0 };
  } catch { return { players: {}, teams: {}, games: 0 }; }
})();

function saveTracker() {
  localStorage.setItem('7q_group_tracker', JSON.stringify(tracker));
}

// ── Per-game state ──────────────────────────────────────────────
let gState = {
  timerMinutes: 15,
  pairs: [],            // [{ id, name, p1, p2 }]
  allPrivateQs: [],     // all group_private questions (from server)
  allVoteQs: [],        // all group_vote questions (from server)
  currentPairIdx: 0,
  pairQs: {},           // pairId → question array (7)
  pairAnswered: {},     // pairId → count
  voteQs: [],           // 7 questions for this game's voting round
  voteQIdx: 0,
  voteStage: 'answer',  // 'answer' | 'vote' | 'tally'
  voters: [],           // [{ name, pairId }] — all players
  voterIdx: 0,
  votesThisQ: {},       // pairId → votes this question
  totalVotes: {},       // pairId → cumulative votes
  timerInterval: null,
  timerEnd: null,
  gameNum: 1,
  _gQIdx: 0,            // current question index within pair turn
};

let pairCounter = 0;

// ── Group card → rules screen ───────────────────────────────────
document.getElementById('group-card').addEventListener('click', () => {
  showScreen('group-rules');
  updateTrackerPill();
});

// ── Rules screen ────────────────────────────────────────────────
document.querySelectorAll('.timer-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.timer-opt').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    gState.timerMinutes = parseInt(btn.dataset.min);
  });
});

document.getElementById('rules-next-btn').addEventListener('click', () => {
  if (gState.pairs.length === 0) initDefaultPairs();
  showScreen('group-lobby');
  renderPairsList();
});

document.getElementById('rules-back').addEventListener('click', () => {
  showScreen('relation');
});

// ── Lobby screen ────────────────────────────────────────────────
function initDefaultPairs() {
  gState.pairs = [
    { id: pairCounter++, name: '', p1: '', p2: '' },
    { id: pairCounter++, name: '', p1: '', p2: '' },
  ];
}

function renderPairsList() {
  const list = document.getElementById('pairs-list');
  list.innerHTML = '';

  gState.pairs.forEach((pair, idx) => {
    const card = document.createElement('div');
    card.className = 'pair-card';
    card.innerHTML = `
      <div class="pair-card-header">
        <span class="pair-num">Team ${idx + 1}</span>
        ${gState.pairs.length > 2
          ? `<button class="pair-remove-btn" data-idx="${idx}">✕</button>`
          : ''}
      </div>
      <input class="pair-input" type="text" placeholder="Team name (optional)"
             value="${pair.name}" data-field="name" data-idx="${idx}" />
      <div class="pair-players">
        <input class="pair-input" type="text" placeholder="Player 1 name"
               value="${pair.p1}" data-field="p1" data-idx="${idx}" />
        <input class="pair-input" type="text" placeholder="Player 2 name"
               value="${pair.p2}" data-field="p2" data-idx="${idx}" />
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('.pair-input').forEach(input => {
    input.addEventListener('input', () => {
      const idx = parseInt(input.dataset.idx);
      gState.pairs[idx][input.dataset.field] = input.value.trim();
      validateLobby();
    });
  });

  list.querySelectorAll('.pair-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      gState.pairs.splice(parseInt(btn.dataset.idx), 1);
      renderPairsList();
    });
  });

  validateLobby();
}

function validateLobby() {
  const valid = gState.pairs.length >= 2
    && gState.pairs.every(p => p.p1.trim() && p.p2.trim());
  document.getElementById('begin-game-btn').disabled = !valid;
}

document.getElementById('add-pair-btn').addEventListener('click', () => {
  if (gState.pairs.length >= 8) return;
  gState.pairs.push({ id: pairCounter++, name: '', p1: '', p2: '' });
  renderPairsList();
});

document.getElementById('lobby-back').addEventListener('click', () => {
  showScreen('group-rules');
});

document.getElementById('begin-game-btn').addEventListener('click', async () => {
  // Assign default team names
  gState.pairs.forEach((p, i) => { if (!p.name) p.name = `Team ${i + 1}`; });

  // Reset per-game counters
  gState.totalVotes = {};
  gState.pairQs = {};
  gState.pairAnswered = {};
  gState.voters = [];
  gState.currentPairIdx = 0;

  gState.pairs.forEach(p => {
    gState.totalVotes[p.id] = 0;
    gState.pairAnswered[p.id] = 0;
    gState.voters.push({ name: p.p1, pairId: p.id });
    gState.voters.push({ name: p.p2, pairId: p.id });
  });

  // Fetch questions
  document.getElementById('begin-game-btn').textContent = 'Loading…';
  document.getElementById('begin-game-btn').disabled = true;
  try {
    const [pvtRes, voteRes] = await Promise.all([
      fetch('/api/questions?relation=group_private&tier=1'),
      fetch('/api/questions?relation=group_vote&tier=1'),
    ]);
    gState.allPrivateQs = await pvtRes.json();
    gState.allVoteQs = await voteRes.json();
  } catch (err) {
    console.error('Failed to load group questions', err);
    document.getElementById('begin-game-btn').textContent = 'Begin the Game →';
    document.getElementById('begin-game-btn').disabled = false;
    return;
  }

  // Assign 7 questions per pair (different shuffle each pair)
  gState.pairs.forEach(pair => {
    gState.pairQs[pair.id] = [...gState.allPrivateQs]
      .sort(() => Math.random() - 0.5)
      .slice(0, 7);
  });
  gState.voteQs = [...gState.allVoteQs].sort(() => Math.random() - 0.5).slice(0, 7);

  document.getElementById('begin-game-btn').textContent = 'Begin the Game →';
  showTrackerPill();
  startPairTurn(0);
});

// ── Pair turn ───────────────────────────────────────────────────
function startPairTurn(idx) {
  gState.currentPairIdx = idx;
  const pair = gState.pairs[idx];
  gState.pairAnswered[pair.id] = 0;
  gState._gQIdx = 0;

  document.getElementById('pair-intro-name').textContent = pair.name;
  document.getElementById('pair-intro-players').innerHTML = `
    <span class="player-chip">${pair.p1}</span>
    <span class="player-chip-divider">+</span>
    <span class="player-chip">${pair.p2}</span>
  `;
  document.getElementById('pair-intro-timer').textContent =
    `${gState.timerMinutes} minutes on the clock`;

  showScreen('group-pair-intro');
}

document.getElementById('pair-ready-btn').addEventListener('click', () => {
  const pair = gState.pairs[gState.currentPairIdx];
  renderGroupQuestion(pair, 0);
  startPairTimer();
  showScreen('group-question');
});

// ── Group question rendering ────────────────────────────────────
function renderGroupQuestion(pair, qIdx) {
  const q = gState.pairQs[pair.id][qIdx];
  const text = q.text
    .replace(/\{p1\}/g, pair.p1)
    .replace(/\{p2\}/g, pair.p2);

  document.getElementById('group-question-text').textContent = text;
  document.getElementById('group-pair-badge').textContent = pair.name;
  document.getElementById('group-q-counter').textContent = `${qIdx + 1} / 7`;
  gState._gQIdx = qIdx;
}

document.getElementById('group-btn-next').addEventListener('click', advanceGroupQ);
document.getElementById('group-btn-skip').addEventListener('click', advanceGroupQ);

function advanceGroupQ() {
  const pair = gState.pairs[gState.currentPairIdx];
  gState.pairAnswered[pair.id]++;
  const next = gState._gQIdx + 1;

  if (next >= 7 || gState.pairAnswered[pair.id] >= 7) {
    endPairTurn();
  } else {
    renderGroupQuestion(pair, next);
  }
}

document.getElementById('group-q-back').addEventListener('click', () => {
  if (!confirm('Leave the game? All progress will be lost.')) return;
  clearInterval(gState.timerInterval);
  hideTrackerPill();
  gState.pairs = [];
  gState.gameNum = 1;
  showScreen('relation');
});

// ── Timer ───────────────────────────────────────────────────────
function startPairTimer() {
  clearInterval(gState.timerInterval);
  gState.timerEnd = Date.now() + gState.timerMinutes * 60 * 1000;
  gState.timerInterval = setInterval(tickTimer, 500);
  tickTimer();
}

function tickTimer() {
  const remaining = Math.max(0, gState.timerEnd - Date.now());
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const display = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const el = document.getElementById('group-timer-display');
  if (el) {
    el.textContent = display;
    el.classList.toggle('warning', remaining > 0 && remaining < 60000);
  }
  if (remaining <= 0) {
    clearInterval(gState.timerInterval);
    endPairTurn(true);
  }
}

// ── End pair turn ───────────────────────────────────────────────
function endPairTurn(timedOut = false) {
  clearInterval(gState.timerInterval);
  const next = gState.currentPairIdx + 1;
  if (next < gState.pairs.length) {
    startPairTurn(next);
  } else {
    startVotingPhase();
  }
}

// ── Voting phase ────────────────────────────────────────────────
function startVotingPhase() {
  gState.voteQIdx = 0;

  const preview = document.getElementById('vote-teams-preview');
  preview.innerHTML = gState.pairs
    .map(p => `<div class="vote-team-pill">${p.name}</div>`)
    .join('');

  showScreen('group-vote-intro');
}

document.getElementById('start-voting-btn').addEventListener('click', () => {
  showVoteQuestion(0);
});

function showVoteQuestion(idx) {
  gState.voteQIdx = idx;
  gState.voteStage = 'answer';
  gState.voterIdx = 0;
  gState.votesThisQ = {};
  gState.pairs.forEach(p => { gState.votesThisQ[p.id] = 0; });

  const q = gState.voteQs[idx];
  document.getElementById('vote-question-text').textContent = q.text;
  document.getElementById('vote-q-counter').textContent = `${idx + 1} of 7`;

  renderVoteAnswer();
  showScreen('group-vote-question');
}

function renderVoteAnswer() {
  const area = document.getElementById('vote-stage-area');
  area.innerHTML = `
    <p class="vote-stage-label">Have each team answer this question out loud to the group, then tap when everyone has answered.</p>
    <button class="g-primary-btn" id="vote-ready-btn" style="max-width:280px;">Everyone Has Answered →</button>
  `;
  document.getElementById('vote-ready-btn').addEventListener('click', () => {
    gState.voterIdx = 0;
    renderVoteVoter();
  });
}

function renderVoteVoter() {
  const area = document.getElementById('vote-stage-area');
  const voter = gState.voters[gState.voterIdx];
  const otherPairs = gState.pairs.filter(p => p.id !== voter.pairId);

  area.innerHTML = `
    <p class="vote-voter-label">Pass to <strong>${voter.name}</strong></p>
    <p class="vote-voter-sub">Who gave the most interesting answer?</p>
    <div class="vote-team-options">
      ${otherPairs.map(p =>
        `<button class="vote-team-btn" data-pair-id="${p.id}">${p.name}</button>`
      ).join('')}
    </div>
    <p class="vote-voter-count">${gState.voterIdx + 1} of ${gState.voters.length} voters</p>
  `;

  area.querySelectorAll('.vote-team-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid = parseInt(btn.dataset.pairId);
      gState.votesThisQ[pid] = (gState.votesThisQ[pid] || 0) + 1;
      gState.totalVotes[pid] = (gState.totalVotes[pid] || 0) + 1;

      area.innerHTML = `
        <div class="vote-submitted">
          ✓ Vote cast!
          <span class="vote-submitted-name">Pass the phone to the next player.</span>
        </div>
      `;

      setTimeout(() => {
        gState.voterIdx++;
        if (gState.voterIdx >= gState.voters.length) {
          renderVoteTally();
        } else {
          renderVoteVoter();
        }
      }, 1200);
    });
  });
}

function renderVoteTally() {
  const area = document.getElementById('vote-stage-area');
  const isLast = gState.voteQIdx >= 6;
  const maxVotes = gState.voters.length;

  const sorted = [...gState.pairs]
    .map(p => ({ name: p.name, votes: gState.votesThisQ[p.id] || 0 }))
    .sort((a, b) => b.votes - a.votes);

  area.innerHTML = `
    <div class="vote-tally">
      <p class="vote-tally-title">This question</p>
      ${sorted.map(r => `
        <div class="vote-tally-row">
          <span class="vote-tally-name">${r.name}</span>
          <div class="vote-tally-bar-wrap">
            <div class="vote-tally-bar" style="width:${maxVotes > 0 ? Math.round((r.votes / maxVotes) * 100) : 0}%"></div>
          </div>
          <span class="vote-tally-count">${r.votes}</span>
        </div>
      `).join('')}
    </div>
    <button class="g-primary-btn" id="vote-next-btn" style="max-width:280px;">
      ${isLast ? 'See Final Results →' : 'Next Question →'}
    </button>
  `;

  document.getElementById('vote-next-btn').addEventListener('click', () => {
    if (isLast) {
      showResults();
    } else {
      showVoteQuestion(gState.voteQIdx + 1);
    }
  });
}

// ── Results ─────────────────────────────────────────────────────
function showResults() {
  tracker.games = (tracker.games || 0) + 1;

  const sorted = [...gState.pairs].sort(
    (a, b) => (gState.totalVotes[b.id] || 0) - (gState.totalVotes[a.id] || 0)
  );
  const winner = sorted[0];
  const topVotes = gState.totalVotes[winner.id] || 0;

  // Update tracker
  gState.pairs.forEach(p => {
    const pVotes = gState.totalVotes[p.id] || 0;
    [p.p1, p.p2].forEach(name => {
      if (!tracker.players[name]) tracker.players[name] = { votes: 0, wins: 0, games: 0 };
      tracker.players[name].votes += Math.round(pVotes / 2);
      tracker.players[name].games++;
    });
    if (!tracker.teams[p.name]) tracker.teams[p.name] = { wins: 0, games: 0, votes: 0 };
    tracker.teams[p.name].votes = (tracker.teams[p.name].votes || 0) + pVotes;
    tracker.teams[p.name].games++;
  });
  if (topVotes > 0) {
    [winner.p1, winner.p2].forEach(n => {
      if (tracker.players[n]) tracker.players[n].wins++;
    });
    tracker.teams[winner.name].wins++;
  }
  saveTracker();

  // Render leaderboard
  document.getElementById('results-title').textContent =
    topVotes > 0 ? `${winner.name} Wins! 🏆` : "It's a Tie!";
  document.getElementById('results-subtitle').textContent =
    topVotes > 0
      ? `${winner.p1} & ${winner.p2} collected the most votes this game.`
      : 'Everyone brought something worth hearing.';

  document.getElementById('results-leaderboard').innerHTML = sorted.map((p, i) => `
    <div class="leaderboard-row ${i === 0 && topVotes > 0 ? 'leader' : ''}">
      <span class="lb-rank">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}</span>
      <div class="lb-team">
        <span class="lb-name">${p.name}</span>
        <span class="lb-players">${p.p1} & ${p.p2}</span>
      </div>
      <span class="lb-votes">${gState.totalVotes[p.id] || 0} <small>votes</small></span>
    </div>
  `).join('');

  updateTrackerPill();
  showScreen('group-results');

  // Show post-game prompt after a short delay
  setTimeout(() => {
    document.getElementById('modal-postgame').style.display = 'flex';
  }, 1800);
}

// ── Post-game modal ──────────────────────────────────────────────
document.getElementById('postgame-feedback-btn').addEventListener('click', () => {
  document.getElementById('modal-postgame').style.display = 'none';
  document.getElementById('feedback-modal').style.display = 'flex';
});

document.getElementById('postgame-skip').addEventListener('click', () => {
  document.getElementById('modal-postgame').style.display = 'none';
});

// ── Play again / Done ────────────────────────────────────────────
document.getElementById('play-again-btn').addEventListener('click', () => {
  document.getElementById('modal-continue').style.display = 'flex';
});

document.getElementById('results-done-btn').addEventListener('click', endGroupSession);

document.getElementById('continue-same-teams').addEventListener('click', () => {
  document.getElementById('modal-continue').style.display = 'none';
  gState.gameNum++;
  resetForNextGame(false);
});

document.getElementById('continue-new-teams').addEventListener('click', () => {
  document.getElementById('modal-continue').style.display = 'none';
  gState.gameNum++;
  gState.pairs = [];
  pairCounter = 0;
  initDefaultPairs();
  showScreen('group-lobby');
  renderPairsList();
});

document.getElementById('continue-done').addEventListener('click', () => {
  document.getElementById('modal-continue').style.display = 'none';
  endGroupSession();
});

function resetForNextGame(newTeams) {
  gState.totalVotes = {};
  gState.pairAnswered = {};
  gState.voters = [];
  gState.currentPairIdx = 0;

  gState.pairs.forEach(p => {
    gState.totalVotes[p.id] = 0;
    gState.pairAnswered[p.id] = 0;
    gState.voters.push({ name: p.p1, pairId: p.id });
    gState.voters.push({ name: p.p2, pairId: p.id });
    gState.pairQs[p.id] = [...gState.allPrivateQs]
      .sort(() => Math.random() - 0.5)
      .slice(0, 7);
  });
  gState.voteQs = [...gState.allVoteQs].sort(() => Math.random() - 0.5).slice(0, 7);

  startPairTurn(0);
}

function endGroupSession() {
  clearInterval(gState.timerInterval);
  hideTrackerPill();
  gState.pairs = [];
  gState.gameNum = 1;
  pairCounter = 0;
  showScreen('relation');
}

// ── Tracker pill ─────────────────────────────────────────────────
function showTrackerPill() {
  const pill = document.getElementById('group-tracker-pill');
  if (pill) pill.style.display = 'flex';
  updateTrackerPill();
}

function hideTrackerPill() {
  const pill = document.getElementById('group-tracker-pill');
  if (pill) pill.style.display = 'none';
}

function updateTrackerPill() {
  const el = document.getElementById('group-tracker-text');
  if (!el) return;
  const top = getTopPlayer();
  el.textContent = top
    ? `👑 ${top.name} · ${top.votes}v`
    : `Game ${gState.gameNum}`;
}

function getTopPlayer() {
  const entries = Object.entries(tracker.players);
  if (!entries.length) return null;
  const [name, stats] = entries.sort((a, b) => b[1].votes - a[1].votes)[0];
  return { name, votes: stats.votes, wins: stats.wins };
}

document.getElementById('group-tracker-pill').addEventListener('click', () => {
  renderTrackerModal();
  document.getElementById('modal-tracker').style.display = 'flex';
});

function renderTrackerModal() {
  const entries = Object.entries(tracker.players)
    .sort((a, b) => b[1].votes - a[1].votes)
    .slice(0, 8);

  const content = document.getElementById('tracker-modal-content');
  if (!entries.length) {
    content.innerHTML = '<p class="tracker-empty">No games tracked yet. Play a full game to see scores here.</p>';
    return;
  }

  content.innerHTML = `
    <div class="tracker-list">
      ${entries.map(([name, s], i) => `
        <div class="tracker-row">
          <span class="tracker-rank">${i === 0 ? '👑' : `${i + 1}.`}</span>
          <span class="tracker-name">${name}</span>
          <span class="tracker-stats">${s.votes} votes · ${s.wins} wins · ${s.games} games</span>
        </div>
      `).join('')}
    </div>
    <div style="margin-top:1rem;text-align:center;">
      <button class="skip-link" id="tracker-reset-btn">Reset tracker</button>
    </div>
  `;

  document.getElementById('tracker-reset-btn').addEventListener('click', () => {
    if (!confirm('Reset all tracking data? This cannot be undone.')) return;
    tracker = { players: {}, teams: {}, games: 0 };
    saveTracker();
    renderTrackerModal();
    updateTrackerPill();
  });
}

document.getElementById('tracker-modal-close').addEventListener('click', () => {
  document.getElementById('modal-tracker').style.display = 'none';
});
