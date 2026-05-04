from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import yfinance as yf
from typing import List, Dict

app = FastAPI(title="Stock PWA API")

# Configure CORS for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify your frontend URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/prices")
def get_prices(tickers: str = Query(..., description="Comma separated list of tickers, e.g. 2330,2317,AAPL")):
    print(f"====================================")
    print(f"Received API request for tickers: {tickers}")
    print(f"====================================")
    ticker_list = [t.strip() for t in tickers.split(",") if t.strip()]
    if not ticker_list:
        return {"error": "No tickers provided"}

    results: Dict[str, dict] = {}
    
    # Process each ticker
    for original_t in ticker_list:
        t = original_t
        # If it's a pure number and a Taiwan stock, append .TW
        if t.isdigit() and len(t) in [4, 5, 6]:
            t = f"{t}.TW"
        
        try:
            ticker = yf.Ticker(t)
            hist = ticker.history(period="1d")
            if not hist.empty:
                # Convert to normal python float to avoid JSON serialization errors
                price_val = float(hist['Close'].iloc[-1])
                import math
                if math.isnan(price_val):
                    results[original_t] = {"error": "Price is NaN", "price": None}
                else:
                    results[original_t] = {"price": price_val, "symbol": t}
            else:
                results[original_t] = {"error": "No data found for ticker", "price": None}
        except Exception as e:
            results[original_t] = {"error": str(e), "price": None}

    # Ensure the result is strictly JSON serializable before returning
    import json
    try:
        json.dumps(results)
    except Exception as e:
        return {"error": "JSON Serialization error: " + str(e)}

    return {"data": results}

@app.get("/api/health")
def health_check():
    return {"status": "ok"}
