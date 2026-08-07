# Hermes Agent integration (meridian-backend)

This backend runs its chat, analyze, train, tool, risk and alarm paths
through the local Hermes Agent v0.20.0 API server (`http://127.0.0.1:8642`,
pm2 app `hermes-gateway`). Hermes is the ONLY LLM backend: the legacy
Anthropic paths (`lib/claude.js`, `lib/neutral-pip-agent.js`) and the
`@anthropic-ai/sdk` dependency have been removed. `/chat` and `/train`
respond with a clear message when Hermes is unconfigured; `/analyze` falls
back to the deterministic `lib/fallback-analysis.js`.

## Wiring summary

| Concern | Where | Detail |
| --- | --- | --- |
| Chat | `routes/chat.js` → `lib/hermes-client.js` | Trade-capable turns use `POST /v1/runs` + SSE events (`runChat`); the sync `/v1/chat/completions` path is a fallback when the runs API is missing. |
| Analyze | `lib/analyze-pipeline.js` → `lib/hermes-analyze.js` | Hermes gets chart data + profile + backtest stats + account state and must reply with strict JSON (chart summary, strategy match, quoted backtest accuracy, reasoning, proposed trade). The proposed trade still goes through the hard-coded `risk-gate` before any server-side execution. `llm: 'hermes'` in the response. |
| Train | `routes/train.js` | Uploaded PDFs/images are converted to OpenAI content parts (text + base64 data URLs) and sent to Hermes, which proposes a strategy-profile update as strict JSON. `llm: 'hermes'`. |
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
6. **Retired env vars.** `CLAUDE_API_KEY`, `ANTHROPIC_MODEL` and
   `DEFAULT_CLAUDE_API_KEY` no longer drive any code path (`/chat`, `/analyze`,
   `/train` are Hermes-only). They can be removed from `.env`.

## Verification

Exact-memory proof (run after any wiring change):

1. Write a distinctive phrase directly to Hermes with the app's session-key
   format:
   `POST /v1/chat/completions` with `X-Hermes-Session-Key: user:test-verify-001`
   → "Remember this test phrase: zebra-crossing-4471".
2. Call `POST /chat` with a Bearer session token mapped to user
   `test-verify-001`, asking "What test phrase did I just ask you to remember?".
   The reply must recall `zebra-crossing-4471` verbatim — that proves the
   backend genuinely routes through the Hermes API server with correct
   session-key scoping (the old custom system could not know the phrase).
3. `/analyze` returns `llm: 'hermes'`; `/train` returns `llm: 'hermes'`.

Note: with Hermes unconfigured, `/chat` and `/train` return explicit
"no AI backend" messages and `/analyze` uses the deterministic fallback —
there is no silent second LLM path.
