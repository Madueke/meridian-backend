// routes/watchlist.js — user watchlist endpoints for the Home screen.
//
//   GET /watchlist/prices          live quotes for user's watchlist symbols
//   GET /watchlist/signals         latest analyzed signals for watchlist
//   POST /watchlist/signals/refresh  trigger fresh analysis for all symbols
//   GET /briefing                  daily AI market briefing
//   GET /account/summary           stat cards: open trades, risk used, P/L, health
//
// All endpoints are per-user (Bearer token) and read from the user's
// TradingView connection for their watchlist symbols/timeframes.
//
// TRADING MODE: read-only research. No execution.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../lib/require-auth');
const store = require('../lib/store');
const { runAnalyze, getCredentials } = require('../lib/analyze-pipeline');
const marketData = require('../lib/market-data');
const mt5Bridge = require('../lib/mt5-bridge');
const hermesClient = require('../lib/hermes-client');

// GET /watchlist/prices — returns live quotes for user's watchlist
router.get('/prices', requireAuth, async (req, res, next) => {
  try {
    const userId = req.userId;
    const connections = store.get('connections', userId) || {};
    const tv = connections.tradingview;
    if (!tv || !tv.symbols || tv.symbols.length === 0) {
      return res.json({ quotes: [], message: 'No TradingView watchlist configured' });
    }
    const symbols = tv.symbols.map(String);
    const timeframe = tv.timeframes?.[0] || 'M15';

    // Use the batch endpoint logic
    const results = await Promise.allSettled(
      symbols.map(async (symbol) => {
        const data = await marketData.fetchCandles(symbol, timeframe);
        const closes = data.candles.map((c) => c.close);
        const highs = data.candles.map((c) => c.high);
        const lows = data.candles.map((c) => c.low);
        const { indicators } = require('../lib/indicators');
        const snap = indicators.lastSnapshot({ closes, highs, lows });
        const last = closes[closes.length - 1];
        const prevIndex = closes.length - 1 - 24;
        const prev = prevIndex >= 0 ? closes[prevIndex] : null;
        const changePercent = prev ? ((last - prev) / prev) * 100 : 0;
        return {
          status: 'ok',
          symbol: data.symbol,
          timeframe: data.timeframe,
          source: data.source,
          last_close: snap.last_close,
          change_percent: Math.round(changePercent * 1e4) / 1e4,
          rsi_14: snap.rsi_14,
          ema20: snap.ema20,
          ema50: snap.ema50,
          macd: snap.macd,
          macd_histogram: snap.macd_histogram,
          atr_14: snap.atr_14,
          spark: data.candles.slice(-32).map((c) => [c.open, c.high, c.low, c.close]),
          at: new Date().toISOString(),
        };
      }),
    );

    const quotes = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { status: 'error', symbol: symbols[i], error: r.reason?.message || 'fetch failed' },
    );

    res.json({ quotes });
  } catch (err) {
    next(err);
  }
});

// GET /watchlist/signals — returns stored latest signals for watchlist symbols
router.get('/signals', requireAuth, async (req, res, next) => {
  try {
    const userId = req.userId;
    const connections = store.get('connections', userId) || {};
    const tv = connections.tradingview;
    if (!tv || !tv.symbols || tv.symbols.length === 0) {
      return res.json({ signals: [], message: 'No TradingView watchlist configured' });
    }

    const stored = store.get('watchlist_signals', userId) || {};
    const signals = tv.symbols.map((symbol) => stored[symbol] || null).filter(Boolean);
    res.json({ signals, updated_at: stored._updated_at || null });
  } catch (err) {
    next(err);
  }
});

