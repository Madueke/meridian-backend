// daily-usage.js — compute today's used daily-loss percentage from the
// live MT5 account history. Falls back to 0 when no account state exists.

function todayIsoPrefix() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @param {object|null} accountState mt5-bridge account state
 * @returns {{ used_percent: number, note: string }}
 */
function dailyUsage(accountState) {
  if (!accountState || !accountState.available) {
    return { used_percent: 0, note: 'no live account state' };
  }
  const history = Array.isArray(accountState.history) ? accountState.history : [];
  const today = todayIsoPrefix();
  const todayPnl = history
    .filter((t) => {
      const ts = t.closed_at || t.time || '';
      return String(ts).startsWith(today);
    })
    .reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);

  const equity = Number(accountState.equity) || Number(accountState.balance) || 0;
  const usedPercent = equity > 0 && todayPnl < 0 ? (-todayPnl / equity) * 100 : 0;
  return { used_percent: Math.round(usedPercent * 100) / 100, note: today };
}

module.exports = { dailyUsage };
