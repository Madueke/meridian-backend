// routes/admin.js — minimal admin surface for the Neutral Pip backend.
//
// Authenticated by an ADMIN_TOKEN env var (sent as `Authorization: Bearer`
// or `x-admin-token`). When ADMIN_TOKEN is not configured the endpoints
// answer 503 so it is obvious the surface is off, never silently open.
//
// GET  /admin/users                        — users with activation state
// POST /admin/users/:user_id/deactivate    — admin force-deactivate (pauses
//                                            chat, analysis and alarms; keeps
//                                            all data for later reactivation)

const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const auth = require('../lib/auth');
const strategyStore = require('../lib/strategy-store');

function adminToken() {
  return process.env.ADMIN_TOKEN || '';
}

function requireAdmin(req, res, next) {
  const expected = adminToken();
  if (!expected) {
    return res.status(503).json({ error: 'Admin API not configured (set ADMIN_TOKEN)' });
  }
  const header = req.headers.authorization || '';
  const provided =
    header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-admin-token'] || '');
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
  return next();
}

// GET /admin/users — all users with activation visibility.
router.get('/users', requireAdmin, (req, res) => {
  const userIds = store.keys('users') || [];
  const users = userIds
    .map((userId) => {
      const user = store.get('users', userId);
      if (!user) return null;
      return {
        user_id: userId,
        email: user.email,
        display_name: user.display_name,
        created_at: user.created_at,
        agent_active: user.agent_active === true,
        activated_at: user.activated_at || null,
        has_strategy_profile: !!strategyStore.getProfile(userId),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  res.json({ users });
});

// POST /admin/users/:user_id/deactivate — force-deactivate a user.
router.post('/users/:user_id/deactivate', requireAdmin, (req, res) => {
  const { user_id } = req.params;
  const user = auth.getUserById(user_id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  auth.setAgentActive(user_id, false);
  res.json({ deactivated: true, user_id });
});

module.exports = router;
