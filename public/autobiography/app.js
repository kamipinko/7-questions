// ── IndexedDB Helpers (for storing voice recordings) ──
const DB_NAME = 'ab_recordings';
const DB_STORE = 'recordings';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function saveRecording(key, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(blob, key);
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

async function getRecording(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror = e => reject(e.target.error);
  });
}

async function deleteRecording(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

// ── Session Analytics ──
const SESSION_ID = sessionStorage.getItem('ab_session_id') || (() => {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem('ab_session_id', id);
  return id;
})();
let sessionStartTime = Date.now();
let sessionLogged = false;

function logSession(subjectName, relationship) {
  if (sessionLogged) return;
  sessionLogged = true;
  fetch('/api/log/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: SESSION_ID, subjectName, relationship, ua: navigator.userAgent })
  }).catch(() => {});
}

function pingSession(extras = {}) {
  const duration = Math.round((Date.now() - sessionStartTime) / 1000);
  fetch('/api/log/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: SESSION_ID, duration, ...extras })
  }).catch(() => {});
}

// Heartbeat every 30s
setInterval(() => pingSession(), 30000);
// Final ping on unload
window.addEventListener('beforeunload', () => pingSession());

// ── Prompts data ──
let PROMPTS = null;

// ── State ──
let state = {
  subject: { name: '', relationship: '', pronouns: 'he' },
  authorName: '',
  answers: {},
  narrative: null
};

const STORAGE_KEY = 'hys_state';

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) state = JSON.parse(saved);
  } catch {}
}

// ── Navigation ──
function showScreen(id) {
  stopAnyActiveRecording();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

// ── Applicable chapters for current relationship ──
function getChapters() {
  const rel = state.subject.relationship;
  return PROMPTS.chapters.filter(ch => {
    if (ch.relationships === 'all') return true;
    return ch.relationships.includes(rel);
  });
}

// ── Replace {name} placeholder ──
function q(text) {
  return text.replace(/{name}/g, state.subject.name || 'them');
}

// ── Count answered prompts in a chapter ──
function countAnswered(chapterId) {
  const chapter = PROMPTS.chapters.find(c => c.id === chapterId);
  if (!chapter) return 0;
  const answers = state.answers[chapterId] || {};
  return chapter.prompts.filter(p => answers[p.id] && answers[p.id].trim()).length;
}

// ── LANDING ──
function initLanding() {
  const beginBtn = document.getElementById('begin-btn');
  const subjectInput = document.getElementById('subject-name');
  const authorInput = document.getElementById('author-name');

  if (state.subject.name) subjectInput.value = state.subject.name;
  if (state.authorName) authorInput.value = state.authorName;
  if (state.subject.relationship) {
    document.querySelectorAll('.rel-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset.rel === state.subject.relationship);
    });
  }
  if (state.subject.pronouns) {
    document.querySelectorAll('.pronoun-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.pronoun === state.subject.pronouns);
    });
  }

  function checkReady() {
    const ready = state.subject.relationship && subjectInput.value.trim() && authorInput.value.trim();
    beginBtn.disabled = !ready;
  }

  document.querySelectorAll('.rel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rel-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.subject.relationship = btn.dataset.rel;
      saveState();
      checkReady();
    });
  });

  document.querySelectorAll('.pronoun-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pronoun-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.subject.pronouns = btn.dataset.pronoun;
      saveState();
    });
  });

  subjectInput.addEventListener('input', () => {
    state.subject.name = subjectInput.value.trim();
    saveState();
    checkReady();
  });

  authorInput.addEventListener('input', () => {
    state.authorName = authorInput.value.trim();
    saveState();
    checkReady();
  });

  beginBtn.addEventListener('click', () => {
    logSession(state.subject.name, state.subject.relationship);
    showScreen('screen-intro');
    renderIntro();
  });

  checkReady();
}

