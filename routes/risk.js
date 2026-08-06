// routes/risk.js — per-user risk status: daily loss used, open exposure.
//
// TRADING MODE: risk status is read-only account data. This endpoint
// never performs on-screen automation and never places trades.

const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const strategyStore = require('../lib/strategy-store');
const mt5Bridge = require('../lib/mt5-bridge');
const { dailyUsage } = require('../lib/daily-usage');

// GET /risk-status — current user's risk status. Identity comes from the
// session token (requireAuth sets req.userId).
router.get('/', async (req, res, next) => {
  try {
    const user_id = req.userId;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const strategy = strategyStore.getProfile(user_id);
    const tolerance = strategy ? strategy.profile.risk_tolerance : null;

    const cred = store.get('mt5_credentials', user_id);
    const { decrypt } = require('../lib/crypto-utils');
    let accountState = null;
    if (cred && cred.enc) {
      try {
        accountState = await mt5Bridge.getAccountState(decrypt(cred.enc));
      } catch {
        accountState = null;
      }
    }

    const usage = dailyUsage(accountState);
    const openPositions =
      accountState && accountState.available && Array.isArray(accountState.open_positions)
        ? accountState.open_positions
        : [];

    const exposurePercent =
      accountState && accountState.available && accountState.equity > 0
        ? Math.round(
            (openPositions.reduce((sum, p) => sum + (Number(p.risk_amount) || 0), 0) /
              accountState.equity) *
              1000,
          ) / 1000
        : 0;

    res.json({
      exposure_percent: exposurePercent,
      daily_loss_used: usage.used_percent,
      daily_loss_limit: tolerance ? tolerance.max_daily_loss_percent : 2.0,
      max_risk_percent: tolerance ? tolerance.max_risk_percent : 2.0,
      open_positions: openPositions,
      account_available: accountState ? accountState.available : false,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
