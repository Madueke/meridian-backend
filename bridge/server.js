#!/usr/bin/env node
// bridge/server.js — MT5 bridge service.
//
// The backend (lib/mt5-bridge.js) and the MT5 MCP server talk to this
// service via MT5_BACKEND_URL. It is the ONLY place that touches a broker
// terminal. Two modes (MT5_BRIDGE_MODE):
//
//   sim         (default here) — deterministic demo. Account state is derived
//               from the account number (stable, no fabricated positions),
//               and execute records the trade to data/sim_trades.jsonl.
//               Every response is flagged simulation:true so nobody mistakes
//               it for a real fill.
//
//   metaquotes  — REAL mode. Requires a Windows host with the MetaTrader5
//                 terminal + the MetaTrader5 Python package; every call
//                 spawns bridge/mt5_real.py. On a non-Windows host this mode
//                 refuses to run rather than fabricate a fill.
//
// TRADING MODE: this service never performs on-screen automation. It only
// talks to MT5 over the terminal's public Python API. Credentials arrive
// from the backend (already decrypted), are used for the call, and are never
// logged or returned in any response.

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PORT = Number(process.env.MT5_BRIDGE_PORT || process.env.PORT || 8643);
const MODE = (process.env.MT5_BRIDGE_MODE || 'off').toLowerCase();
const SIM_TRADES_FILE = path.join(__dirname, '..', 'data', 'sim_trades.jsonl');

const app = express();
app.use(express.json({ limit: '2mb' }));

const SIMULATION = MODE === 'sim';

function simState(credentials) {
  // Deterministic, stable per account number — never fabricated positions.
  const accountNumber = String(credentials && credentials.account_number || '0');
  let h = 0;
  for (let i = 0; i < accountNumber.length; i++) {
    h = (h * 31 + accountNumber.charCodeAt(i)) >>> 0;
  }
  const balance = 10000 + (h % 240000); // $10k–$250k
  const float = (h % 997) / 1000 - 0.4; // −0.4%..+0.6%
  return {
    available: true,
    simulation: true,
    balance: Math.round(balance * 100) / 100,
    equity: Math.round(balance * (1 + float) * 100) / 100,
    open_positions: [],
    history: [],
  };
}

function simExecute(order) {
  const id = 'SIM-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const entry = {
    trade_id: id,
    simulation: true,
    executed: true,
    order: {
      symbol: String(order.symbol || '').toUpperCase(),
      direction: String(order.direction || ''),
      entry: Number(order.entry),
      stop: Number(order.stop),
      target: Number(order.target),
      risk_percent: Number(order.risk_percent),
    },
    executed_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(SIM_TRADES_FILE), { recursive: true });
  fs.appendFileSync(SIM_TRADES_FILE, JSON.stringify(entry) + '\n');
  return entry;
}

function realCall(kind, payload) {
  // Real mode requires the MetaTrader5 Python package on Windows. Refuse to
  // fabricate anything on hosts where the terminal cannot exist.
  if (process.platform !== 'win32') {
    return {
      error: true,
      reason:
        'MT5 real bridge requires a Windows host with MetaTrader5 + the ' +
        'MetaTrader5 Python package (MT5_BRIDGE_MODE=sim on this host).',
    };
  }
  const script = path.join(__dirname, 'mt5_real.py');
  const res = spawnSync('python', [script, kind, JSON.stringify(payload)], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (res.error) return { error: true, reason: `Failed to run MT5 helper: ${res.error.message}` };
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { error: true, reason: `MT5 helper returned invalid output: ${String(res.stderr || res.stdout).slice(0, 300)}` };
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', mode: MODE, simulation: SIMULATION });
});

// POST /account-state  { credentials: { account_number, password, broker_server } }
app.post('/account-state', (req, res) => {
  const { credentials } = req.body || {};
  if (MODE === 'off') {
    return res.status(503).json({
      available: false,
      reason: 'MT5 bridge is off (set MT5_BRIDGE_MODE=sim or metaquotes)',
    });
  }
  if (SIMULATION) return res.json(simState(credentials));
  const out = realCall('account_state', credentials);
  if (out.error) return res.status(503).json({ available: false, reason: out.reason });
  return res.json({
    available: true,
    balance: out.balance,
    equity: out.equity ?? out.balance,
    open_positions: Array.isArray(out.open_positions) ? out.open_positions : [],
    history: Array.isArray(out.history) ? out.history : [],
  });
});

// POST /execute  { order: {...}, credentials: {...} }
app.post('/execute', (req, res) => {
  const { order, credentials } = req.body || {};
  if (!order || typeof order !== 'object') {
    return res.status(400).json({ executed: false, reason: 'order is required' });
  }
  if (MODE === 'off') {
    return res.status(503).json({
      executed: false,
      reason: 'MT5 bridge is off (set MT5_BRIDGE_MODE=sim or metaquotes)',
    });
  }
  if (SIMULATION) return res.json(simExecute(order));
  const out = realCall('execute', { order, credentials });
  if (out.error) return res.status(503).json({ executed: false, reason: out.reason });
  return res.json({
    executed: out.executed === true,
    trade_id: out.trade_id,
    reason: out.reason,
  });
});

app.listen(PORT, () => {
  console.log(
    `[mt5-bridge] listening on :${PORT} mode=${MODE} simulation=${SIMULATION}`,
  );
});
