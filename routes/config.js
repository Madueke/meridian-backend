// routes/config.js — read/update the agent's current configuration.
//
// Aggregates the strategy profile, risk rules, alarms, and skills
// (user-taught vs auto-extracted) for the Agent Setup screen, plus small
// mutation endpoints for toggling a skill or an alarm on/off. Identity is
// derived from the Bearer session token; skills are scoped by the chat
// session_id (same value the app sends to /chat).
//
// TRADING MODE: read-only configuration surface. No execution, no automation.

const express = require('express');
const router = express.Router();
const strategyStore = require('../lib/strategy-store');
const alarms = require('../lib/alarms');
const hermesMemory = require('../lib/hermes-memory');

// GET /config?session_id=xxx — current config summary.
router.get('/', (req, res) => {
  const user_id = req.userId;
  const session_id = String(req.query.session_id || 'default');

  hermesMemory.initDb();

  const profile = strategyStore.getProfile(user_id);
  const userSkills = hermesMemory.getSkillsBySource(session_id, 'user_taught');
  const autoSkills = hermesMemory.getSkillsBySource(session_id, 'auto');

  res.json({
    has_profile: !!profile,
    strategy_profile: profile
      ? {
          version: profile.version,
          updated_at: profile.updated_at,
          rules: profile.profile.rules || '',
          indicators: profile.profile.indicators || [],
          preferred_pairs: profile.profile.preferred_pairs || [],
          timeframes: profile.profile.timeframes || [],
          setup_description: profile.profile.setup_description || '',
        }
      : null,
    risk_rules: profile ? profile.profile.risk_tolerance || null : null,
    alarms: alarms.getAlarms(user_id),
    skills: {
      user_taught: userSkills.map((s) => ({
        name: s.name,
        description: s.description,
        active: s.active === 1,
      })),
      auto_extracted: autoSkills.map((s) => ({
        name: s.name,
        description: s.description,
        active: s.active === 1,
      })),
    },
  });
});

// POST /config/skill-active — toggle a skill's active state.
// Body: { session_id, name, active }
router.post('/skill-active', (req, res) => {
  const { session_id = 'default', name, active } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  hermesMemory.initDb();
  hermesMemory.setSkillActive(String(session_id), name, active === true);
  res.json({ status: 'ok', name, active: active === true });
});

// POST /config/alarm-active — toggle an alarm's active state.
// Body: { id, active }
router.post('/alarm-active', (req, res) => {
  const { id, active } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }
  const user_id = req.userId;
  const existing = alarms.getAlarm(user_id, String(id));
  if (!existing) {
    return res.status(404).json({ error: 'Alarm not found' });
  }
  alarms.setAlarm(user_id, { id: String(id), active: active === true });
  res.json({ status: 'ok', alarm: alarms.getAlarm(user_id, String(id)) });
});

module.exports = router;
