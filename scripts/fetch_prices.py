"""
Fetches current prices for every ticker listed in tickers.json and writes
the results to prices.json at the repo root. Runs on a schedule via
.github/workflows/update-prices.yml — no manual steps needed once set up.

Ticker formats (uses Yahoo Finance conventions via the yfinance library):
  US stocks     -> plain symbol, e.g. "AAPL", "TSLA", "MSFT"
  Indian (NSE)  -> symbol + ".NS",  e.g. "RELIANCE.NS", "TCS.NS"
  Indian (BSE)  -> symbol + ".BO",  e.g. "500325.BO"
  Crypto        -> symbol + "-USD", e.g. "BTC-USD", "ETH-USD"

The tracker looks up prices by the exact ticker string you used here, so
whatever you type in tickers.json must match what you type into the
tracker's "Ticker / Coin ID" field on a holding, exactly.
"""

import json
import sys
from datetime import datetime, timezone

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance is not installed. Run: pip install -r scripts/requirements.txt", file=sys.stderr)
    sys.exit(1)


def fallback_currency(symbol):
    """Best guess if yfinance doesn't report a currency for some reason."""
    if symbol.endswith(".NS") or symbol.endswith(".BO"):
        return "INR"
    return "USD"


def fetch_one(symbol):
    ticker = yf.Ticker(symbol)
    price = None
    currency = None

    # fast_info is quick and usually enough; fall back to recent history
    # if a particular field isn't available for this symbol.
    try:
        fi = ticker.fast_info
        price = fi.get("last_price") if hasattr(fi, "get") else fi["last_price"]
        currency = fi.get("currency") if hasattr(fi, "get") else None
    except Exception:
        pass

    if price is None:
        hist = ticker.history(period="1d")
        if not hist.empty:
            price = float(hist["Close"].iloc[-1])

    if price is None:
        raise ValueError(f"no price data returned for {symbol}")

    return round(float(price), 4), str(currency).upper() if currency else fallback_currency(symbol)


def main():
    try:
        with open("tickers.json") as f:
            tickers = json.load(f)
    except FileNotFoundError:
        print("ERROR: tickers.json not found at repo root.", file=sys.stderr)
        sys.exit(1)

    result = {}
    failures = []

    for symbol in tickers:
        try:
            price, currency = fetch_one(symbol)
            result[symbol] = {"price": price, "currency": currency}
            print(f"OK   {symbol}: {price} {currency}")
        except Exception as e:
            failures.append(symbol)
            print(f"FAIL {symbol}: {e}", file=sys.stderr)

    # USD/INR exchange rate, so the tracker can convert a USD-priced holding
    # (like a US stock or crypto) into INR terms if you're viewing that
    # holding under the India currency toggle, or vice versa.
    try:
        fx = yf.Ticker("INR=X")
        fi = fx.fast_info
        rate = fi.get("last_price") if hasattr(fi, "get") else fi["last_price"]
        result["usdToInr"] = round(float(rate), 4)
    except Exception as e:
        print(f"WARN: could not fetch USD/INR rate: {e}", file=sys.stderr)

    result["updatedAt"] = datetime.now(timezone.utc).isoformat()

    with open("prices.json", "w") as f:
        json.dump(result, f, indent=2)

    print(f"\nWrote prices.json: {len(result)-2} ticker(s) succeeded, {len(failures)} failed.")
    if failures:
        print("Failed tickers:", ", ".join(failures))


if __name__ == "__main__":
    main()
