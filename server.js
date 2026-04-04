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

const ANALYTICS_PATH = path.join(__dirname, 'data', 'analytics.json');
const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function readAnalytics() {
  try { return JSON.parse(fs.readFileSync(ANALYTICS_PATH, 'utf8')); }
  catch { return { sessions: [], emails: [], feedback: [] }; }
}
function writeAnalytics(data) {
  fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(data, null, 2));
}

app.use(express.json({ limit: '50mb' }));

// ── Static file serving ──
app.use('/play', express.static(path.join(__dirname, 'public/7q')));
app.use('/autobiography', express.static(path.join(__dirname, 'public/autobiography')));
app.use('/thumbnails', express.static(path.join(__dirname, 'public/thumbnails')));
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

// ════════════════════════════════════════
// WORD-A-DAY API
// ════════════════════════════════════════

const WAD_PROGRESS_DIR = path.join(__dirname, 'data/word-a-day/progress');
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

// POST /api/wad/complete-word
app.post('/api/wad/complete-word', (req, res) => {
  const { token, wordId, accuracy } = req.body;
  const p = wadReadProgress(token);
  if (!p) return res.status(404).json({ error: 'Session not found' });

  if (!p.completedWords.includes(wordId)) p.completedWords.push(wordId);
  wadWriteProgress(token, p);
  res.json({ ok: true });
});

// POST /api/wad/complete-day
app.post('/api/wad/complete-day', (req, res) => {
  const { token } = req.body;
  const p = wadReadProgress(token);
  if (!p) return res.status(404).json({ error: 'Session not found' });

  const today = wadTodayStr();
  if (!p.studyDays.includes(today)) p.studyDays.push(today);
  p.lastStudied = today;
  p.streak = computeStreak(p.studyDays);
  p.longestStreak = Math.max(p.longestStreak || 0, p.streak);
  advanceProgressDay(p);
  wadWriteProgress(token, p);
  res.json(p);
});

// POST /api/wad/submit-exam
app.post('/api/wad/submit-exam', (req, res) => {
  const { token, week, tier, score, grade, passed } = req.body;
  const p = wadReadProgress(token);
  if (!p) return res.status(404).json({ error: 'Session not found' });

  const canRetakeAt = passed ? null : wadAddDays(wadTodayStr(), 7);
  // Remove old attempt if retake
  p.exams = (p.exams || []).filter(e => !(e.tier===tier && e.week===week));
  p.exams.push({ tier, week, score, grade, passed, takenAt: wadTodayStr(), canRetakeAt });

  wadWriteProgress(token, p);
  res.json(p);
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

app.post('/api/generate-bg', express.json(), async (req, res) => {
  const { prompt, provider = 'dalle' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  try {
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
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1792x1024',
      quality: 'standard',
      response_format: 'b64_json'
    });
    res.json({ dataUrl: `data:image/png;base64,${result.data[0].b64_json}` });

  } catch (err) {
    console.error('[generate-bg]', err.message);
    res.status(500).json({ error: err.message });
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
