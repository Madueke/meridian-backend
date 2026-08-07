// lib/trade-approval.js — backend-side approval decision for Hermes trade
// approvals. When the mt5-server MCP tool requests an approval (elicitation),
// Hermes surfaces an approval.request event on the run stream; the backend
// parses the exact order from the event command, applies the hard-coded risk
// gate against the user's strategy profile and live MT5 account, then
// approves (choice 'once') or denies. Anything unrecognized is denied — the
// backend is the approval authority and fails closed.

const { resolveCredentials, DEFAULT_USER_REF } = require('./mt5-credentials');
const { riskGate } = require('./risk-gate');
const { dailyUsage } = require('./daily-usage');
const strategyStore = require('./strategy-store');
const mt5Bridge = require('./mt5-bridge');

const TRADE_APPROVAL_PREFIX = 'NP_TRADE_APPROVAL:';

// The order payload is embedded in the approval command as
// `NP_TRADE_APPROVAL:{"order":{...},"user_id":"..."}` by the mt5-server MCP
// tool. Hermes may redact credential-shaped fragments before forwarding; a
// payload that no longer parses is denied (fail closed).
function parseTradePayload(command) {
  if (!command || !command.includes(TRADE_APPROVAL_PREFIX)) return null;
  const json = command.slice(
    command.indexOf(TRADE_APPROVAL_PREFIX) + TRADE_APPROVAL_PREFIX.length,
  );
  try {
    const parsed = JSON.parse(json);
    if (parsed && parsed.order && typeof parsed.order === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a proposed trade may proceed.
 * @param {Object} params
 * @param {string} params.command - The approval.request event `command` field
 * @param {string} [params.fallbackUser] - Session-derived user id, used when
 *   the MCP payload carries no user reference
 * @returns {Promise<{choice: 'once'|'deny', reason: string}>}
 */
async function decideTradeApproval({ command, fallbackUser }) {
  const payload = parseTradePayload(command);
  if (!payload) {
    return { choice: 'deny', reason: 'Unrecognized or malformed trade approval request.' };
  }

  const order = payload.order;
  const user_id = payload.user_id || fallbackUser || DEFAULT_USER_REF;
  const { credentials, error } = resolveCredentials(user_id);
  if (error) {
    return { choice: 'deny', reason: `Approval denied: ${error}` };
  }

  let accountState = null;
  try {
    accountState = await mt5Bridge.getAccountState(credentials);
  } catch {
    accountState = null;
  }

  const profile = strategyStore.getProfile(user_id);
  const gate = riskGate(
    order,
    profile ? profile.profile : { risk_tolerance: {} },
    accountState,
    dailyUsage(accountState),
  );

  if (!gate.approved) {
    return { choice: 'deny', reason: `Risk gate denied trade: ${gate.reason}` };
  }
  return { choice: 'once', reason: 'Risk gate passed; trade approved.' };
}

module.exports = { decideTradeApproval, parseTradePayload, TRADE_APPROVAL_PREFIX };
