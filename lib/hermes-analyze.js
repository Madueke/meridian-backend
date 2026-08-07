// lib/hermes-analyze.js — Hermes-based analysis for /analyze.
//
// When the Hermes API server is configured, /analyze goes through Hermes
// (the same LLM that powers /chat) instead of any external provider. Hermes
// receives real chart data, the user's strategy profile, backtested stats
// and live account state, and must reply with a single strict JSON object.
// The hard-coded risk gate still guards any proposed trade — Hermes can
// propose, it can never execute.
//
// Session scoping: the X-Hermes-Session-Key header carries the user id
// resolved server-side from the session token (never from client input), so
// Hermes memory stays per user.

const hermesClient = require('./hermes-client');
const { chartSnapshot } = require('./fallback-analysis');

// The exact JSON shape Hermes is asked to return.
const ANALYSIS_SCHEMA = {
  chart_summary: 'string — 2-3 sentences describing the chart',
  strategy_match: {
    matched: 'boolean',
    criteria_hit: 'array of strings',
    criteria_missed: 'array of strings',
  },
  backtest_accuracy: {
    win_rate: 'number or null — quote exactly from the data provided',
    wins: 'number or null',
    losses: 'number or null',
    sample_size: 'number or null',
  },
  reasoning_text: 'string — plain trader-language explanation',
  proposed_trade:
    'null, or { symbol, direction: "long"|"short", entry, stop, target, risk_percent, rationale }',
};

function buildSystemPrompt(profile, backtestStats) {
  const risk = profile.risk_tolerance || {};
  const stats = backtestStats || {};
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
        win_rate: stats.win_rate ?? null,
        wins: stats.wins ?? null,
        losses: stats.losses ?? null,
        sample_size: stats.sample_size ?? null,
      },
      null,
      2,
    ),
    '',
    `Risk limits the user has configured: max risk per trade ` +
      `${risk.max_risk_percent ?? 2}%, max daily loss ` +
      `${risk.max_daily_loss_percent ?? 5}%.`,
    'Never propose a trade whose risk_percent exceeds max risk per trade.',
    '',
    'Your entire reply must be EXACTLY ONE JSON object. No markdown fences,',
    'no preamble, no trailing prose. It must match this schema:',
    JSON.stringify(ANALYSIS_SCHEMA, null, 2),
    '',
    'Rules:',
    '- chart_summary: what you see on the chart (trend, key levels, indicator readings) in 2-3 sentences.',
    '- strategy_match: whether this setup matches the user\'s strategy, and exactly which criteria hit and which missed.',
    '- backtest_accuracy: quote win_rate/wins/losses/sample_size EXACTLY as provided above; use null when a field is missing.',
    '- reasoning_text: explain your conclusion in plain language, the way an experienced trader would explain a trade to a student.',
    '- proposed_trade: null unless the setup matches the user\'s strategy; otherwise an object with symbol, direction, entry, stop, target, risk_percent, rationale.',
    'Return valid JSON only.',
  ].join('\n');
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
  return lines.join('\n');
}

// Extract the first JSON object from a reply, tolerating markdown fences and
// trailing prose. Returns null when no valid JSON object is found.
function parseAnalysisJson(reply) {
  const text = String(reply || '');
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.unshift(fenced[1]);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      if (value && typeof value === 'object') return value;
    } catch {
      // fall through to next candidate
    }
    // Try slicing the first balanced {...} block.
    const start = candidate.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      let end = -1;
      for (let i = start; i < candidate.length; i++) {
        if (candidate[i] === '{') depth++;
        else if (candidate[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end !== -1) {
        try {
          const value = JSON.parse(candidate.slice(start, end));
          if (value && typeof value === 'object') return value;
        } catch {
          // keep trying
        }
      }
    }
  }
  return null;
}

// Validate/normalize the parsed Hermes analysis into the pipeline's contract.
function normalizeAnalysis(parsed, symbol, backtestStats) {
  const trade = parsed.proposed_trade && typeof parsed.proposed_trade === 'object'
    ? parsed.proposed_trade
    : null;
  const proposed_trade =
    trade &&
    trade.symbol &&
    (trade.direction === 'long' || trade.direction === 'short') &&
    Number.isFinite(Number(trade.entry)) &&
    Number.isFinite(Number(trade.stop)) &&
    Number.isFinite(Number(trade.target)) &&
    Number.isFinite(Number(trade.risk_percent))
      ? {
          symbol: String(trade.symbol).toUpperCase(),
          direction: trade.direction,
          entry: Number(trade.entry),
          stop: Number(trade.stop),
          target: Number(trade.target),
          risk_percent: Number(trade.risk_percent),
          rationale: trade.rationale ? String(trade.rationale) : 'No rationale provided.',
        }
      : null;

  const match = parsed.strategy_match && typeof parsed.strategy_match === 'object'
    ? parsed.strategy_match
    : null;

  const accuracy = parsed.backtest_accuracy && typeof parsed.backtest_accuracy === 'object'
    ? parsed.backtest_accuracy
    : null;

  return {
    chart_summary: String(parsed.chart_summary || ''),
    strategy_match: match && typeof match.matched === 'boolean'
      ? {
          matched: Boolean(match.matched),
          criteria_hit: Array.isArray(match.criteria_hit) ? match.criteria_hit.map(String) : [],
          criteria_missed: Array.isArray(match.criteria_missed) ? match.criteria_missed.map(String) : [],
        }
      : {
          matched: proposed_trade != null,
          criteria_hit: [],
          criteria_missed: [],
        },
    backtest_accuracy: accuracy
      ? {
          win_rate: Number.isFinite(Number(accuracy.win_rate)) ? Number(accuracy.win_rate) : null,
          wins: Number.isFinite(Number(accuracy.wins)) ? Number(accuracy.wins) : null,
          losses: Number.isFinite(Number(accuracy.losses)) ? Number(accuracy.losses) : null,
          sample_size: Number.isFinite(Number(accuracy.sample_size)) ? Number(accuracy.sample_size) : null,
        }
      : {
          win_rate: backtestStats.win_rate ?? null,
          wins: backtestStats.wins ?? null,
          losses: backtestStats.losses ?? null,
          sample_size: backtestStats.sample_size ?? null,
        },
    reasoning_text: String(parsed.reasoning_text || parsed.chart_summary || ''),
    proposed_trade,
    llm: 'hermes',
  };
}

/**
 * Analyze a chart via Hermes. Returns { ok: true, analysis } or
 * { ok: false, reason } when the backend is unavailable or the reply is not
 * valid JSON.
 */
async function analyzeWithHermes({
  symbol,
  timeframe,
  chart,
  profile,
  backtestStats,
  accountState,
  user_id = 'anonymous',
}) {
  if (!hermesClient.isConfigured()) {
    return { ok: false, reason: 'Hermes API server not configured' };
  }
  try {
    const { reply } = await hermesClient.chat({
      message: buildUserContent({ symbol, timeframe, chart, accountState }),
      history: [],
      session_id: `analyze-${symbol}-${timeframe}`,
      user_id,
      system_prompt: buildSystemPrompt(profile, backtestStats),
    });
    const parsed = parseAnalysisJson(reply);
    if (!parsed) {
      return {
        ok: false,
        reason: `Hermes reply was not valid JSON: ${String(reply).slice(0, 200)}`,
      };
    }
    return { ok: true, analysis: normalizeAnalysis(parsed, symbol, backtestStats) };
  } catch (err) {
    return { ok: false, reason: `Hermes analysis call failed: ${err.message}` };
  }
}

module.exports = { analyzeWithHermes, parseAnalysisJson };
