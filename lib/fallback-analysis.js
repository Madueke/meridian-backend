// fallback-analysis.js — deterministic rule-based analysis for /analyze.
//
// Used when no LLM backend is configured (no Hermes API server). Computed
// purely from live indicator data — never invented numbers. The hard-coded
// risk gate still guards any proposed trade on top of this.

const { lastSnapshot } = require('./indicators');

function chartSnapshot(chart) {
  return lastSnapshot({
    closes: chart.candles.map((c) => c.close),
    highs: chart.candles.map((c) => c.high),
    lows: chart.candles.map((c) => c.low),
  });
}

/**
 * Deterministic fallback analysis (used when the LLM backend is unavailable)
 * so the /analyze pipeline returns a real, data-derived answer end to end.
 * Marked `llm: 'fallback'` so clients can tell.
 */
function fallbackAnalysis({ symbol, timeframe, chart, profile, backtestStats, accountState }) {
  const snapshot = chartSnapshot(chart);
  const stats = backtestStats || {};
  const useMacd = (profile.indicators || [])
    .map((i) => i.toUpperCase())
    .includes('MACD');

  const trendUp = snapshot.ema20 > snapshot.ema50;
  const rsiRising = snapshot.rsi_14 > 50 && snapshot.rsi_14 < 70;
  const rsiFalling = snapshot.rsi_14 < 50 && snapshot.rsi_14 > 30;
  const macdBullish = snapshot.macd > snapshot.macd_signal;
  const macdBearish = snapshot.macd < snapshot.macd_signal;

  const hit = [];
  const missed = [];
  if (trendUp) hit.push('EMA20 above EMA50 (uptrend)');
  else missed.push('EMA20 below EMA50 (downtrend)');
  if (rsiRising) hit.push(`RSI ${snapshot.rsi_14} in bullish zone`);
  else missed.push(`RSI ${snapshot.rsi_14} not in bullish zone`);
  if (useMacd) {
    if (macdBullish) hit.push('MACD above signal line');
    else missed.push('MACD below signal line');
  }

  const matched = hit.length >= 2 && missed.length === 0;
  const direction = trendUp ? 'long' : 'short';
  const entry = snapshot.last_close;
  const stop = direction === 'long' ? entry - 1.5 * snapshot.atr_14 : entry + 1.5 * snapshot.atr_14;
  const target = direction === 'long' ? entry + 3 * snapshot.atr_14 : entry - 3 * snapshot.atr_14;

  const text = [
    `Price closed at ${snapshot.last_close} on ${timeframe}. ` +
      `EMA20 (${snapshot.ema20}) is ${trendUp ? 'above' : 'below'} EMA50 (${snapshot.ema50}), ` +
      `RSI(14) reads ${snapshot.rsi_14}${useMacd ? `, and MACD is ${macdBullish ? 'above' : 'below'} its signal` : ''}.`,
    `Setup match: ${matched ? 'MATCHED' : 'did not match'} — ${hit.join(', ') || 'no criteria hit'}${missed.length ? `; missed: ${missed.join(', ')}` : ''}.`,
    `Backtested accuracy for this setup: ${((stats.win_rate || 0) * 100).toFixed(1)}% win rate on ${stats.sample_size || 0} trades.`,
    matched
      ? `A ${direction} trade aligns with the profile: enter ${entry.toFixed(5)}, stop ${stop.toFixed(5)}, target ${target.toFixed(5)}.`
      : 'No trade proposed because the current chart does not match the defined setup.',
  ].join(' ');

  return {
    chart_summary: text.split('. ').slice(0, 1).join('. ') + '.',
    strategy_match: {
      matched,
      criteria_hit: hit,
      criteria_missed: missed,
    },
    backtest_accuracy: {
      win_rate: stats.win_rate ?? 0,
      wins: stats.wins ?? 0,
      losses: stats.losses ?? 0,
      sample_size: stats.sample_size ?? 0,
    },
    reasoning_text: text,
    proposed_trade: matched
      ? {
          symbol,
          direction,
          entry: Math.round(entry * 1e8) / 1e8,
          stop: Math.round(stop * 1e8) / 1e8,
          target: Math.round(target * 1e8) / 1e8,
          risk_percent: Number((profile.risk_tolerance || {}).max_risk_percent) || 2,
          rationale: `Rule-based match on ${timeframe}: ${hit.join(', ')}.`,
        }
      : null,
    llm: 'fallback',
    note: 'LLM backend unavailable — deterministic analysis based on live indicator data.',
  };
}

module.exports = { fallbackAnalysis, chartSnapshot };
