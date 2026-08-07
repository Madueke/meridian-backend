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

## Running (Linux — sim mode)

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

## Going live (real broker fills) — Windows Bridge Server

For real broker fills, you need a **separate Windows VPS** running the MT5 terminal
and a Windows-side bridge listener. The Linux `mt5-bridge` stays exactly where it is;
it just gets pointed at the Windows box.

### 1. Provision a Windows VPS

- Small/cheap tier (e.g., 2 vCPU, 4 GB RAM) — its only job is running MT5 terminal
  and the bridge listener.
- Install Python (3.10+).
- Install the `MetaTrader5` Python package:
  ```powershell
  pip install MetaTrader5
  ```
- Install the actual MetaTrader5 terminal application (from your broker, or the
  general MetaTrader5 terminal), log into a **DEMO** account first.

### 2. Deploy the Windows bridge listener

Copy the `bridge/` folder to the Windows machine (or just the `windows_bridge.py`
file and install Flask + MetaTrader5). Run it:

```powershell
cd C:\path\to\bridge
python windows_bridge.py
```

For production, install as a Windows service via NSSM so it survives reboots:

```powershell
# Download NSSM: https://nssm.cc/download
nssm install MT5Bridge
# Path: python.exe
# Arguments: C:\path\to\bridge\windows_bridge.py
# Startup directory: C:\path\to\bridge
nssm set MT5Bridge AppEnvironmentExtra MT5_BRIDGE_PORT=8643
nssm set MT5Bridge AppEnvironmentExtra MT5_BRIDGE_HOST=0.0.0.0
nssm start MT5Bridge
```

Verify it's alive:

```powershell
Invoke-RestMethod http://localhost:8643/health
# Should return: status=ok, mode=metaquotes, simulation=false
```

### 3. Point the Linux bridge at the Windows box

On the Linux EC2 box, update the backend `.env`:

```
MT5_BRIDGE_MODE=metaquotes
MT5_BACKEND_URL=http://<windows-vps-ip>:8643
```

Restart the Linux bridge (and hermes-gateway, since MCP subprocesses cache .env at load):

```bash
pm2 restart mt5-bridge --update-env
pm2 restart hermes-gateway
```

### 4. Network / Security

- **Only the Linux EC2 box's IP** should reach the Windows bridge port.
  Restrict via Windows Firewall or cloud security group — don't expose it publicly.
- If your cloud provider supports it, use a VPC peering / private network link
  instead of open internet between the two boxes.

### 5. Verification (do this BEFORE touching a real funded account)

1. Direct test: `curl http://<windows-ip>:8643/account-state` with demo credentials —
   confirm real (demo) balance/equity returned, `simulation: false`.
2. App test: Ask "What's my account balance?" — confirm the app shows the real
   demo account's actual balance, not a simulated one.
3. Risk gate test: Ask for an oversized trade — confirm it still blocks correctly
   against the real connection.
4. End-to-end test: Place one small trade via the demo account through the full
   pipeline — confirm it actually appears in the MT5 terminal on the Windows box.
5. Only after ALL of the above passes on a demo account, consider switching to
   a real funded account.

**The `sim` mode remains fully functional and switchable** — just change
`MT5_BRIDGE_MODE=sim` and `MT5_BACKEND_URL=http://127.0.0.1:8643` to go back
to local deterministic demo without touching the Windows box.

## Safety

- Credentials are forwarded only from the backend (already decrypted at rest),
  used for the single call, never logged and never returned in responses.
- The hard-coded risk gate runs **before** any `execute` call in the MCP
  process; this service is a dumb executor and does not re-decide risk.
- `sim` mode never fabricates positions or fills without the
  `simulation: true` flag and the matching "SIMULATED" label upstream.