// lib/mt5-credentials.js — resolve a user's encrypted MT5 credentials from
// the backend store. Shared by the MCP mt5-server subprocess and the backend
// approval-decision path so both processes resolve the exact same account.
// Credentials are decrypted at rest with STRATEGY_ENC_KEY and never logged
// or returned in responses — only used to talk to the MT5 bridge.

const store = require('./store');
const cryptoUtils = require('./crypto-utils');

const DEFAULT_USER_REF = process.env.NP_DEFAULT_USER_ID || '';

/**
 * Resolve encrypted MT5 credentials for a user.
 * @param {string} [userRef] - Optional user id. Falls back to the backend's
 *   default connected account (NP_DEFAULT_USER_ID) when omitted.
 * @returns {{ user_id: string, credentials?: object, error?: string }}
 */
function resolveCredentials(userRef) {
  const user_id = userRef || DEFAULT_USER_REF;
  const cred = store.get('mt5_credentials', user_id);
  if (cred && cred.enc) {
    try {
      return { user_id, credentials: cryptoUtils.decrypt(cred.enc) };
    } catch (err) {
      return { user_id, error: `Failed to decrypt MT5 credentials: ${err.message}` };
    }
  }
  return {
    user_id,
    error: 'No MT5 account connected for this user. Connect one in the app first.',
  };
}

module.exports = { resolveCredentials, DEFAULT_USER_REF };
