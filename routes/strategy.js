// routes/strategy.js — POST/GET the user's strategy profile.
//
// Profiles are versioned and encrypted at rest (strategy-store). Saving a
// new profile kicks off an automatic backtest re-run in the background; the
// result lands on the new version and is returned by GET /strategy.

const express = require('express');
const router = express.Router();
const strategyStore = require('../lib/strategy-store');
const { runBacktestForUser } = require('../lib/analyze-pipeline');

// POST /strategy — { rules, indicators[], preferred_pairs[],
//                    timeframes[], risk_tolerance{}, setup_description }
// Identity comes from the session token (requireAuth sets req.userId).
router.post('/', async (req, res, next) => {
  try {
    const user_id = req.userId;
    const {
      rules,
      indicators,
      preferred_pairs,
      timeframes,
      risk_tolerance,
      setup_description,
      reference_examples,
    } = req.body || {};

    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!rules && !setup_description) {
      return res
        .status(400)
        .json({ error: 'Provide at least rules or setup_description' });
    }

    const profile = {
      rules: String(rules || '').trim(),
      indicators: Array.isArray(indicators) ? indicators.map(String) : [],
      preferred_pairs: Array.isArray(preferred_pairs) ? preferred_pairs.map(String) : [],
      timeframes: Array.isArray(timeframes) ? timeframes.map(String) : [],
      risk_tolerance: risk_tolerance && typeof risk_tolerance === 'object'
        ? {
            max_risk_percent: Number(risk_tolerance.max_risk_percent) || 2,
            max_daily_loss_percent: Number(risk_tolerance.max_daily_loss_percent) || 5,
          }
        : { max_risk_percent: 2, max_daily_loss_percent: 5 },
      setup_description: String(setup_description || '').trim(),
      reference_examples: Array.isArray(reference_examples)
        ? reference_examples.map(String)
        : [],
    };

    const { version } = strategyStore.saveProfile(user_id, profile);

    // Auto re-run the backtest for this new version (spec 1b). Runs in the
    // background so the POST responds fast; results appear via GET /strategy.
    runBacktestForUser(profile)
      .then((stats) => strategyStore.attachBacktest(user_id, stats))
      .catch((err) => console.error('[strategy] background backtest failed:', err.message));

    res.json({ status: 'ok', version, backtest_pending: true });
  } catch (err) {
    next(err);
  }
});

// GET /strategy — current profile + latest backtest for the session user.
router.get('/', (req, res) => {
  const user_id = req.userId;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  const current = strategyStore.getProfile(user_id);
  if (!current) {
    return res.status(404).json({ error: 'No strategy saved for this user' });
  }
  res.json({
    user_id,
    profile: current.profile,
    version: current.version,
    updated_at: current.updated_at,
    backtest: current.backtest,
  });
});

module.exports = router;