// POST /watchlist/signals/refresh — trigger fresh analysis for all watchlist symbols
// This can be called on-demand (pull-to-refresh) or by a scheduler.
router.post('/signals/refresh', requireAuth, async (req, res, next) => {
  try {
    const userId = req.userId;
    const connections = store.get('connections', userId) || {};
    const tv = connections.tradingview;
    if (!tv || !tv.symbols || tv.symbols.length === 0) {
      return res.status(400).json({ error: 'No TradingView watchlist configured' });
    }

    const symbols = tv.symbols.map(String);
    const timeframe = tv.timeframes?.[0] || 'H1'; // Use H1 for signal analysis

    const results = await Promise.allSettled(
      symbols.map(async (symbol) => {
        try {
          const result = await runAnalyze({ user_id: userId, symbol, timeframe });
          // Transform to the signal format the app expects
          if (result.proposed_trade) {
            const t = result.proposed_trade;
            return {
              symbol,
              timeframe,
              pair: formatPair(symbol),
              bias: t.direction.toUpperCase(),
              entry: t.entry,
              stopLoss: t.stop,
              takeProfit: t.target,
              riskPercent: t.risk_percent,
              riskReward: t.target && t.entry && t.stop
                ? Math.abs((t.target - t.entry) / (t.entry - t.stop))
                : null,
              confidence: result.strategy_match?.matched ? 75 : 50,
              confidenceReason: result.reasoning_text || '',
              marketStructure: result.chart_summary || '',
              liquidity: '',
              trend: '',
              newsImpact: '',
              strategyMatch: result.strategy_match?.matched
                ? 'Matches your strategy'
                : 'Partial match',
              backtestAccuracy: result.backtest_accuracy || null,
              journalId: result.journal_id,
              proposedAt: new Date().toISOString(),
            };
          }
          // No trade proposed — return a neutral signal
          return {
            symbol,
            timeframe,
            pair: formatPair(symbol),
            bias: 'NEUTRAL',
            entry: null,
            stopLoss: null,
            takeProfit: null,
            riskPercent: 0,
            riskReward: null,
            confidence: 0,
            confidenceReason: result.reasoning_text || 'No setup matched your strategy.',
            marketStructure: result.chart_summary || '',
            liquidity: '',
            trend: '',
            newsImpact: '',
            strategyMatch: 'No match',
            backtestAccuracy: result.backtest_accuracy || null,
            journalId: result.journal_id,
            proposedAt: new Date().toISOString(),
          };
        } catch (e) {
          return {
            symbol,
            timeframe,
            pair: formatPair(symbol),
            bias: 'ERROR',
            error: e.message || 'Analysis failed',
            proposedAt: new Date().toISOString(),
          };
        }
      }),
    );

    const signals = results.map((r) =>
      r.status === 'fulfilled' ? r.value : { error: r.reason?.message },
    );

    // Store for future reads
    const stored = {};
    for (const s of signals) {
      if (s.symbol) stored[s.symbol] = s;
    }
    stored._updated_at = new Date().toISOString();
    store.set('watchlist_signals', userId, stored);

    res.json({ signals, count: signals.length });
  } catch (err) {
    next(err);
  }
});

