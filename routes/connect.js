// routes/connect.js — account connection endpoints.
//
//   POST /connect-account     tradingview: store watchlist (no secrets)
//                             mt5: store credentials ENCRYPTED at rest, never
//                             returned in any response; only a session token
//                             is handed back to the client.
//   GET  /account-status      per-account connected/not_connected state.
//   POST /disconnect-account  remove the stored account + encrypted creds.
//
// Identity comes from the session token on every call (requireAuth sets
// req.userId) — the app never sends a raw user_id.
//
// TRADING MODE: connecting an account is a backend-only operation. The app
// never touches a broker terminal.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const store = require('../lib/store');
const { encrypt } = require('../lib/crypto-utils');
const { requireAuth } = require('../lib/require-auth');

function sessionToken(userId) {
  return {
    token: uuidv4(),
    user_id: userId,
    issued_at: new Date().toISOString(),
  };
}

// POST /connect-account
router.post('/connect-account', requireAuth, (req, res) => {
  const user_id = req.userId;
  const { account } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  if (!account) return res.status(400).json({ error: 'account is required' });

  if (account === 'tradingview') {
    const { symbols, timeframes } = req.body || {};
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ error: 'symbols must be a non-empty array' });
    }
    const tv = {
      symbols: symbols.map(String),
      timeframes: Array.isArray(timeframes) ? timeframes.map(String) : [],
      connected_at: new Date().toISOString(),
      token: sessionToken(user_id),
    };
    store.set('connections', user_id, { ...(store.get('connections', user_id) || {}), tradingview: tv });
    return res.json({ status: 'ok', session: tv.token });
  }

  if (account === 'mt5') {
    const { account_number, password, broker_server } = req.body || {};
    if (!account_number || !password || !broker_server) {
      return res
        .status(400)
        .json({ error: 'account_number, password and broker_server are required' });
    }
    // Encrypted at rest; never logged, never returned.
    const credentials = {
      account_number: String(account_number),
      password: String(password),
      broker_server: String(broker_server),
    };
    const mt5 = {
      enc: encrypt(credentials),
      broker_server: String(broker_server),
      connected_at: new Date().toISOString(),
      token: sessionToken(user_id),
    };
    store.set('mt5_credentials', user_id, mt5);
    return res.json({ status: 'ok', session: mt5.token });
  }

  return res.status(400).json({ error: `Unknown account type: ${account}` });
});

// GET /account-status
router.get('/account-status', requireAuth, (req, res) => {
  const user_id = req.userId;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const connections = store.get('connections', user_id) || {};
  const hasMt5 = Boolean(store.get('mt5_credentials', user_id));

  res.json({
    user_id,
    accounts: {
      tradingview: {
        status: connections.tradingview ? 'connected' : 'not_connected',
        detail: connections.tradingview
          ? `${(connections.tradingview.symbols || []).length} symbols synced`
          : null,
      },
      mt5: {
        status: hasMt5 ? 'connected' : 'not_connected',
        detail: hasMt5
          ? store.get('mt5_credentials', user_id).broker_server
          : null,
      },
    },
  });
});

// POST /disconnect-account — { account }
router.post('/disconnect-account', requireAuth, (req, res) => {
  const user_id = req.userId;
  const { account } = req.body || {};
  if (!user_id || !account) {
    return res.status(400).json({ error: 'user_id and account are required' });
  }

  if (account === 'mt5') {
    store.remove('mt5_credentials', user_id);
  } else if (account === 'tradingview') {
    store.update('connections', user_id, (current) => {
      if (!current) return current;
      const next = { ...current };
      delete next.tradingview;
      return next;
    });
  } else {
    return res.status(400).json({ error: `Unknown account type: ${account}` });
  }

  res.json({ status: 'ok', disconnected: true, account });
});

module.exports = router;
