// routes/market.js — live market data endpoints for the app.
//
//   GET /quote?symbol=&timeframe=&window=  latest price + indicator snapshot
//                                          + sparkline candles for the
//                                          watchlist / ticker
//   GET /chart?symbol=&timeframe=&limit=   OHLC candles for chart rendering
//
// Both reuse the cached public market-data fetch (Yahoo with a browser UA,
// Binance as the crypto fallback) so frequent app polling never hammers the
// upstream APIs directly. Read-only: no account state, no execution.
//
// TRADING MODE: these endpoints never place trades and never touch
// on-screen automation.

const express = require('express');
const marketData = require('../lib/market-data');
const indicators = require('../lib/indicators');

const quoteRouter = express.Router();
const chartRouter = express.Router();

const DEFAULT_TIMEFRAME = 'M15';
const SPARK_CANDLES = 32;

function requiredSymbol(req, res) {
  const { symbol } = req.query;
  if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
    res.status(400).json({ error: 'symbol is required' });
    return null;
  }
  return symbol.trim().toUpperCase();
}

function parseLimit(raw, fallback, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

// GET /quote?symbol=XAUUSD&timeframe=M15&window=24
quoteRouter.get('/', async (req, res, next) => {
  try {
    const symbol = requiredSymbol(req, res);
    if (!symbol) return;
    const timeframe = req.query.timeframe || DEFAULT_TIMEFRAME;
    const window = parseLimit(req.query.window, 24, 120);

    const data = await marketData.fetchCandles(symbol, timeframe);
    const closes = data.candles.map((c) => c.close);
    const highs = data.candles.map((c) => c.high);
    const lows = data.candles.map((c) => c.low);

    const snap = indicators.lastSnapshot({ closes, highs, lows });
    const last = closes[closes.length - 1];
    const prevIndex = closes.length - 1 - window;
    const prev = prevIndex >= 0 ? closes[prevIndex] : null;
    const changePercent = prev ? ((last - prev) / prev) * 100 : 0;

    res.json({
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
      spark: data.candles.slice(-SPARK_CANDLES).map((c) => [
        c.open,
        c.high,
        c.low,
        c.close,
      ]),
      at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(502).json({ status: 'error', error: err.message });
  }
});

// GET /chart?symbol=XAUUSD&timeframe=M15&limit=120
chartRouter.get('/', async (req, res, next) => {
  try {
    const symbol = requiredSymbol(req, res);
    if (!symbol) return;
    const timeframe = req.query.timeframe || DEFAULT_TIMEFRAME;
    const limit = parseLimit(req.query.limit, 120, 500);

    const data = await marketData.fetchCandles(symbol, timeframe);
    res.json({
      status: 'ok',
      symbol: data.symbol,
      timeframe: data.timeframe,
      source: data.source,
      candles: data.candles.slice(-limit),
    });
  } catch (err) {
    res.status(502).json({ status: 'error', error: err.message });
  }
});

module.exports = { quoteRouter, chartRouter };
