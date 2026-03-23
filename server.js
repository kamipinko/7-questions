const express = require('express');
const path = require('path');
const questions = require('./data/questions.json');

const app = express();
const PORT = process.env.PORT || 3000;

// Set your Google Apps Script webhook URL as an env var: SHEETS_WEBHOOK_URL
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/questions', (req, res) => {
  const { relation, tier } = req.query;

  if (!relation || !tier) {
    return res.status(400).json({ error: 'relation and tier are required' });
  }

  const tierNum = parseInt(tier);
  const filtered = questions.filter(q =>
    q.tier === tierNum && q.relations.includes(relation)
  );

  const shuffled = [...filtered].sort(() => Math.random() - 0.5);
  res.json(shuffled);
});

app.post('/api/subscribe', async (req, res) => {
  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  if (SHEETS_WEBHOOK_URL) {
    try {
      const url = `${SHEETS_WEBHOOK_URL}?email=${encodeURIComponent(email)}`;
      await fetch(url, { redirect: 'follow' });
    } catch (err) {
      console.error('Sheets webhook error:', err.message);
    }
  } else {
    console.log('New subscriber (no webhook configured):', email);
  }

  res.json({ success: true });
});

app.post('/api/feedback', async (req, res) => {
  const { message, email } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (SHEETS_WEBHOOK_URL) {
    try {
      const params = new URLSearchParams({ type: 'feedback', message });
      if (email) params.append('email', email);
      await fetch(`${SHEETS_WEBHOOK_URL}?${params.toString()}`, { redirect: 'follow' });
    } catch (err) {
      console.error('Sheets webhook error:', err.message);
    }
  } else {
    console.log('New feedback:', { message, email });
  }

  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Questions app running at http://localhost:${PORT}`);
});