// ── INTRO ──
function renderIntro() {
  const chapters = getChapters();
  const name = state.subject.name;
  const author = state.authorName;

  const stepsHtml = [
    { icon: '📖', text: `Work through <strong>${chapters.length} chapters</strong> about ${name}'s life — from childhood all the way to the wisdom they carry today.` },
    { icon: '🎤', text: `For each question, choose to <strong>type your answer</strong> or tap <strong>Record Voice</strong> — AI transcribes the recording into text for the book, and the audio is saved so you can listen back anytime.` },
    { icon: '✦', text: `When you're done, tap <strong>Make the Book</strong> and your answers become a beautifully written memoir — ready to print as a book or share as an e-book.` },
    { icon: '✉', text: `At the end, enter an email address and we'll <strong>send you the full story</strong> plus all your original answers and voice recordings attached as audio files.` },
  ].map(s => `
    <li>
      <span class="intro-step-icon">${s.icon}</span>
      <span>${s.text}</span>
    </li>
  `).join('');

  const chapterListHtml = chapters.map(ch => `
    <li class="intro-chapter-item">
      <span class="intro-chapter-icon-sm">${ch.icon}</span>
      <span>${ch.title}</span>
    </li>
  `).join('');

  document.getElementById('intro-content').innerHTML = `
    <h2>Hi, ${author}!</h2>
    <p class="intro-lead">
      You're about to create ${name}'s life story — a memoir that can be printed, shared, and treasured for generations.
    </p>
    <ul class="intro-steps">
      ${stepsHtml}
    </ul>
    <div class="intro-chapters-preview">
      <p class="intro-chapters-label">Here are the ${chapters.length} chapters you'll explore with ${name}:</p>
      <ul class="intro-chapter-list">
        ${chapterListHtml}
      </ul>
    </div>
    <p class="intro-note">Your answers save automatically as you go. Take your time — this conversation is worth having.</p>
  `;
}

