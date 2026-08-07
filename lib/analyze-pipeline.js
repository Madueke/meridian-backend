// analyze-pipeline.js — the POST /analyze pipeline.
//
//  1. Load the user's strategy profile (encrypted at rest) + latest backtest
//  2. Fetch live chart data for symbol/timeframe (cached 45s)
//  3. Fetch live MT5 account state (read-only)
//  4. Hermes: chart summary, setup match, quoted backtest stats, reasoning,
//     trade proposal (strict JSON) — or deterministic fallback
//  5. If auto_execute is on AND a trade was proposed: hard-coded risk gate,
//     then server-side MT5 execution; rejected trades return analysis only
//  6. If auto_execute is off: analysis only, flagged "awaiting your decision"
//  7. Log everything to the per-user journal
//
// TRADING MODE: the only execution path is server-side through the MT5
// bridge after the risk gate. No device automation, ever.

const store = require('./store');
const strategyStore = require('./strategy-store');
const marketData = require('./market-data');
const mt5Bridge = require('./mt5-bridge');
const { riskGate } = require('./risk-gate');
const { dailyUsage } = require('./daily-usage');
const hermesClient = require('./hermes-client');
const { analyzeWithHermes } = require('./hermes-analyze');
const { fallbackAnalysis } = require('./fallback-analysis');

const { v4: uuidv4 } = require('uuid');

function getCredentials(userId) {
  const cred = store.get('mt5_credentials', userId);
  if (!cred || !cred.enc) return null;
  const { encrypt, decrypt } = require('./crypto-utils');
  try {
    return decrypt(cred.enc);
  } catch {
    return null;
  }
}

function isAutoExecuteEnabled(userId) {
  const settings = store.get('settings', userId);
  return settings ? settings.auto_execute === true : false;
}

/** Run the backtest engine for a user's current profile. */
async function runBacktestForUser(profile) {
  const { runBacktest } = require('./backtest-engine');
  return runBacktest(profile, async (symbol, timeframe) => {
    // fetchFor resolves the candle array; market-data errors are collected
    // by the engine per combo.
    const data = await marketData.fetchCandles(symbol, timeframe);
    return data.candles;
  });
}

/**
 * Main entry point. Returns the full response object per the documented
 * contract. Throws { status, error } for client errors (no strategy etc.).
 */
async function runAnalyze({ user_id, symbol, timeframe }) {
  if (!user_id) throw { status: 400, error: 'user_id is required' };
  if (!symbol || !timeframe) throw { status: 400, error: 'symbol and timeframe are required' };

  const profile = strategyStore.getProfile(user_id);
  if (!profile) {
    throw {
      status: 400,
      error: 'No strategy profile found. Save one via POST /strategy first.',
    };
  }

  // 2. Live chart data.
  const chart = await marketData.fetchCandles(symbol, timeframe);

  // 3. Live MT5 account state.
  const credentials = getCredentials(user_id);
  const accountState = await mt5Bridge.getAccountState(credentials);

  // 4. Hermes (when configured) or deterministic fallback.
  let analysis;
  if (hermesClient.isConfigured()) {
    const llm = await analyzeWithHermes({
      symbol,
      timeframe,
      chart,
      profile: profile.profile,
      backtestStats: profile.backtest,
      accountState,
      user_id,
    });
    analysis = llm.ok
      ? llm.analysis
      : fallbackAnalysis({
          symbol,
          timeframe,
          chart,
          profile: profile.profile,
          backtestStats: profile.backtest,
          accountState,
        });
  } else {
    analysis = fallbackAnalysis({
      symbol,
      timeframe,
      chart,
      profile: profile.profile,
      backtestStats: profile.backtest,
      accountState,
    });
  }

  // 5/6. Risk gate + execution (or awaiting-decision flag).
  const autoExecute = isAutoExecuteEnabled(user_id);
  const usage = dailyUsage(accountState);
  let actionTaken;

  if (!analysis.proposed_trade) {
    actionTaken = {
      executed: false,
      risk_gate_result: {
        approved: false,
        reason: 'No trade proposed — setup did not match.',
      },
    };
  } else {
    const gate = riskGate(
      analysis.proposed_trade,
      profile.profile,
      accountState,
      usage,
    );
    if (!autoExecute) {
      actionTaken = {
        executed: false,
        awaiting_decision: true,
        risk_gate_result: gate,
      };
    } else if (!gate.approved) {
      actionTaken = {
        executed: false,
        risk_gate_result: gate,
      };
    } else {
      const credentials = getCredentials(user_id);
      const result = await mt5Bridge.executeTrade(analysis.proposed_trade, credentials);
      actionTaken = {
        executed: result.executed,
        trade_details: result.executed
          ? { trade_id: result.trade_id, symbol, timeframe }
          : null,
        risk_gate_result: gate,
        execution_reason: result.reason,
      };
    }
  }

  // 7. Journal entry.
  const entry = {
    id: uuidv4(),
    user_id,
    timestamp: new Date().toISOString(),
    symbol,
    timeframe,
    analysis: {
      chart_summary: analysis.chart_summary,
      strategy_match: analysis.strategy_match,
      reasoning_text: analysis.reasoning_text,
      llm: analysis.llm,
    },
    proposed_trade: analysis.proposed_trade,
    action_taken: actionTaken,
    auto_execute: autoExecute,
  };
  store.update('journal', user_id, (entries) => [entry, ...(entries || [])].slice(0, 500));

  return {
    chart_summary: analysis.chart_summary,
    strategy_match: analysis.strategy_match || {
      matched: analysis.proposed_trade != null,
      criteria_hit: [],
      criteria_missed: [],
    },
    backtest_accuracy: analysis.backtest_accuracy || {
      win_rate: profile.backtest ? profile.backtest.win_rate : 0,
      wins: profile.backtest ? profile.backtest.wins : 0,
      losses: profile.backtest ? profile.backtest.losses : 0,
      sample_size: profile.backtest ? profile.backtest.sample_size : 0,
    },
    reasoning_text: analysis.reasoning_text,
    proposed_trade: analysis.proposed_trade,
    action_taken: actionTaken,
    journal_id: entry.id,
    llm: analysis.llm,
  };
}

module.exports = { runAnalyze, runBacktestForUser };
