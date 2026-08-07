// routes/notifications.js — User notification endpoints.
// TRADING MODE: read-only. Notifications are created by the alarm system
// and other server-side processes; the app polls this endpoint.

const express = require('express');
const router = express.Router();
const store = require('../lib/store');
const { requireAuth } = require('../lib/require-auth');

// GET /notifications - fetch unread notifications for the authenticated user
router.get('/', requireAuth, (req, res) => {
  const userId = req.user.user_id;
  const notifications = store.get('notifications', userId) || [];
  
  // Mark as read if requested
  const { mark_read } = req.query;
  if (mark_read) {
    const updated = notifications.map((n) => ({ ...n, read: true }));
    store.set('notifications', userId, updated);
  }
  
  res.json({ notifications });
});

// GET /notifications/unread-count - get count of unread notifications
router.get('/unread-count', requireAuth, (req, res) => {
  const userId = req.user.user_id;
  const notifications = store.get('notifications', userId) || [];
  const unread = notifications.filter((n) => !n.read).length;
  res.json({ unread_count: unread });
});

// POST /notifications/:id/read - mark a specific notification as read
router.post('/:id/read', requireAuth, (req, res) => {
  const userId = req.user.user_id;
  const { id } = req.params;
  
  store.update('notifications', userId, (notifs) => {
    if (!Array.isArray(notifs)) return notifs;
    return notifs.map((n) => (n.id === req.params.id ? { ...n, read: true } : n));
  });
  
  res.json({ status: 'ok' });
});

// POST /notifications/read-all - mark all as read
router.post('/read-all', requireAuth, (req, res) => {
  const userId = req.user.user_id;
  
  store.update('notifications', userId, (notifs) => {
    if (!Array.isArray(notifs)) return notifs;
    return notifs.map((n) => ({ ...n, read: true }));
  });
  
  res.json({ status: 'ok' });
});

// GET /notifications/settings - get alarm settings
router.get('/settings', requireAuth, (req, res) => {
  const { getAlarmSettings } = require('../lib/alarms');
  const settings = getAlarmSettings(req.user.user_id);
  res.json({ settings });
});

// POST /notifications/settings - update alarm settings
router.post('/settings', requireAuth, (req, res) => {
  const { setAlarmSettings } = require('../lib/alarms');
  const settings = setAlarmSettings(req.user.user_id, req.body || {});
  res.json({ settings });
});

// POST /notifications/test - send a test notification (for debugging)
router.post('/test', requireAuth, async (req, res) => {
  const { sendPushNotification } = require('../lib/alarms');
  const notification = await sendPushNotification(req.user.user_id, {
    symbol: 'TEST',
    timeframe: 'H1',
    chart_summary: 'Test notification from Neutral Pip',
    reasoning_text: 'This is a test alert to verify push notifications work.',
    proposed_trade: { symbol: 'TEST', direction: 'long', entry: 1.0, stop: 0.99, target: 1.02 },
  });
  res.json({ notification });
});

module.exports = router;