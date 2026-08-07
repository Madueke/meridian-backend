#!/usr/bin/env node
// mcp/tradingview-server.js — MCP server exposing Neutral Pip's read-only
// chart data source (Yahoo Finance chart API with Binance fallback) to Hermes
// as native MCP tools.
// TRADING MODE: read-only market data only. No account access, no execution.
// Load the backend .env explicitly — Hermes spawns this process directly and
// does not inherit the backend's environment, so MT5/NP_* vars would be
// missing without this.
require('dotenv').config({ path: '/home/ubuntu/meridian-backend/.env' });

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const marketData = require('../lib/market-data');

const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];

const server = new McpServer({
  name: 'tradingview-server',
  version: '1.0.0',
});

server.registerTool(
  'get_chart_data',
  {
    title: 'Get chart data',
    description:
      'Fetch live OHLCV candles for a trading symbol and timeframe. Use before any price or chart analysis. Returns the current price, recent change, period high/low and the last 60 candles. Read-only public market data.',
    inputSchema: z.object({
      symbol: z
        .string()
        .describe('Trading symbol, e.g. EURUSD, XAUUSD, BTCUSD, US500, NAS100'),
      timeframe: z.enum(TIMEFRAMES).default('H1').describe('Candle timeframe'),
    }),
  },
  async ({ symbol, timeframe = 'H1' }) => {
    try {
      const data = await marketData.fetchCandles(symbol, timeframe);
      const candles = data.candles.slice(-60);
      const latest = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              symbol: data.symbol,
              timeframe: data.timeframe,
              source: data.source,
              current_price: latest.close,
              change: prev ? Math.round((latest.close - prev.close) * 100000) / 100000 : 0,
              period_high: Math.max(...candles.map((c) => c.high)),
              period_low: Math.min(...candles.map((c) => c.low)),
              candles: candles.map((c) => ({
                t: c.time,
                o: c.open,
                h: c.high,
                l: c.low,
                c: c.close,
                v: c.volume,
              })),
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[tradingview-server] connected (stdio)');
}

main().catch((err) => {
  console.error('[tradingview-server] fatal:', err.message);
  process.exit(1);
});
