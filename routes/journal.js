// routes/journal.js — per-user analysis/trade history for later review.
//
// TRADING MODE: the journal is read-only historical data. This endpoint
// never performs on-screen automation and never places trades.

const express = require('express');
const router = express.Router();
const store = require('../lib/store');

// GET /journal — current user's entries. Identity comes from the session
// token (requireAuth sets req.userId).
router.get('/', (req, res) => {
  const user_id = req.userId;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  const entries = store.get('journal', user_id) || [];
  res.json(entries);
});

module.exports = router;
