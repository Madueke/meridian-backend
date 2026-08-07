// mt5-bridge.js — server-side MT5 integration via the MT5 bridge service.
//
// The backend never holds a live broker connection; MT5_BACKEND_URL points
// at a small bridge service that holds the terminal session. This module
// makes two read-only/execution calls against it. Credentials are forwarded
// only when the bridge needs them, never logged, and never returned in any
// response.

const axios = require('axios');

function bridgeUrl() {
  return process.env.MT5_BACKEND_URL || '';
}

/**
 * Pull live account state: balance, equity, open positions, recent history.
 * Read-only. Returns { available: false, reason } when the bridge is not
 * configured or unreachable (never fabricated numbers).
 */
async function getAccountState(credentials) {
  const base = bridgeUrl();
  if (!base) {
    return { available: false, reason: 'MT5_BACKEND_URL not configured' };
  }
  try {
    const { data } = await axios.post(
      `${base}/account-state`,
      { credentials: credentials || null },
      { timeout: 10000 },
    );
    if (data && typeof data.balance === 'number') {
      return {
        available: true,
        balance: data.balance,
        equity: data.equity ?? data.balance,
        open_positions: Array.isArray(data.open_positions) ? data.open_positions : [],
        history: Array.isArray(data.history) ? data.history : [],
        // The bridge flags simulated mode so callers can label it honestly.
        simulation: data.simulation === true,
      };
    }
    return { available: false, reason: data && data.reason ? data.reason : 'Unexpected bridge response' };
  } catch (err) {
    return { available: false, reason: `MT5 bridge unreachable: ${err.message}` };
  }
}

/**
 * Place a real trade through the bridge. Only called after the risk gate
 * approved the order. Returns { executed: bool, trade_id?, reason? }.
 */
async function executeTrade(order, credentials) {
  const base = bridgeUrl();
  if (!base) {
    return { executed: false, reason: 'MT5_BACKEND_URL not configured' };
  }
  try {
    const { data } = await axios.post(`${base}/execute`, { order, credentials }, { timeout: 15000 });
    return {
      executed: data && data.executed === true,
      trade_id: data && data.trade_id ? data.trade_id : undefined,
      reason: data && data.reason ? data.reason : undefined,
      simulation: data && data.simulation === true,
    };
  } catch (err) {
    return { executed: false, reason: `MT5 bridge error: ${err.message}` };
  }
}

module.exports = { getAccountState, executeTrade };
