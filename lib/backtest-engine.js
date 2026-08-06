// backtest-engine.js — deterministic strategy backtest over real candles.
//
// The stored strategy `rules` are free text, so this engine maps the
// profile's indicators/keywords to a fixed set of entry templates and
// evaluates them candle-by-candle on historical data. Every number in the
// output is computed from real price data — never an LLM guess.
//
// Template logic (heuristic, expandable):
//   - Trend filter: EMA20 vs EMA50.
//   - Entry: RSI crossing/position, plus MACD confirmation when the profile
//     mentions MACD.
//   - Stop = entry ∓ 1.5×ATR, target = entry ± 2×ATR (R:R = 2). If a candle
//     touches both, the stop is assumed hit first (conservative).

const { ema, rsi, macd, atr } = require('./indicators');

const STOP_ATR = 1.5;
const TARGET_RR = 2;

function usesIndicator(profile, name) {
  const indicators = (profile.indicators || []).map((i) => i.toUpperCase());
  const rules = String(profile.rules || '').toUpperCase();
  return (
    indicators.includes(name) ||
    (name === 'MACD' && rules.includes('MACD'))
  );
}

/**
 * Evaluate one symbol/timeframe. Returns a per-combo result object or null
 * when there isn't enough data.
 */
function evaluateCombo(profile, symbol, timeframe, candles) {
  if (!candles || candles.length < 100) return null;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(highs, lows, closes, 14);
  const useMacd = usesIndicator(profile, 'MACD');
  const macdObj = useMacd ? macd(closes) : null;

  let wins = 0;
  let losses = 0;
  const sample = [];

  for (let i = 60; i < candles.length - 1; i++) {
    const e20 = ema20[i];
    const e50 = ema50[i];
    const r = rsi14[i];
    const rPrev = rsi14[i - 1];
    const a = atr14[i];
    if (e20 == null || e50 == null || r == null || rPrev == null || a == null) continue;

    let direction = 0;
    if (e20 > e50 && r > 50 && rPrev <= 50 && (r < 70)) {
      direction = 1; // long: uptrend + RSI crossing above 50
    } else if (e20 < e50 && r < 50 && rPrev >= 50 && (r > 30)) {
      direction = -1; // short: downtrend + RSI crossing below 50
    }
    if (direction === 0) continue;

    if (useMacd && macdObj) {
      const cross =
        macdObj.macd[i] != null && macdObj.signal[i] != null &&
        macdObj.macd[i - 1] != null && macdObj.signal[i - 1] != null;
      if (!cross) continue;
      const aligned =
        (direction === 1 && macdObj.macd[i] > macdObj.signal[i]) ||
        (direction === -1 && macdObj.macd[i] < macdObj.signal[i]);
      if (!aligned) continue;
    }

    // Enter on the next candle's open.
    const entry = candles[i + 1].open;
    const stop = direction === 1 ? entry - STOP_ATR * a : entry + STOP_ATR * a;
    const target = direction === 1 ? entry + TARGET_RR * STOP_ATR * a : entry - TARGET_RR * STOP_ATR * a;

    let outcome = null;
    let exitIndex = -1;
    for (let j = i + 1; j < candles.length; j++) {
      const { high, low } = candles[j];
      const stopHit = direction === 1 ? low <= stop : high >= stop;
      const targetHit = direction === 1 ? high >= target : low <= target;
      if (stopHit && targetHit) {
        outcome = 'loss'; // conservative: stop first
        exitIndex = j;
        break;
      }
      if (stopHit) {
        outcome = 'loss';
        exitIndex = j;
        break;
      }
      if (targetHit) {
        outcome = 'win';
        exitIndex = j;
        break;
      }
    }
    if (outcome == null) continue; // still open at data end — not scored

    if (outcome === 'win') wins += 1;
    else losses += 1;
    sample.push({ direction, entry, stop, target, outcome, opened_at: candles[i + 1].time });
    i = exitIndex; // skip ahead past the closed trade
  }

  if (sample.length === 0) return null;
  const total = sample.length;
  return {
    symbol,
    timeframe,
    wins,
    losses,
    sample_size: total,
    win_rate: Math.round((wins / total) * 1000) / 1000,
    avg_rr:
      Math.round(((wins * TARGET_RR - losses) / total) * 1000) / 1000,
  };
}

/**
 * Run the backtest across a user's preferred pairs × timeframes.
 * Returns { setup_id, wins, losses, sample_size, win_rate, avg_rr,
 *           last_run_at, per_combo, errors }.
 */
async function runBacktest(profile, fetchFor) {
  const pairs = (profile.preferred_pairs || []).slice(0, 8);
  const timeframes = (profile.timeframes || []).slice(0, 4);

  const perCombo = [];
  const errors = [];

  // Run combos serially so a failing market-data fetch doesn't abort the
  // whole run; fetchFor(symbol, timeframe) resolves candles.
  for (const symbol of pairs) {
    for (const timeframe of timeframes) {
      try {
        const candles = await fetchFor(symbol, timeframe);
        const combo = evaluateCombo(profile, symbol, timeframe, candles);
        if (combo) perCombo.push(combo);
      } catch (err) {
        errors.push({ symbol, timeframe, reason: err.message });
      }
    }
  }

  const wins = perCombo.reduce((sum, c) => sum + c.wins, 0);
  const losses = perCombo.reduce((sum, c) => sum + c.losses, 0);
  const sampleSize = wins + losses;
  const setupId =
    String(profile._version_id || 'v1') + ':' + pairs.join('+') || 'default';

  return {
    setup_id: setupId,
    wins,
    losses,
    sample_size: sampleSize,
    win_rate: sampleSize > 0 ? Math.round((wins / sampleSize) * 1000) / 1000 : 0,
    avg_rr: sampleSize > 0 ? Math.round(((wins * TARGET_RR - losses) / sampleSize) * 1000) / 1000 : 0,
    last_run_at: new Date().toISOString(),
    per_combo: perCombo,
    errors,
  };
}

module.exports = { runBacktest, evaluateCombo };