// ── CHAPTERS ──
function renderChapters() {
  const chapters = getChapters();
  document.getElementById('subject-display').textContent = state.subject.name;
  document.getElementById('chapters-total').textContent = chapters.length;

  const done = chapters.filter(ch => countAnswered(ch.id) > 0).length;
  document.getElementById('chapters-done').textContent = done;

  const grid = document.getElementById('chapter-grid');
  grid.innerHTML = chapters.map(ch => {
    const answered = countAnswered(ch.id);
    const total = ch.prompts.length;
    const isDone = answered > 0;
    const dots = ch.prompts.map((_, i) => {
      const filled = i < answered;
      return `<span class="progress-dot ${filled ? 'filled' : ''}"></span>`;
    }).join('');

    return `
      <div class="chapter-card ${isDone ? 'done' : ''}" data-chapter="${ch.id}">
        <div class="chapter-icon">${ch.icon}</div>
        <div class="chapter-card-title">${ch.title}</div>
        <div class="chapter-card-desc">${ch.description}</div>
        <div class="chapter-card-progress">
          ${dots}
          <span style="margin-left:4px">${answered > 0 ? `${answered}/${total} answered` : 'Not started'}</span>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.chapter-card').forEach(card => {
    card.addEventListener('click', () => openChapter(card.dataset.chapter));
  });
}

// ── PROMPTS ──
let currentChapterId = null;

function openChapter(chapterId) {
  currentChapterId = chapterId;
  const chapter = PROMPTS.chapters.find(c => c.id === chapterId);
  if (!chapter) return;

  document.getElementById('prompt-chapter-name').textContent = chapter.title;
  const answered = countAnswered(chapterId);
  document.getElementById('prompt-progress-label').textContent = `${answered}/${chapter.prompts.length}`;

  const savedAnswers = state.answers[chapterId] || {};

  const list = document.getElementById('prompts-list');
  list.innerHTML = chapter.prompts.map(prompt => `
    <div class="prompt-item">
      <label class="prompt-question">${q(prompt.question)}</label>
      <div class="prompt-mode-toggle">
        <button class="mode-btn mode-type active" data-mode="type">✍ Write</button>
        <button class="mode-btn mode-record" data-mode="record">🎤 Record voice</button>
      </div>
      <div class="write-panel">
        <textarea
          class="prompt-textarea"
          data-prompt-id="${prompt.id}"
          placeholder="${prompt.placeholder}"
          rows="4"
        >${savedAnswers[prompt.id] || ''}</textarea>
      </div>
      <div class="record-panel" style="display:none">
        <div class="recording-bar" data-chapter-id="${chapterId}" data-prompt-id="${prompt.id}">
          <button class="mic-btn">🎤 Tap to start recording</button>
          <div class="recording-active">
            <span class="rec-dot"></span>
            <span class="rec-timer">0:00</span>
            <button class="stop-rec-btn">⏹ Stop</button>
          </div>
          <div class="playback-controls">
            <button class="play-rec-btn">▶ Play recording</button>
            <button class="re-record-btn">↺ Re-record</button>
          </div>
          <span class="transcribing-label">Transcribing...</span>
        </div>
        <div class="transcribed-section" style="display:none">
          <p class="transcribed-label">✓ Transcribed from voice — you can edit this:</p>
          <textarea
            class="prompt-textarea transcribed-textarea"
            data-prompt-id="${prompt.id}"
            placeholder="Transcribed text will appear here..."
            rows="4"
          >${savedAnswers[prompt.id] || ''}</textarea>
        </div>
      </div>
    </div>
  `).join('');

  // Wire up text auto-save and auto-grow for all textareas
  list.querySelectorAll('.prompt-textarea').forEach(ta => {
    ta.addEventListener('input', () => {
      if (!state.answers[chapterId]) state.answers[chapterId] = {};
      state.answers[chapterId][ta.dataset.promptId] = ta.value;
      // Keep both textareas in the same prompt in sync
      const promptItem = ta.closest('.prompt-item');
      promptItem.querySelectorAll('.prompt-textarea').forEach(other => {
        if (other !== ta) other.value = ta.value;
      });
      saveState();
      const answered = countAnswered(chapterId);
      document.getElementById('prompt-progress-label').textContent = `${answered}/${chapter.prompts.length}`;
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    });
  });

  // Wire up mode toggle for each prompt
  list.querySelectorAll('.prompt-mode-toggle').forEach(toggle => {
    const promptItem = toggle.closest('.prompt-item');
    const writePanel = promptItem.querySelector('.write-panel');
    const recordPanel = promptItem.querySelector('.record-panel');

    toggle.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (btn.dataset.mode === 'record') {
          writePanel.style.display = 'none';
          recordPanel.style.display = '';
        } else {
          writePanel.style.display = '';
          recordPanel.style.display = 'none';
        }
      });
    });
  });

  // Wire up recording for each prompt
  list.querySelectorAll('.recording-bar').forEach(bar => {
    initRecordingBar(bar, chapterId);
  });

  showScreen('screen-prompts');
}

// ── VOICE RECORDING ──
let activeRecorder = null; // { mediaRecorder, timerInterval, chapterId, promptId }

function stopAnyActiveRecording() {
  if (activeRecorder) {
    try { activeRecorder.mediaRecorder.stop(); } catch {}
    clearInterval(activeRecorder.timerInterval);
    activeRecorder = null;
  }
}

function initRecordingBar(bar, chapterId) {
  const promptId = bar.dataset.promptId;
  const micBtn = bar.querySelector('.mic-btn');
  const recordingActive = bar.querySelector('.recording-active');
  const stopBtn = bar.querySelector('.stop-rec-btn');
  const playbackControls = bar.querySelector('.playback-controls');
  const playBtn = bar.querySelector('.play-rec-btn');
  const reRecordBtn = bar.querySelector('.re-record-btn');
  const transcribingLabel = bar.querySelector('.transcribing-label');
  const promptItem = bar.closest('.prompt-item');
  const writePanel = promptItem.querySelector('.write-panel');
  const recordPanel = promptItem.querySelector('.record-panel');
  const transcribedSection = promptItem.querySelector('.transcribed-section');
  const transcribedTextarea = promptItem.querySelector('.transcribed-textarea');
  // Primary textarea is in the write panel
  const textarea = promptItem.querySelector('.write-panel .prompt-textarea');

  const recKey = `${chapterId}_${promptId}`;

  function switchToRecordMode() {
    const toggle = promptItem.querySelector('.prompt-mode-toggle');
    toggle.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    toggle.querySelector('.mode-record').classList.add('active');
    writePanel.style.display = 'none';
    recordPanel.style.display = '';
  }

  // Check for existing recording — auto-switch to record mode if one exists
  getRecording(recKey).then(blob => {
    if (blob) {
      switchToRecordMode();
      if (textarea.value) {
        transcribedSection.style.display = '';
        transcribedTextarea.value = textarea.value;
      }
      showPlayback(blob);
    }
  });

  function showMic() {
    micBtn.style.display = '';
    recordingActive.style.display = 'none';
    playbackControls.style.display = 'none';
    transcribingLabel.style.display = 'none';
  }

  function showRecording() {
    micBtn.style.display = 'none';
    recordingActive.style.display = 'flex';
    playbackControls.style.display = 'none';
    transcribingLabel.style.display = 'none';
  }

  function showTranscribing() {
    micBtn.style.display = 'none';
    recordingActive.style.display = 'none';
    playbackControls.style.display = 'none';
    transcribingLabel.style.display = '';
  }

  function showPlayback(blob) {
    micBtn.style.display = 'none';
    recordingActive.style.display = 'none';
    playbackControls.style.display = 'flex';
    transcribingLabel.style.display = 'none';

    // Store the blob for play button
    playBtn._blob = blob;
  }

  // Play recording
  playBtn.addEventListener('click', () => {
    const blob = playBtn._blob;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play();
    audio.onended = () => URL.revokeObjectURL(url);
  });

  // Re-record
  reRecordBtn.addEventListener('click', async () => {
    await deleteRecording(recKey);
    transcribedSection.style.display = 'none';
    showMic();
  });

  // Start recording
  micBtn.addEventListener('click', async () => {
    stopAnyActiveRecording();

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      alert('Microphone access denied. Please allow microphone access and try again.');
      return;
    }

    const chunks = [];
    const mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

    // Timer
    let seconds = 0;
    const timerEl = bar.querySelector('.rec-timer');
    const timerInterval = setInterval(() => {
      seconds++;
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    }, 1000);

    mediaRecorder.onstop = async () => {
      clearInterval(timerInterval);
      stream.getTracks().forEach(t => t.stop());
      activeRecorder = null;

      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: mimeType });

      showTranscribing();

      try {
        const formData = new FormData();
        formData.append('audio', blob, 'recording.webm');

        const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Transcription failed');
        }

        const { text } = await res.json();
        if (text && text.trim()) {
          const trimmed = text.trim();
          textarea.value = trimmed;
          transcribedTextarea.value = trimmed;
          if (!state.answers[chapterId]) state.answers[chapterId] = {};
          state.answers[chapterId][promptId] = trimmed;
          saveState();
          // Show transcribed section
          transcribedSection.style.display = '';
          // Update progress label
          const answered = countAnswered(chapterId);
          document.getElementById('prompt-progress-label').textContent = `${answered}/${PROMPTS.chapters.find(c => c.id === chapterId).prompts.length}`;
        }

        await saveRecording(recKey, blob);
        showPlayback(blob);
      } catch (err) {
        alert('Transcription error: ' + err.message);
        showMic();
      }
    };

    mediaRecorder.start();
    activeRecorder = { mediaRecorder, timerInterval, chapterId, promptId };
    showRecording();

    // Stop button
    stopBtn.onclick = () => {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    };
  });
}

// ── GENERATE ──
const STATUS_MESSAGES = [
  'Reading through the answers...',
  'Finding the thread of the story...',
  'Writing the early years...',
  'Crafting each chapter...',
  'Weaving it all together...',
  'Almost there...'
];

async function generateBook() {
  const chapters = getChapters();
  const answeredChapters = chapters.filter(ch => countAnswered(ch.id) > 0);

  if (answeredChapters.length === 0) {
    alert('Answer at least one chapter before generating the book.');
    return;
  }

  const answersToSend = {};
  answeredChapters.forEach(ch => {
    answersToSend[ch.id] = state.answers[ch.id] || {};
  });

  showScreen('screen-generating');

  let msgIdx = 0;
  const statusEl = document.getElementById('gen-status');
  const statusInterval = setInterval(() => {
    msgIdx = (msgIdx + 1) % STATUS_MESSAGES.length;
    statusEl.textContent = STATUS_MESSAGES[msgIdx];
  }, 4000);

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: state.subject, authorName: state.authorName, answers: answersToSend })
    });

    clearInterval(statusInterval);

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Generation failed');
    }

    const data = await res.json();
    state.narrative = data.narrative;
    saveState();
    pingSession({ bookGenerated: true });
    renderBook();
    showScreen('screen-book');
  } catch (err) {
    clearInterval(statusInterval);
    alert('Error generating book: ' + err.message);
    showScreen('screen-chapters');
  }
}

// ── BOOK ──
function renderBook() {
  const { title, dedication, chapters } = state.narrative;
  const chapterMap = {};
  PROMPTS.chapters.forEach(c => { chapterMap[c.id] = c; });

  document.getElementById('book-title-display').textContent = title;

  let html = `
    <div class="book-cover">
      <div class="book-cover-mark">✦</div>
      <h1>${title}</h1>
      ${dedication ? `<p class="book-cover-dedication">${dedication}</p>` : ''}
    </div>
  `;

  chapters.forEach(ch => {
    const meta = chapterMap[ch.id];
    const icon = meta ? meta.icon : '◈';
    html += `
      <div class="book-chapter">
        <div class="book-chapter-header">
          <span class="book-chapter-icon">${icon}</span>
          <h2>${ch.title}</h2>
        </div>
        ${ch.content}
      </div>
    `;
  });

  document.getElementById('book-content').innerHTML = html;
}

// ── PRINT (PDF) ──
function printBook() {
  if (!state.narrative) return;
  const { title, dedication, chapters } = state.narrative;

  let html = `<div class="print-cover"><h1>${title}</h1>`;
  if (dedication) html += `<p>${dedication}</p>`;
  html += '</div>';

  chapters.forEach(ch => {
    html += `<div class="print-chapter"><h2>${ch.title}</h2>${ch.content}</div>`;
  });

  document.getElementById('print-inner').innerHTML = html;
  window.print();
}

// ── EPUB ──
async function exportEpub() {
  if (!state.narrative) return;
  const { title, dedication, chapters } = state.narrative;

  const btn = document.getElementById('export-epub-btn');
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/export/epub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, author: state.authorName, dedication, chapters })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9\s]/gi, '').trim().replace(/\s+/g, '_')}.epub`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('EPUB export failed: ' + err.message);
  } finally {
    btn.textContent = '↓ EPUB';
    btn.disabled = false;
  }
}

// ── SAVE & RESUME ──
function openSaveModal() {
  document.getElementById('save-modal').classList.add('active');
  document.getElementById('save-email-input').value = '';
  document.getElementById('save-modal-status').className = 'modal-status';
  document.getElementById('save-modal-status').textContent = '';
  document.getElementById('save-modal-send').textContent = 'Send my link →';
  document.getElementById('save-modal-send').disabled = false;
}

function closeSaveModal() {
  document.getElementById('save-modal').classList.remove('active');
}

async function saveProgress() {
  const email = document.getElementById('save-email-input').value.trim();
  if (!email) { alert('Please enter your email address.'); return; }

  const statusEl = document.getElementById('save-modal-status');
  const sendBtn = document.getElementById('save-modal-send');
  sendBtn.textContent = 'Saving...';
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/save-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, state })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Save failed');

    statusEl.className = 'modal-status success';
    statusEl.textContent = `Link sent to ${email}! Click it anytime to continue.`;
    sendBtn.textContent = '✓ Sent';
    setTimeout(closeSaveModal, 3000);
  } catch (err) {
    statusEl.className = 'modal-status error';
    statusEl.textContent = 'Error: ' + err.message;
    sendBtn.textContent = 'Send my link →';
    sendBtn.disabled = false;
  }
}

