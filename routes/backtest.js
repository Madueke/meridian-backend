// routes/backtest.js — POST /backtest: run the stored strategy against
// historical data and return real computed stats (never an LLM guess).

const express = require('express');
const router = express.Router();
const strategyStore = require('../lib/strategy-store');
const { runBacktestForUser } = require('../lib/analyze-pipeline');

// POST /backtest — re-run the current user's strategy backtest. Identity
// comes from the session token (requireAuth sets req.userId).
router.post('/', async (req, res, next) => {
  try {
    const user_id = req.userId;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const current = strategyStore.getProfile(user_id);
    if (!current) {
      return res.status(404).json({ error: 'No strategy saved for this user' });
    }

    const stats = await runBacktestForUser(current.profile);
    strategyStore.attachBacktest(user_id, stats);
    res.json({ status: 'ok', ...stats });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
