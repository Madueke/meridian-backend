#!/usr/bin/env node
// mcp/mt5-server.js — MCP server exposing Neutral Pip's server-side MT5
// bridge to Hermes as native MCP tools (get_account_state, place_trade).
// TRADING MODE: execution happens server-side only via the MT5 bridge; the
// hard-coded risk gate runs in this process before any place_trade call and
// an LLM can never override it. No on-screen automation.
//
// Credentials are never accepted from tool arguments. The user's encrypted
// MT5 credentials are resolved from the backend store (same box, same
// STRATEGY_ENC_KEY) via an optional user_ref; when omitted, the backend's
// current default connected account is used. MT5_BACKEND_URL must be set for
// real calls — until then tools report clean "not configured" results.
// Load the backend .env explicitly — Hermes spawns this process directly and
// does not inherit the backend's environment, so MT5_BACKEND_URL and
// NP_DEFAULT_USER_ID would be missing without this.
require('dotenv').config({ path: '/home/ubuntu/meridian-backend/.env' });

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { resolveCredentials } = require('../lib/mt5-credentials');
const { riskGate } = require('../lib/risk-gate');
const { dailyUsage } = require('../lib/daily-usage');
const strategyStore = require('../lib/strategy-store');
const mt5Bridge = require('../lib/mt5-bridge');

// Machine-readable prefix the backend looks for in the approval event command
// to recognize this as a trade-approval request and parse the exact order.
const TRADE_APPROVAL_PREFIX = 'NP_TRADE_APPROVAL:';

const server = new McpServer({
  name: 'mt5-server',
  version: '1.0.0',
});

server.registerTool(
  'get_account_state',
  {
    title: 'Get MT5 account state',
    description:
      "Fetch the user's live MT5 account state: balance, equity, open positions and recent history. Read-only.",
    inputSchema: z.object({
      user_ref: z
        .string()
        .optional()
        .describe('Optional internal user reference. Omit to use the default connected account.'),
    }),
  },
  async ({ user_ref }) => {
    const { user_id, credentials, error } = resolveCredentials(user_ref);
    if (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ available: false, reason: error }) }] };
    }
    const state = await mt5Bridge.getAccountState(credentials);
    if (!state.available) {
      return { content: [{ type: 'text', text: JSON.stringify(state) }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            available: true,
            balance: state.balance,
            equity: state.equity,
            open_positions: Array.isArray(state.open_positions) ? state.open_positions.slice(0, 20) : [],
            recent_history: Array.isArray(state.history) ? state.history.slice(0, 10) : [],
          }),
        },
      ],
    };
  },
);

server.registerTool(
  'place_trade',
  {
    title: 'Place MT5 trade',
    description:
      'Execute a real trade through the MT5 bridge. The hard-coded risk gate evaluates the exact parameters first and rejects any trade that breaches risk rules, daily loss cap, or correlated exposure. Only valid when the account is available.',
    inputSchema: z.object({
      symbol: z.string().describe('Trading symbol'),
      direction: z.enum(['long', 'short']).describe('Trade direction'),
      entry: z.number().describe('Entry price'),
      stop: z.number().describe('Stop loss price'),
      target: z.number().describe('Take profit price'),
      risk_percent: z.number().describe('Risk as % of account balance'),
      user_ref: z
        .string()
        .optional()
        .describe('Optional internal user reference. Omit to use the default connected account.'),
    }),
  },
  async ({ symbol, direction, entry, stop, target, risk_percent, user_ref }) => {
    const order = { symbol, direction, entry, stop, target, risk_percent };
    const { user_id, credentials, error } = resolveCredentials(user_ref);
    if (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ executed: false, error }) }] };
    }

    // Approval gate: no trade executes without an explicit human approval.
    // In the Hermes API-server flow this surfaces as an approval.request SSE
    // event on the run stream; the backend parses the order from the message
    // (TRADE_APPROVAL_PREFIX), applies the risk gate, and approves or denies.
    // The riskGate below remains as defense-in-depth in this process, so an
    // LLM can never bypass it even if approval routing is misconfigured.
    const approvalMessage =
      `${TRADE_APPROVAL_PREFIX}${JSON.stringify({ order, user_id })}`;
    const requestedSchema = {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: order.symbol },
        direction: { type: 'string', description: order.direction },
        entry: { type: 'number', description: String(order.entry) },
        stop: { type: 'number', description: String(order.stop) },
        target: { type: 'number', description: String(order.target) },
        risk_percent: { type: 'number', description: `${order.risk_percent}% of account` },
      },
    };

    let approval;
    try {
      approval = await server.server.elicitInput({
        mode: 'form',
        message: `Approve trade execution?\n${approvalMessage}`,
        requestedSchema,
      });
    } catch (err) {
      console.error('[mt5-server] elicitation failed:', err.message);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              executed: false,
              reason: 'Trade approval could not be requested; trade not executed.',
            }),
          },
        ],
      };
    }
    if (!approval || approval.action !== 'accept') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ executed: false, reason: 'Trade not approved by user; not executed.' }),
          },
        ],
      };
    }

    const profile = strategyStore.getProfile(user_id);
    let accountState = null;
    try {
      accountState = await mt5Bridge.getAccountState(credentials);
    } catch {
      accountState = null;
    }

    const gate = riskGate(
      order,
      profile ? profile.profile : { risk_tolerance: {} },
      accountState,
      dailyUsage(accountState),
    );
    if (!gate.approved) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              executed: false,
              risk_gate_result: { reason: gate.reason, checks: gate.checks },
            }),
          },
        ],
      };
    }

    const result = await mt5Bridge.executeTrade(order, credentials);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            result.executed
              ? {
                  executed: true,
                  trade_id: result.trade_id,
                  message: `Trade executed: ${String(order.direction).toUpperCase()} ${order.symbol} entry ${order.entry}, stop ${order.stop}, target ${order.target}.`,
                }
              : { executed: false, reason: result.reason },
          ),
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mt5-server] connected (stdio)');
}

main().catch((err) => {
  console.error('[mt5-server] fatal:', err.message);
  process.exit(1);
});