// ── FEEDBACK ──
function openFeedbackModal() {
  document.getElementById('feedback-modal').classList.add('active');
  document.getElementById('feedback-email').value = '';
  document.getElementById('feedback-message').value = '';
  document.getElementById('feedback-status').className = 'modal-status';
  document.getElementById('feedback-status').textContent = '';
  document.getElementById('feedback-send-btn').textContent = 'Send feedback →';
  document.getElementById('feedback-send-btn').disabled = false;
  document.querySelectorAll('.rating-btn').forEach(b => b.classList.remove('active'));
}

// ── COLLECT RECORDINGS ──
async function collectRecordings() {
  const chapters = getChapters();
  const recordings = [];

  for (const chapter of chapters) {
    const chapterAnswers = state.answers[chapter.id] || {};
    for (const prompt of chapter.prompts) {
      if (chapterAnswers[prompt.id] && chapterAnswers[prompt.id].trim()) {
        const key = `${chapter.id}_${prompt.id}`;
        const blob = await getRecording(key);
        if (blob) {
          const base64 = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
          recordings.push({
            key,
            chapterId: chapter.id,
            promptId: prompt.id,
            chapterTitle: chapter.title,
            question: prompt.question.replace(/{name}/g, state.subject.name),
            data: base64,
            mimeType: blob.type || 'audio/webm'
          });
        }
      }
    }
  }

  return recordings;
}