// GET /briefing — daily AI market briefing across watchlist
router.get('/briefing', requireAuth, async (req, res, next) => {
  try {
    const userId = req.userId;
    const connections = store.get('connections', userId) || {};
    const tv = connections.tradingview;
    const credentials = getCredentials(userId);
    const accountState = await mt5Bridge.getAccountState(credentials);

    // Check for cached briefing (less than 12h old)
    const stored = store.get('daily_briefing', userId);
    if (stored && stored.text && stored.generated_at) {
      const ageHours = (Date.now() - new Date(stored.generated_at).getTime()) / 3.6e6;
      if (ageHours < 12) {
        return res.json(stored);
      }
    }

    // Generate fresh briefing via Hermes
    let briefingText;
    if (hermesClient.isConfigured()) {
      const symbols = tv?.symbols?.slice(0, 5) || ['XAUUSD', 'BTCUSD', 'ETHUSD', 'NAS100'];
      const prompt = `Write a concise morning market briefing (2-3 paragraphs) for a trader watching: ${symbols.join(', ')}. 
Use current market context. Mention key levels, risk events, and overall bias. 
No fluff. No markdown. Plain text only.`;
      try {
        const reply = await hermesClient.chat(prompt, userId);
        briefingText = reply.trim();
      } catch {
        briefingText = 'Briefing generation failed — check connectivity.';
      }
    } else {
      briefingText = 'Hermes not configured — no AI briefing available.';
    }

    const result = {
      text: briefingText,
      generated_at: new Date().toISOString(),
      symbols: tv?.symbols || [],
    };
    store.set('daily_briefing', userId, result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /account/summary — stat cards for Home: open trades, risk used, daily P/L, health
router.get('/account/summary', requireAuth, async (req, res, next) => {
  try {
    const userId = req.userId;
    const credentials = getCredentials(userId);
    const accountState = await mt5Bridge.getAccountState(credentials);

    if (!accountState.available) {
      return res.json({
        connected: false,
        message: 'No MT5 account connected',
        openTrades: 0,
        riskUsedPercent: 0,
        dailyPLPercent: 0,
        health: 0,
      });
    }

    // Open trades count
    const openPositions = Array.isArray(accountState.open_positions)
      ? accountState.open_positions
      : [];
    const openTrades = openPositions.length;

    // Daily P/L from equity vs balance
    const balance = accountState.balance || 0;
    const equity = accountState.equity || balance;
    const dailyPL = balance > 0 ? ((equity - balance) / balance) * 100 : 0;

    // Risk used: sum of risk on open positions vs max_risk_percent
    const profile = require('../lib/strategy-store').getProfile(userId);
    const maxRiskPerTrade = profile?.profile?.risk_tolerance?.max_risk_percent || 2;
    const maxDailyLoss = profile?.profile?.risk_tolerance?.max_daily_loss_percent || 5;
    let riskUsed = 0;
    if (openPositions.length > 0 && balance > 0) {
      for (const pos of openPositions) {
        // Approximate risk from position size and stop distance
        // This is a simplification; real risk would need entry/stop from order
        const volume = pos.volume || pos.lot_size || 0;
        if (volume > 0) {
          // Rough estimate: 1 lot = 1% risk per 100 pips on standard account
          riskUsed += volume * 0.5; // Conservative estimate
        }
      }
    }
    const riskUsedPercent = maxRiskPerTrade > 0 ? Math.min(100, Math.round((riskUsed / maxRiskPerTrade) * 100)) : 0;

    // Health: composite metric (0-100)
    // Factors: connected (20), within daily loss limit (30), risk used reasonable (25), no margin issues (25)
    let health = 0;
    health += 20; // connected
    health += dailyPL > -maxDailyLoss ? 30 : Math.max(0, 30 + (dailyPL + maxDailyLoss) * 3);
    health += riskUsedPercent <= 80 ? 25 : Math.max(0, 25 - (riskUsedPercent - 80) * 0.5);
    // Margin level check (simplified)
    const marginLevel = balance > 0 ? (equity / balance) * 100 : 0;
    health += marginLevel > 200 ? 25 : Math.max(0, marginLevel / 8);
    health = Math.round(Math.min(100, Math.max(0, health)));

    res.json({
      connected: true,
      simulation: accountState.simulation === true,
      balance,
      equity,
      openTrades,
      riskUsedPercent,
      dailyPLPercent: Math.round(dailyPL * 100) / 100,
      health,
      marginLevel: Math.round(marginLevel),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

function formatPair(symbol) {
  // Convert XAUUSD -> XAU/USD, BTCUSD -> BTC/USDT, etc.
  if (symbol.length === 6) return `${symbol.slice(0, 3)}/${symbol.slice(3)}`;
  if (symbol === 'XAUUSD') return 'XAU/USD';
  if (symbol === 'XAGUSD') return 'XAG/USD';
  if (symbol === 'BTCUSD') return 'BTC/USDT';
  if (symbol === 'ETHUSD') return 'ETH/USDT';
  if (symbol === 'NAS100') return 'NAS100';
  if (symbol === 'US500') return 'US500';
  if (symbol === 'US30') return 'US30';
  return symbol;
}

module.exports = router;