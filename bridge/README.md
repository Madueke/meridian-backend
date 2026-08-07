# MT5 Bridge

A small HTTP service that is the **only** place a broker terminal is touched.
The backend (`MT5_BACKEND_URL`) and the MT5 MCP server both call it.

```
POST /account-state   { credentials: { account_number, password, broker_server } }
POST /execute         { order: { symbol, direction, entry, stop, target, risk_percent },
                        credentials: { account_number, password, broker_server } }
GET  /health
```

## Modes (`MT5_BRIDGE_MODE`)

| Mode | Runs on | Behavior |
|---|---|---|
| `off` | anywhere | Refuses everything (503). Default. |
| `sim` | anywhere | Deterministic demo. Account state is derived from the account number (stable balance, no fabricated positions); `execute` appends to `data/sim_trades.jsonl`. **Every response is flagged `simulation: true`** and the agent is told to label fills as simulated, so nobody mistakes a demo fill for a real one. |
| `metaquotes` | **Windows only** | Real fills. Spawns `mt5_real.py` per request, which uses the `MetaTrader5` Python package against a running MT5 terminal on the same host. On non-Windows hosts it refuses (503) rather than fabricate. |

## Running

```bash
cd /home/ubuntu/meridian-backend
pm2 start bridge/server.js --name mt5-bridge
pm2 save
```

Config lives in the backend `.env`:

```
MT5_BACKEND_URL=http://127.0.0.1:8643
MT5_BRIDGE_MODE=sim
```

Port: `MT5_BRIDGE_PORT` (default `8643`).

## Going live (real broker fills)

1. Install MetaTrader5 on a **Windows** machine and log in to your account there.
2. `pip install MetaTrader5`.
3. Copy `bridge/` to that machine, set `MT5_BRIDGE_MODE=metaquotes`, run `server.js` (e.g. `node bridge/server.js` on port 8643).
4. Open a firewall port and point the backend's `MT5_BACKEND_URL` at
   `http://<windows-host>:<port>` (add a firewall rule allowing only the
   EC2 server's IP if possible).

## Safety

- Credentials are forwarded only from the backend (already decrypted at rest),
  used for the single call, never logged and never returned in responses.
- The hard-coded risk gate runs **before** any `execute` call in the MCP
  process; this service is a dumb executor and does not re-decide risk.
- `sim` mode never fabricates positions or fills without the
  `simulation: true` flag and the matching "SIMULATED" label upstream.
