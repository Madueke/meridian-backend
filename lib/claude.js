// claude.js — Claude (Anthropic Messages API) integration for /analyze.
//
// Claude receives real chart data, the user's strategy profile, backtested
// stats and live account state, and is told to:
//   - describe the chart,
//   - judge the setup against the user's profile (criteria hit/missed),
//   - quote ONLY the backtested win_rate/sample_size (never invent numbers),
//   - explain reasoning in plain trader language,
//   - propose a trade ONLY via the `place_trade` tool when the setup matches.
//
// When CLAUDE_API_KEY is missing/placeholder the pipeline falls back to a
// deterministic rule-based analysis (fallbackAnalysis) so the endpoint stays
// testable end to end. The hard-coded risk gate still guards any proposed
// trade either way — Claude never bypasses it.

const axios = require('axios');
const { lastSnapshot } = require('./indicators');
const { riskGate } = require('./risk-gate');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const TRADE_TOOL = {
  name: 'place_trade',
  description:
    'Propose a real trade on the user\'s connected MT5 account. Only use ' +
    'this tool when the current chart setup matches the user\'s defined ' +
    'strategy setup.',
  input_schema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Trading symbol, e.g. EURUSD' },
      direction: { type: 'string', enum: ['long', 'short'] },
      entry: { type: 'number', description: 'Limit/market entry price' },
      stop: { type: 'number', description: 'Stop loss price' },
      target: { type: 'number', description: 'Take profit price' },
      risk_percent: {
        type: 'number',
        description: 'Percent of equity risked on this trade',
      },
      rationale: { type: 'string', description: 'One-paragraph trade rationale' },
    },
    required: ['symbol', 'direction', 'entry', 'stop', 'target', 'risk_percent', 'rationale'],
  },
};

function hasApiKey() {
  const key = process.env.CLAUDE_API_KEY || '';
  return key && key !== 'your_key_here' && key.length > 20;
}

function systemPrompt(profile, backtestStats) {
  const risk = profile.risk_tolerance || {};
  return [
    'You are the analysis engine of a professional AI trading co-pilot.',
    'You analyze charts for one user and compare them against the user\'s',
    'own trading strategy. You never invent numbers: every statistic you',
    'quote must come from the backtest data provided.',
    '',
    'User strategy:',
    JSON.stringify(profile, null, 2),
    '',
    'Backtested accuracy of this setup (quote these exact numbers, never',
    'make up others):',
    JSON.stringify(
      {
        win_rate: backtestStats.win_rate,
        wins: backtestStats.wins,
        losses: backtestStats.losses,
        sample_size: backtestStats.sample_size,
      },
      null,
      2,
    ),
    '',
    'Your response must cover, in order:',
    '1. CHART SUMMARY: what you see on the chart (trend, key levels,',
    '   indicator readings) in 2-3 sentences.',
    '2. STRATEGY MATCH: whether this setup matches the user\'s strategy, and',
    '   exactly which criteria hit and which missed.',
    '3. BACKTEST ACCURACY: quote win_rate and sample_size from the data above',
    '   — never compute or invent them.',
    '4. REASONING: explain your conclusion in plain language, the way an',
    '   experienced trader would explain a trade to a student.',
    '5. TRADE PROPOSAL: use the place_trade tool ONLY if the setup matches.',
    '   If it does not match, say so explicitly and do not call the tool.',
    '',
    'Risk limits the user has configured: max risk per trade',
    `${risk.max_risk_percent ?? 2}%, max daily loss ${risk.max_daily_loss_percent ?? 5}%.`,
    'Never propose a trade whose risk_percent exceeds max risk per trade.',
  ].join('\n');
}

function chartSnapshot(chart) {
  return lastSnapshot({
    closes: chart.candles.map((c) => c.close),
    highs: chart.candles.map((c) => c.high),
    lows: chart.candles.map((c) => c.low),
  });
}

function buildUserContent({ symbol, timeframe, chart, accountState }) {
  const snapshot = chartSnapshot(chart);
  const lines = [
    `Symbol: ${symbol}`,
    `Timeframe: ${timeframe}`,
    `Last ${chart.candles.length} candles (OHLC, newest last):`,
    JSON.stringify(chart.candles.slice(-40)),
    'Indicator snapshot at the latest candle:',
    JSON.stringify(snapshot),
  ];
  if (accountState && accountState.available) {
    lines.push(
      'Live MT5 account state:',
      JSON.stringify({
        balance: accountState.balance,
        equity: accountState.equity,
        open_positions: accountState.open_positions,
      }),
    );
  } else {
    lines.push('Live MT5 account state: not available.');
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Call Claude. Returns { ok: true, text, proposed_trade } or { ok: false,
 * reason } when the API is unavailable. `proposed_trade` comes from the
 * place_trade tool call, if any.
 */
async function analyzeWithClaude({ symbol, timeframe, chart, profile, backtestStats, accountState }) {
  if (!hasApiKey()) {
    return { ok: false, reason: 'CLAUDE_API_KEY not configured' };
  }
  try {
    const { data } = await axios.post(
      ANTHROPIC_URL,
      {
        model: MODEL,
        max_tokens: 1500,
        system: systemPrompt(profile, backtestStats),
        messages: [
          {
            role: 'user',
            content: buildUserContent({ symbol, timeframe, chart, accountState }),
          },
        ],
        tools: [TRADE_TOOL],
      },
      {
        headers: {
          'x-api-key': process.env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 60000,
      },
    );

    let text = '';
    let proposedTrade = null;
    for (const block of data.content || []) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use' && block.name === 'place_trade') {
        proposedTrade = block.input || null;
      }
    }
    return { ok: true, text: text.trim(), proposed_trade: proposedTrade };
  } catch (err) {
    return { ok: false, reason: `Claude call failed: ${err.message}` };
  }
}

/**
 * Deterministic fallback analysis (used when Claude is unavailable) so the
 * /analyze pipeline returns a real, data-derived answer end to end. Marked
 * `llm: 'fallback'` so clients can tell.
 */
function fallbackAnalysis({ symbol, timeframe, chart, profile, backtestStats, accountState }) {
  const snapshot = chartSnapshot(chart);
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
    `Backtested accuracy for this setup: ${(backtestStats.win_rate * 100).toFixed(1)}% win rate on ${backtestStats.sample_size} trades.`,
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
      win_rate: backtestStats.win_rate,
      wins: backtestStats.wins,
      losses: backtestStats.losses,
      sample_size: backtestStats.sample_size,
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
    note: 'Claude unavailable — deterministic analysis based on live indicator data.',
  };
}

module.exports = { analyzeWithClaude, fallbackAnalysis };
