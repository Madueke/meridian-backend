#!/usr/bin/env python3
"""bridge/mt5_real.py — real MT5 bridge helper (Windows only).

Spawns per request from bridge/server.js in metaquotes mode. Uses the
MetaTrader5 Python package against a running MT5 terminal on the same
Windows host. Credentials come from the bridge (already decrypted by the
backend); they are used only for this call and never logged.

Usage:
  python mt5_real.py account_state <json with account_number/password/broker_server>
  python mt5_real.py execute <json with order + credentials>

Output: single JSON object on stdout. Errors: {"error": true, "reason": ...}.
"""

import json
import sys


def load():
    try:
        import MetaTrader5 as mt5
    except ImportError:
        return {"error": True, "reason": "MetaTrader5 Python package not installed (pip install MetaTrader5)"}
    return mt5


def account_state(creds):
    mt5 = load()
    if isinstance(mt5, dict):
        return mt5
    login = int(creds.get("account_number"))
    password = creds.get("password", "")
    server = creds.get("broker_server", "")
    if not mt5.initialize():
        return {"error": True, "reason": f"MT5 terminal not reachable: {mt5.last_error()}"}
    authorized = mt5.login(login, password=password, server=server)
    if not authorized:
        err = mt5.last_error()
        mt5.shutdown()
        return {"error": True, "reason": f"MT5 login failed: {err}"}
    info = mt5.account_info()
    positions = mt5.positions_get()
    deals = mt5.history_deals_get(datetime_from=None, datetime_to=None) or []
    out = {
        "balance": info.balance if info else None,
        "equity": info.equity if info else None,
        "open_positions": [],
        "history": [],
    }
    if positions:
        out["open_positions"] = [
            {
                "symbol": p.symbol,
                "direction": "long" if p.type == 0 else "short",
                "volume": p.volume,
                "open_price": p.price_open,
                "profit": p.profit,
            }
            for p in positions
        ]
    if deals:
        out["history"] = [
            {"symbol": d.symbol, "volume": d.volume, "price": d.price, "profit": d.profit}
            for d in deals[-10:]
        ]
    mt5.shutdown()
    if info is None:
        return {"error": True, "reason": "MT5 account_info() returned None"}
    return out


def execute(payload):
    mt5 = load()
    if isinstance(mt5, dict):
        return mt5
    order = payload.get("order", {})
    creds = payload.get("credentials", {})
    login = int(creds.get("account_number"))
    password = creds.get("password", "")
    server = creds.get("broker_server", "")
    if not mt5.initialize():
        return {"error": True, "reason": f"MT5 terminal not reachable: {mt5.last_error()}"}
    authorized = mt5.login(login, password=password, server=server)
    if not authorized:
        err = mt5.last_error()
        mt5.shutdown()
        return {"error": True, "reason": f"MT5 login failed: {err}"}
    symbol = order.get("symbol", "")
    direction = order.get("direction", "long")
    volume = mt5.symbol_info(symbol).volume_min if mt5.symbol_info(symbol) else 0.01
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": mt5.ORDER_TYPE_BUY if direction == "long" else mt5.ORDER_TYPE_SELL,
        "price": mt5.symbol_info_tick(symbol).ask if direction == "long" else mt5.symbol_info_tick(symbol).bid,
        "sl": float(order.get("stop", 0)),
        "tp": float(order.get("target", 0)),
        "deviation": 20,
        "magic": 447100,
        "comment": "neutral-pip",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    mt5.shutdown()
    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        err = result.retcode if result else mt5.last_error()
        return {"error": True, "reason": f"Order rejected by broker: {err}"}
    return {"executed": True, "trade_id": str(result.order)}


def main():
    kind = sys.argv[1] if len(sys.argv) > 1 else ""
    payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    try:
        if kind == "account_state":
            out = account_state(payload)
        elif kind == "execute":
            out = execute(payload)
        else:
            out = {"error": True, "reason": f"Unknown kind: {kind}"}
    except Exception as exc:  # noqa: BLE001 — helper must never crash silently
        out = {"error": True, "reason": f"MT5 helper error: {exc}"}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
