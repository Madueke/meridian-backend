// routes/analyze.js — POST /analyze: the full analysis pipeline.
//
// TRADING MODE: analysis is read-only research. Any trade execution that
// follows is server-side only, gated by the hard-coded risk gate — never
// through on-screen automation.

const express = require('express');
const router = express.Router();
const { runAnalyze } = require('../lib/analyze-pipeline');
const { isAgentActive } = require('../lib/auth');

// Gate the whole pipeline on agent activation: an inactive agent must not
// silently fail or produce analysis the user didn't ask to resume.
function requireActiveAgent(req, res, next) {
  if (!isAgentActive(req.userId)) {
    return res
      .status(403)
      .json({ error: 'Agent not activated', activation_required: true });
  }
  return next();
}

// POST /analyze — { symbol, timeframe }. Identity comes from the session
// token (requireAuth sets req.userId); the app never sends a raw user_id.
router.post('/', requireActiveAgent, async (req, res, next) => {
  try {
    const { symbol, timeframe } = req.body || {};
    const result = await runAnalyze({ user_id: req.userId, symbol, timeframe });
    res.json(result);
  } catch (err) {
    if (err && err.status && err.error) {
      return res.status(err.status).json({ error: err.error });
    }
    next(err);
  }
});

// GET /analyze — legacy shim mapping query params onto the same pipeline.
router.get('/', requireActiveAgent, async (req, res, next) => {
  try {
    const { symbol, timeframe } = req.query;
    const result = await runAnalyze({ user_id: req.userId, symbol, timeframe });
    res.json(result);
  } catch (err) {
    if (err && err.status && err.error) {
      return res.status(err.status).json({ error: err.error });
    }
    next(err);
  }
});

module.exports = router;
