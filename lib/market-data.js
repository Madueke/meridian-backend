// market-data.js — read-only public chart data with a short cache.
//
// Primary source is Yahoo Finance's public chart API (works for FX, metals,
// indices and crypto without any credentials). Binance public klines are the
// fallback for crypto symbols. Responses are cached for 45s to avoid
// rate-limit issues on frequent polling. No login, no scraping of a logged-in
// TradingView session.

const https = require('https');

const CACHE_TTL_MS = 45 * 1000;
const cache = new Map();

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const YAHOO_INTERVAL = {
  M1: '1m', M5: '5m', M15: '15m', M30: '30m',
  H1: '1h', H4: '4h', D1: '1d', W1: '1wk',
};
const YAHOO_RANGE = {
  M1: '1d', M5: '5d', M15: '5d', M30: '5d',
  H1: '5d', H4: '1mo', D1: '1y', W1: '5y',
};
const BINANCE_INTERVAL = {
  M1: '1m', M5: '5m', M15: '15m', M30: '30m',
  H1: '1h', H4: '4h', D1: '1d', W1: '1w',
};

// Yahoo symbols: FX/metals use `XXXYYY=X`, crypto uses `XXX-USD`, and a few
// well-known index/commodity tickers are mapped explicitly.
const YAHOO_INDEX_MAP = {
  US500: '^GSPC', SPX: '^GSPC', 'S&P500': '^GSPC',
  US30: '^DJI', DJI: '^DJI',
  NAS100: '^IXIC', US100: '^IXIC', NDX: '^IXIC',
  USOIL: 'CL=F', WTI: 'CL=F', GOLD: 'GC=F', SILVER: 'SI=F',
  // Spot gold/silver are not on Yahoo's =X endpoints; the futures proxies
  // track them closely and are the standard substitute here.
  XAUUSD: 'GC=F', XAGUSD: 'SI=F',
};
const CRYPTO_BASES = ['BTC', 'ETH', 'XRP', 'LTC', 'SOL', 'ADA', 'DOGE', 'DOT', 'LINK', 'AVAX', 'MATIC', 'BNB'];

function toYahooSymbol(symbol) {
  const s = symbol.toUpperCase();
  if (YAHOO_INDEX_MAP[s]) return YAHOO_INDEX_MAP[s];
  const base = s.length > 3 ? s.slice(0, 3) : s;
  if (CRYPTO_BASES.includes(base) || s.startsWith('BTC') || s.startsWith('ETH')) {
    const b = s.length >= 6 ? s.slice(0, s.length - 3) : base;
    return `${b}-USD`;
  }
  if (/^[A-Z]{6}$/.test(s)) return `${s}=X`;
  return s;
}

function toBinanceSymbol(symbol) {
  const s = symbol.toUpperCase();
  if (s.endsWith('USD')) {
    const base = s.slice(0, -3);
    if (CRYPTO_BASES.includes(base)) return `${base}USDT`;
    return `${base}USDT`; // FX pairs exist on Binance as e.g. EURUSDT
  }
  return s;
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Bad JSON from ${url}: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

async function fromYahoo(symbol, timeframe) {
  const interval = YAHOO_INTERVAL[timeframe];
  const range = YAHOO_RANGE[timeframe];
  if (!interval || !range) throw new Error(`Unsupported timeframe ${timeframe}`);
  const ySymbol = toYahooSymbol(symbol);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}` +
    `?interval=${interval}&range=${range}`;
  const json = await getJson(url, {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  });
  const result = json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.timestamp || !result.indicators || !result.indicators.quote) {
    throw new Error(`No data for ${symbol} (${ySymbol}) from Yahoo`);
  }
  const quote = result.indicators.quote[0];
  const candles = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const o = quote.open[i];
    const h = quote.high[i];
    const l = quote.low[i];
    const c = quote.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({
      time: result.timestamp[i] * 1000,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: quote.volume[i] != null ? quote.volume[i] : 0,
    });
  }
  if (candles.length === 0) throw new Error(`No candles for ${symbol}`);
  return { symbol, timeframe, source: 'yahoo', candles };
}

async function fromBinance(symbol, timeframe) {
  const interval = BINANCE_INTERVAL[timeframe];
  if (!interval) throw new Error(`Unsupported timeframe ${timeframe}`);
  const bSymbol = toBinanceSymbol(symbol);
  const url =
    `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(bSymbol)}` +
    `&interval=${interval}&limit=400`;
  const json = await getJson(url);
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error(`No data for ${symbol} (${bSymbol}) from Binance`);
  }
  const candles = json.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
  return { symbol, timeframe, source: 'binance', candles };
}

/**
 * Fetch candles for a symbol/timeframe, cached for 45s. Yahoo first,
 * Binance as a crypto fallback.
 */
async function fetchCandles(symbol, timeframe) {
  const key = `${symbol}:${timeframe}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  let result;
  try {
    result = await fromYahoo(symbol, timeframe);
  } catch (yahooErr) {
    try {
      result = await fromBinance(symbol, timeframe);
    } catch (binanceErr) {
      throw new Error(`Market data unavailable for ${symbol} ${timeframe}: ` +
        `yahoo (${yahooErr.message}); binance (${binanceErr.message})`);
    }
  }
  cache.set(key, { at: Date.now(), data: result });
  return result;
}

/** Drop the cache (mainly for tests). */
function clearCache() {
  cache.clear();
}

module.exports = { fetchCandles, clearCache };
