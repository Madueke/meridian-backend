# Hermes Agent integration (meridian-backend)

This backend runs its chat, tool, risk and alarm paths through the local
Hermes Agent v0.20.0 API server (`http://127.0.0.1:8642`, pm2 app
`hermes-gateway`). The legacy Anthropic/neutral-pip-agent path is kept only
as a fallback for environments without Hermes.

## Wiring summary

| Concern | Where | Detail |
| --- | --- | --- |
| Chat | `routes/chat.js` → `lib/hermes-client.js` | Trade-capable turns use `POST /v1/runs` + SSE events (`runChat`); the sync `/v1/chat/completions` path is a fallback when the runs API is missing. |
| System prompt | `lib/hermes-client.js` `NEUTRAL_PIP_SYSTEM` | Layered on top of Hermes' core prompt. Deliberately omits the old hand-built tool names (chart/account/trade tools now arrive as MCP tools). |
| Chart data | `mcp/tradingview-server.js` | MCP tool `get_chart_data` over `lib/market-data.js`. |
| MT5 account/trade | `mcp/mt5-server.js` | MCP tools `get_account_state`, `place_trade`. `place_trade` requests an elicitation approval, then runs the hard-coded `risk-gate` before execution. |
| Risk gate | `lib/trade-approval.js` | Backend-side approve/deny decision for Hermes `approval.request` events (parses the order from the event command, runs `risk-gate`). Fails closed. |
| Approvals | `lib/hermes-client.js` `createRun`/`getRunEvents`/`resolveRunApproval` | Approval requests surface as `approval.request` SSE events on the run stream; the backend answers with `POST /v1/runs/{id}/approval`. |
| Alarms | `lib/hermes-alarms.js` + `lib/alarms.js` | One Hermes cron job per active user alarm; backend harvests job output files (`~/.hermes/cron/output/<job_id>/`) and queues push notifications. |

## Environment

`meridian-backend/.env`:
- `HERMES_API_SERVER_URL` / `HERMES_API_SERVER_KEY` — Hermes API server (key shared
  with `~/.hermes/.env` `API_SERVER_KEY`).
- `MT5_BACKEND_URL` — the MT5 bridge service; empty means tools report
  "not configured" cleanly (no execution).
- `NP_DEFAULT_USER_ID` — user whose MT5 account is used when an MCP tool call
  carries no `user_ref` (the LLM never supplies one).

`~/.hermes/.env`: `API_SERVER_ENABLED=true`, `API_SERVER_KEY=<same secret>`,
`API_SERVER_HOST=127.0.0.1`. MCP servers are registered in
`~/.hermes/config.yaml` (`tradingview-server`, `mt5-server`).

## Known risks / decisions

1. **Cross-user memory leak (must fix before production multi-user).**
   Hermes' built-in memory store is profile-global: `X-Hermes-Session-Key`
   does NOT scope long-term memory. Facts written by user A leak into user B's
   replies. Verified with a two-session test. Options: (a) enable Honcho
   (`memory.provider: honcho` + `HONCHO_API_KEY`, needs
   https://app.honcho.dev), (b) one Hermes profile per user, or (c) accept and
   document. Currently accepted for this single-box deployment.
2. **Approvals require the runs API.** `/v1/chat/completions` has no approval
   notify callback — any MCP elicitation there fails closed. Trade chat must
   stay on the `/v1/runs` path (it is).
3. **MCP subprocess env.** Hermes spawns MCP servers directly, so both
   `mcp/*-server.js` call `require('dotenv').config()` on the backend `.env`
   explicitly. Keep that line if new MCP servers are added.
4. **Store cache pitfall.** `lib/store.js` keeps an in-memory cache and
   persists the whole store on any write. Seeding the store file while the
   pm2 backend is running gets clobbered by the backend's next write.
   Restart `meridian-backend` after any out-of-band store edit.
5. **`routes/config.js` skills** still read `lib/hermes-memory.js` (custom
   SQLite). Migrate to Hermes native skills APIs before removing that module.
