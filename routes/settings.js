// routes/settings.js — per-user app settings (auto_execute) and the risk
// limits shown next to the Auto-Execute toggle.

const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const strategyStore = require('../lib/strategy-store');

// GET /settings — current user's settings. Identity comes from the session
// token (requireAuth sets req.userId).
router.get('/', (req, res) => {
  const user_id = req.userId;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const settings = store.get('settings', user_id) || {};
  const strategy = strategyStore.getProfile(user_id);
  const riskTolerance = strategy ? strategy.profile.risk_tolerance : null;

  res.json({
    user_id,
    auto_execute: settings.auto_execute === true,
    risk_limits: riskTolerance || null,
  });
});

// PATCH /settings — { auto_execute: bool }
router.patch('/', (req, res) => {
  const user_id = req.userId;
  const { auto_execute } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  if (typeof auto_execute !== 'boolean') {
    return res.status(400).json({ error: 'auto_execute must be a boolean' });
  }

  store.update('settings', user_id, (current) => ({
    ...(current || {}),
    auto_execute,
    updated_at: new Date().toISOString(),
  }));

  const strategy = strategyStore.getProfile(user_id);
  res.json({
    status: 'ok',
    auto_execute,
    risk_limits: strategy ? strategy.profile.risk_tolerance : null,
  });
});

module.exports = router;
