// risk-gate.js — hard-coded risk checks. Plain code, never LLM-decided.
//
// Runs BEFORE any execution call. An LLM may propose a trade; this module is
// the only thing allowed to approve it. Any rejection here is final and is
// returned to the client as `risk_gate_result`.

// Correlation groups: same-direction positions in the same group are treated
// as one exposure bet. Heuristic mapping; extend per market regime.
const CORRELATION_GROUPS = [
  ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'XAUUSD'],
  ['USDJPY', 'USDCHF', 'XAUUSD'],
  ['BTCUSD', 'ETHUSD'],
];

function correlationGroup(symbol) {
  const s = String(symbol || '').toUpperCase();
  for (const group of CORRELATION_GROUPS) {
    if (group.includes(s)) return group;
  }
  return null;
}

/**
 * Evaluate a proposed trade against the user's risk profile and live
 * account state.
 *
 * @param {object} trade  { symbol, direction: 'long'|'short', entry, stop, target, risk_percent }
 * @param {object} profile  strategy profile (risk_tolerance)
 * @param {object} accountState  { balance, equity, open_positions: [] } or null
 * @param {object} dailyUsage  { used_percent } from today's journal
 * @returns {{ approved: boolean, reason: string, checks: object }}
 */
function riskGate(trade, profile, accountState, dailyUsage) {
  const tolerance = (profile && profile.risk_tolerance) || {};
  const maxRiskPercent = Number(tolerance.max_risk_percent) || 2;
  const maxDailyLossPercent = Number(tolerance.max_daily_loss_percent) || 5;
  const checks = {};
  const failures = [];

  // 1. Position size vs max risk per trade.
  const riskPercent = Number(trade.risk_percent) || 0;
  checks.risk_per_trade = {
    value: riskPercent,
    limit: maxRiskPercent,
    pass: riskPercent > 0 && riskPercent <= maxRiskPercent,
  };
  if (!checks.risk_per_trade.pass) {
    failures.push(
      `Position risk ${riskPercent}% exceeds max_risk_percent (${maxRiskPercent}%)`,
    );
  }

  // 2. Daily loss cap.
  const used = Number(dailyUsage && dailyUsage.used_percent) || 0;
  checks.daily_loss = {
    value: used,
    limit: maxDailyLossPercent,
    pass: used < maxDailyLossPercent,
  };
  if (!checks.daily_loss.pass) {
    failures.push(
      `Daily loss cap hit (${used}% of ${maxDailyLossPercent}%) — no further trades today`,
    );
  }

  // 3. Correlated exposure.
  const openPositions =
    accountState && Array.isArray(accountState.open_positions)
      ? accountState.open_positions
      : [];
  const group = correlationGroup(trade.symbol);
  const correlated = group
    ? openPositions.filter(
        (p) =>
          group.includes(String(p.symbol || '').toUpperCase()) &&
          String(p.direction || '').toUpperCase() === String(trade.direction || '').toUpperCase(),
      )
    : [];
  checks.correlated_exposure = {
    value: correlated.length,
    limit: 0,
    pass: correlated.length === 0,
  };
  if (correlated.length > 0) {
    failures.push(
      `Correlated exposure limit breached: ${correlated
        .map((p) => `${p.symbol} ${p.direction}`)
        .join(', ')} already open in the same direction as ${trade.symbol}`,
    );
  }

  return {
    approved: failures.length === 0,
    reason: failures.length === 0 ? 'All risk checks passed' : failures.join('; '),
    checks,
  };
}

module.exports = { riskGate, correlationGroup };
