// routes/execute.js — direct trade-signal endpoint.
//
// Fully wired: the hard-coded risk gate runs before anything is sent to the
// MT5 bridge, so an LLM can never place a trade that violates the user's
// risk profile.
//
// TRADING MODE: trade execution happens ONLY server-side through this
// endpoint (or via /analyze auto-execute). Never route execution through
// on-screen device automation.

const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const strategyStore = require('../lib/strategy-store');
const mt5Bridge = require('../lib/mt5-bridge');
const { riskGate } = require('../lib/risk-gate');
const { dailyUsage } = require('../lib/daily-usage');

// POST /execute-trade-signal — { signal: {...} }. Identity comes from the
// session token (requireAuth sets req.userId).
router.post('/', async (req, res, next) => {
  try {
    const user_id = req.userId;
    const { signal } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!signal || typeof signal !== 'object') {
      return res.status(400).json({ error: 'signal is required' });
    }

    const strategy = strategyStore.getProfile(user_id);
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

    const gate = riskGate(
      signal,
      strategy ? strategy.profile : { risk_tolerance: {} },
      accountState,
      dailyUsage(accountState),
    );

    if (!gate.approved) {
      return res.json({ status: 'rejected', risk_gate_result: gate });
    }

    const result = await mt5Bridge.executeTrade(signal);
    res.json({
      status: result.executed ? 'executed' : 'failed',
      signal_id: signal.signal_id || null,
      trade_id: result.trade_id || null,
      risk_gate_result: gate,
      reason: result.reason,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