// ── VOICE ARCHIVE MODAL ──
async function openRecordingsModal() {
  const modal = document.getElementById('recordings-modal');
  const list = document.getElementById('recordings-list');
  list.innerHTML = '<p class="recordings-loading">Loading recordings...</p>';
  modal.classList.add('active');

  const chapters = getChapters();
  let html = '';
  let totalFound = 0;

  for (const chapter of chapters) {
    const chapterAnswers = state.answers[chapter.id] || {};
    const promptRows = [];

    for (const prompt of chapter.prompts) {
      const key = `${chapter.id}_${prompt.id}`;
      const blob = await getRecording(key);
      const answer = chapterAnswers[prompt.id] || '';
      if (answer || blob) {
        const hasRec = !!blob;
        if (hasRec) totalFound++;
        const blobUrl = blob ? URL.createObjectURL(blob) : null;
        promptRows.push(`
          <div class="rec-archive-item">
            <p class="rec-archive-q">${prompt.question.replace(/{name}/g, state.subject.name)}</p>
            ${answer ? `<p class="rec-archive-a">${answer}</p>` : ''}
            ${hasRec ? `
              <audio class="rec-archive-audio" controls src="${blobUrl}"></audio>
            ` : '<p class="rec-archive-none">No recording for this question</p>'}
          </div>
        `);
      }
    }

    if (promptRows.length > 0) {
      html += `
        <div class="rec-archive-chapter">
          <h3 class="rec-archive-chapter-title">${chapter.icon} ${chapter.title}</h3>
          ${promptRows.join('')}
        </div>
      `;
    }
  }

  if (!html) {
    list.innerHTML = '<p class="recordings-loading">No answers or recordings found yet.</p>';
  } else {
    list.innerHTML = html;
  }
}

