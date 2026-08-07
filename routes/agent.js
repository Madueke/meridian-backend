// routes/agent.js — per-user agent activation state.
//
// "Activating" a user's agent initializes their data partition in the
// existing stores (strategy profile, risk rules, memory session) and flips
// the agent_active flag. It never spins up per-user infrastructure.
// Deactivation only flips the flag — memory, strategy and history persist,
// so reactivation picks up exactly where the user left off.
//
// TRADING MODE: read-only activation surface. No execution, no automation.

const express = require('express');
const router = express.Router();
const auth = require('../lib/auth');
const store = require('../lib/store');
const strategyStore = require('../lib/strategy-store');
const hermesMemory = require('../lib/hermes-memory');

// Conservative defaults for a brand-new user who has not trained or reviewed
// anything yet. Users can later change these via the config chat / Agent
// Setup screen.
const DEFAULT_PROFILE = {
  rules: '',
  indicators: [],
  preferred_pairs: [],
  timeframes: [],
  setup_description: '',
  risk_tolerance: {
    max_risk_percent: 1,
    max_daily_loss_percent: 3,
    max_correlated_positions: 1,
  },
};

// POST /agent/activate — create default rows (if missing) and flip the flag.
// Idempotent: re-activation never resets user-edited defaults.
router.post('/activate', (req, res) => {
  const user_id = req.userId;

  let defaultsApplied = { strategy_profile: false, memory_session: false };

  if (!strategyStore.getProfile(user_id)) {
    strategyStore.saveProfile(user_id, DEFAULT_PROFILE);
    defaultsApplied.strategy_profile = true;
  }

  // Confirm a memory partition exists (hermes memory is user_id-scoped via
  // session rows). 'default' is the session id the app uses for chat.
  hermesMemory.initDb();
  hermesMemory.getOrCreateSession('default', user_id);
  defaultsApplied.memory_session = true;

  auth.setAgentActive(user_id, true);

  res.json({
    activated: true,
    defaults_applied: defaultsApplied,
  });
});

// POST /agent/deactivate — reversible pause. Never deletes data.
router.post('/deactivate', (req, res) => {
  auth.setAgentActive(req.userId, false);
  res.json({ deactivated: true });
});

// GET /agent/status — current activation state plus readiness booleans.
router.get('/status', (req, res) => {
  const user_id = req.userId;
  const status = auth.getAgentStatus(user_id);
  if (!status) {
    return res.status(404).json({ error: 'User not found' });
  }
  const hasConnectedAccounts = Boolean(
    store.get('mt5_credentials', user_id) || store.get('connections', user_id),
  );
  res.json({
    ...status,
    has_strategy_profile: !!strategyStore.getProfile(user_id),
    has_connected_accounts: hasConnectedAccounts,
  });
});

module.exports = router;
