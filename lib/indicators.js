// indicators.js — dependency-free technical indicators over a close array.
//
// Implemented from the standard formulas (Wilder smoothing for RSI/ATR) so
// the backend has no native dependencies. All functions return plain arrays
// aligned with the input, or a single value where noted.

/** Simple moving average. Returns array of length n with nulls padded. */
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average (standard seed = SMA of first period). */
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    seed += values[i];
    if (i === period - 1) {
      out[i] = seed / period;
    } else if (i > period - 1) {
      out[i] = values[i] * k + out[i - 1] * (1 - k);
    }
  }
  return out;
}

/** RSI (Wilder). Returns array of length n with nulls until warmup. */
function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * MACD (12/26/9). Returns { macd, signal, histogram } arrays aligned with
 * the input (nulls until warmup).
 */
function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null,
  );
  // Signal line is an EMA over the non-null segment of macdLine.
  const start = macdLine.findIndex((v) => v != null);
  const slice = macdLine.slice(start);
  const signalSlice = ema(slice, signalPeriod);
  const signal = new Array(values.length).fill(null);
  for (let i = 0; i < signalSlice.length; i++) {
    signal[start + i] = signalSlice[i];
  }
  const histogram = values.map(
    (_, i) =>
      macdLine[i] != null && signal[i] != null ? macdLine[i] - signal[i] : null,
  );
  return { macd: macdLine, signal, histogram };
}

/** Average True Range (Wilder). Returns array with nulls until warmup. */
function atr(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let trs = [];
  for (let i = 1; i <= period; i++) {
    trs.push(tr(highs[i], lows[i], closes[i - 1]));
  }
  let current = trs.reduce((a, b) => a + b, 0) / period;
  out[period] = current;
  for (let i = period + 1; i < closes.length; i++) {
    current = (current * (period - 1) + tr(highs[i], lows[i], closes[i - 1])) / period;
    out[i] = current;
  }
  return out;
}

function tr(h, l, prevClose) {
  return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
}

/**
 * Snapshot of every indicator at the last valid index. Returns plain
 * numbers ready to embed in a chart payload.
 */
function lastSnapshot({ closes, highs, lows }) {
  const last = closes.length - 1;
  const rsiArr = rsi(closes, 14);
  const macdObj = macd(closes);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atrArr = atr(highs, lows, closes, 14);

  const num = (arr, i) => (arr[i] == null ? null : Math.round(arr[i] * 1e8) / 1e8);

  return {
    last_close: num(closes, last),
    rsi_14: num(rsiArr, last),
    macd: num(macdObj.macd, last),
    macd_signal: num(macdObj.signal, last),
    macd_histogram: num(macdObj.histogram, last),
    ema20: num(ema20, last),
    ema50: num(ema50, last),
    atr_14: num(atrArr, last),
  };
}

module.exports = { sma, ema, rsi, macd, atr, lastSnapshot };
