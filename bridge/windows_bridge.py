#!/usr/bin/env python3
"""
bridge/windows_bridge.py — Windows MT5 Bridge Service.

Runs on a Windows VPS with MetaTrader5 terminal + MetaTrader5 Python package.
Exposes the same HTTP API that the Linux mt5-bridge expects when MT5_BRIDGE_MODE=metaquotes:

  GET  /health
  POST /account-state  { credentials: { account_number, password, broker_server } }
  POST /execute        { order: {...}, credentials: {...} }

Returns JSON responses matching the Linux bridge's contract exactly,
with simulation: false (real data).

Run:
  pip install flask MetaTrader5
  python windows_bridge.py

Configure as a Windows service via NSSM for production.
"""

import os
import json
import logging
from datetime import datetime
from flask import Flask, request, jsonify

try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    mt5 = None

app = Flask(__name__)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
logger = logging.getLogger(__name__)

PORT = int(os.getenv("MT5_BRIDGE_PORT", "8643"))
HOST = os.getenv("MT5_BRIDGE_HOST", "0.0.0.0")


def error_response(reason, status=503):
    """Standard error response format."""
    return jsonify({"error": True, "reason": reason}), status


def init_mt5():
    """Initialize MT5 terminal connection."""
    if not MT5_AVAILABLE:
        return False, "MetaTrader5 Python package not installed (pip install MetaTrader5)"
    if not mt5.initialize():
        return False, f"MT5 terminal not reachable: {mt5.last_error()}"
    return True, None


def login_mt5(credentials):
    """Login to MT5 with provided credentials."""
    login = int(credentials.get("account_number", 0))
    password = credentials.get("password", "")
    server = credentials.get("broker_server", "")
    if not mt5.login(login, password=password, server=server):
        err = mt5.last_error()
        mt5.shutdown()
        return False, f"MT5 login failed: {err}"
    return True, None


def format_position(p):
    """Format MT5 position to bridge contract."""
    return {
        "symbol": p.symbol,
        "direction": "long" if p.type == 0 else "short",
        "volume": float(p.volume),
        "open_price": float(p.price_open),
        "profit": float(p.profit),
    }


def format_deal(d):
    """Format MT5 deal to bridge contract."""
    return {
        "symbol": d.symbol,
        "volume": float(d.volume),
        "price": float(d.price),
        "profit": float(d.profit),
    }


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "mode": "metaquotes",
        "simulation": False,
        "mt5_available": MT5_AVAILABLE,
        "platform": "windows",
    })


@app.post("/account-state")
def account_state():
    """Get account state from MT5 terminal."""
    credentials = (request.json or {}).get("credentials", {})
    if not credentials:
        return error_response("credentials required", 400)

    ok, err = init_mt5()
    if not ok:
        return error_response(err)

    ok, err = login_mt5(credentials)
    if not ok:
        return error_response(err)

    try:
        info = mt5.account_info()
        positions = mt5.positions_get()
        deals = mt5.history_deals_get() or []

        if info is None:
            return error_response("MT5 account_info() returned None")

        out = {
            "available": True,
            "simulation": False,
            "balance": float(info.balance),
            "equity": float(info.equity),
            "open_positions": [format_position(p) for p in positions] if positions else [],
            "history": [format_deal(d) for d in deals[-10:]] if deals else [],
        }
        return jsonify(out)
    except Exception as e:
        logger.exception("account_state error")
        return error_response(f"MT5 helper error: {e}")
    finally:
        mt5.shutdown()


@app.post("/execute")
def execute():
    """Execute a trade on MT5 terminal."""
    data = request.json or {}
    order = data.get("order", {})
    credentials = data.get("credentials", {})

    if not order or not isinstance(order, dict):
        return error_response("order is required", 400)
    if not credentials:
        return error_response("credentials required", 400)

    ok, err = init_mt5()
    if not ok:
        return error_response(err)

    ok, err = login_mt5(credentials)
    if not ok:
        return error_response(err)

    try:
        symbol = str(order.get("symbol", "")).upper()
        direction = str(order.get("direction", "long")).lower()
        stop = float(order.get("stop", 0))
        target = float(order.get("target", 0))

        if not symbol:
            return error_response("symbol required", 400)

        info = mt5.symbol_info(symbol)
        if info is None:
            return error_response(f"Symbol {symbol} not found in MT5")

        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            return error_response(f"Cannot get tick for {symbol}")

        volume = float(info.volume_min)

        request_dict = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": volume,
            "type": mt5.ORDER_TYPE_BUY if direction == "long" else mt5.ORDER_TYPE_SELL,
            "price": float(tick.ask if direction == "long" else tick.bid),
            "sl": stop,
            "tp": target,
            "deviation": 20,
            "magic": 447100,
            "comment": "neutral-pip",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        result = mt5.order_send(request_dict)
        if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
            err_code = result.retcode if result else mt5.last_error()
            return jsonify({
                "executed": False,
                "reason": f"Order rejected by broker: {err_code}",
            }), 503

        return jsonify({
            "executed": True,
            "trade_id": str(result.order),
            "reason": None,
        })
    except Exception as e:
        logger.exception("execute error")
        return error_response(f"MT5 helper error: {e}")
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    logger.info(f"Starting Windows MT5 Bridge on {HOST}:{PORT}")
    logger.info(f"MT5 package available: {MT5_AVAILABLE}")
    if not MT5_AVAILABLE:
        logger.warning("MetaTrader5 package not installed — install with: pip install MetaTrader5")
    app.run(host=HOST, port=PORT, debug=False)