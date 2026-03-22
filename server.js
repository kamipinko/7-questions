const express = require('express');
const path = require('path');
const questions = require('./data/questions.json');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

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

app.listen(PORT, () => {
  console.log(`Questions app running at http://localhost:${PORT}`);
});