// ── EMAIL MODAL ──
function openEmailModal() {
  document.getElementById('email-modal').classList.add('active');
  document.getElementById('modal-status').className = 'modal-status';
  document.getElementById('modal-status').textContent = '';
  document.getElementById('send-email-input').value = '';
  document.getElementById('send-phone-input').value = '';
  document.getElementById('modal-send-btn').textContent = 'Send →';
  document.getElementById('modal-send-btn').disabled = false;
}

function closeEmailModal() {
  document.getElementById('email-modal').classList.remove('active');
}

async function sendEmail() {
  const email = document.getElementById('send-email-input').value.trim();
  const phone = document.getElementById('send-phone-input').value.trim();

  if (!email) {
    alert('Please enter an email address.');
    return;
  }

  const statusEl = document.getElementById('modal-status');
  const sendBtn = document.getElementById('modal-send-btn');
  sendBtn.textContent = 'Collecting recordings...';
  sendBtn.disabled = true;
  statusEl.className = 'modal-status';
  statusEl.textContent = '';

  try {
    const chapters = getChapters();
    const answeredChapters = chapters.filter(ch => countAnswered(ch.id) > 0);
    const answersToSend = {};
    answeredChapters.forEach(ch => { answersToSend[ch.id] = state.answers[ch.id] || {}; });

    // Collect audio recordings to attach to the email
    const recordings = await collectRecordings();
    sendBtn.textContent = recordings.length > 0 ? `Sending (${recordings.length} recording${recordings.length > 1 ? 's' : ''})...` : 'Sending...';

    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        phone,
        subject: state.subject,
        authorName: state.authorName,
        answers: answersToSend,
        narrative: state.narrative,
        recordings
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to send');
    }

    pingSession({ emailSent: true });
    statusEl.className = 'modal-status success';
    statusEl.textContent = `Sent! Check ${email} for the story.`;
    sendBtn.textContent = '✓ Sent';

    setTimeout(closeEmailModal, 3000);
  } catch (err) {
    statusEl.className = 'modal-status error';
    statusEl.textContent = 'Error: ' + err.message;
    sendBtn.textContent = 'Send →';
    sendBtn.disabled = false;
  }
}

