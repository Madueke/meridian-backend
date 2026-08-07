// lib/credential-guard.js — coarse heuristic that flags chat messages which
// look like the user is pasting account credentials. Anything typed into chat
// becomes part of the conversation Hermes persists in memory, so /chat refuses
// to forward credential-shaped content. This is a safety net, NOT the primary
// defense: the structural boundary is that MCP tools never accept credentials
// as parameters and account connection only happens through the app's
// Connect Trading Accounts screen (encrypted storage, never seen by the LLM).

const CRED_HINT =
  /(password|passcode|pwd|mt5\s*login|login\s*id|account\s+number|account\s+password|trading\s+password|secret|credential|api[-\s]?key)\b/i;
const CRED_ASSIGN =
  /(password|passcode|pwd|login|secret|credential|api[-\s]?key)\s*(?::|=|is|of)\s*['"]?[A-Za-z0-9!@#$%^&*._\-]{4,}/i;
const CRED_NEAR =
  /(password|passcode|pwd|mt5\s*login|login\s*id|account\s+number|account\s+password|trading\s+password|secret|credential|api[-\s]?key)\b.{0,40}([A-Za-z0-9!@#$%^&*._\-]{10,})/i;

/**
 * True when the text is likely credential-shaped: either an explicit
 * assignment to a credential word ("password: hunter2", "login is myuser123")
 * or a credential hint word with a long token nearby. Plain questions
 * ("what is my password?") are not flagged.
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeCredentials(text) {
  const t = String(text || '');
  if (t.length < 6) return false;
  return CRED_ASSIGN.test(t) || (CRED_HINT.test(t) && CRED_NEAR.test(t));
}

module.exports = { looksLikeCredentials };