// ── INIT ──
async function init() {
  const res = await fetch('/data/prompts.json');
  PROMPTS = await res.json();

  loadState();

  // Resume from saved link (?resume=ID)
  const resumeId = new URLSearchParams(location.search).get('resume');
  if (resumeId) {
    try {
      const r = await fetch(`/api/session/${resumeId}`);
      if (r.ok) {
        const { state: savedState } = await r.json();
        state = savedState;
        saveState();
        history.replaceState({}, '', location.pathname);
      }
    } catch {}
  }

  if (state.subject.name && state.subject.relationship) {
    showScreen('screen-chapters');
    renderChapters();
  } else {
    showScreen('screen-landing');
  }

  initLanding();

  // Intro screen
  document.getElementById('intro-begin-btn').addEventListener('click', () => {
    showScreen('screen-chapters');
    renderChapters();
  });
  document.getElementById('intro-back-btn').addEventListener('click', () => {
    showScreen('screen-landing');
  });

  // Back buttons
  document.getElementById('back-btn').addEventListener('click', () => {
    showScreen('screen-chapters');
    renderChapters();
  });
  document.getElementById('back-btn-book').addEventListener('click', () => {
    showScreen('screen-chapters');
    renderChapters();
  });

  // Logo → home
  document.getElementById('home-btn').addEventListener('click', () => {
    showScreen('screen-landing');
  });

  // Save progress
  document.getElementById('save-btn').addEventListener('click', openSaveModal);
  document.getElementById('save-modal-cancel').addEventListener('click', closeSaveModal);
  document.getElementById('save-modal-send').addEventListener('click', saveProgress);
  document.getElementById('save-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('save-modal')) closeSaveModal();
  });

  // Reset
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (confirm('Start over? This will clear all your answers.')) {
      state = { subject: { name: '', relationship: '', pronouns: 'he' }, authorName: '', answers: {}, narrative: null };
      saveState();
      showScreen('screen-landing');
      initLanding();
    }
  });

  // Generate
  document.getElementById('generate-btn').addEventListener('click', generateBook);

  // Save chapter
  document.getElementById('save-chapter-btn').addEventListener('click', () => {
    showScreen('screen-chapters');
    renderChapters();
  });

  // Book actions
  document.getElementById('print-btn').addEventListener('click', printBook);
  document.getElementById('export-epub-btn').addEventListener('click', exportEpub);
  document.getElementById('send-email-btn').addEventListener('click', openEmailModal);
  document.getElementById('recordings-btn').addEventListener('click', openRecordingsModal);
  document.getElementById('feedback-fab').addEventListener('click', openFeedbackModal);

  // Feedback modal
  let selectedRating = 0;
  document.querySelectorAll('.rating-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedRating = parseInt(btn.dataset.val);
      document.querySelectorAll('.rating-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val) <= selectedRating));
    });
  });
  document.getElementById('feedback-cancel-btn').addEventListener('click', () => {
    document.getElementById('feedback-modal').classList.remove('active');
  });
  document.getElementById('feedback-send-btn').addEventListener('click', async () => {
    const message = document.getElementById('feedback-message').value.trim();
    const statusEl = document.getElementById('feedback-status');
    const sendBtn = document.getElementById('feedback-send-btn');
    if (!selectedRating && !message) { alert('Please add a rating or message.'); return; }
    sendBtn.textContent = 'Sending...';
    sendBtn.disabled = true;
    try {
      const feedbackEmail = document.getElementById('feedback-email').value.trim();
      await fetch('/api/log/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          email: feedbackEmail || null,
          rating: selectedRating || null,
          subjectName: state.subject.name,
          authorName: state.authorName,
          relationship: state.subject.relationship
        })
      });
      statusEl.className = 'modal-status success';
      statusEl.textContent = 'Thanks for the feedback!';
      setTimeout(() => document.getElementById('feedback-modal').classList.remove('active'), 2000);
    } catch {
      statusEl.className = 'modal-status error';
      statusEl.textContent = 'Could not send. Try again.';
      sendBtn.textContent = 'Send feedback →';
      sendBtn.disabled = false;
    }
  });

  // Email modal
  document.getElementById('modal-cancel-btn').addEventListener('click', closeEmailModal);
  document.getElementById('modal-send-btn').addEventListener('click', sendEmail);
  document.getElementById('email-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('email-modal')) closeEmailModal();
  });

  // Recordings modal
  document.getElementById('recordings-close-btn').addEventListener('click', () => {
    document.getElementById('recordings-modal').classList.remove('active');
  });
  document.getElementById('recordings-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('recordings-modal'))
      document.getElementById('recordings-modal').classList.remove('active');
  });
}

document.addEventListener('DOMContentLoaded', init);

// ── Theme Toggle ──
(function() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  function effectiveTheme() {
    const saved = document.documentElement.getAttribute('data-theme');
    if (saved) return saved;
    return mq.matches ? 'dark' : 'light';
  }

  function updateIcons() {
    const icon = effectiveTheme() === 'dark' ? '☀️' : '🌙';
    document.querySelectorAll('.theme-toggle').forEach(btn => {
      btn.textContent = icon;
    });
  }

  updateIcons();

  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('theme-toggle')) {
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('ab_theme', next);
      updateIcons();
    }
  });

  mq.addEventListener('change', () => {
    const override = localStorage.getItem('ab_theme');
    if (!override) {
      document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
    }
    updateIcons();
  });
})();
