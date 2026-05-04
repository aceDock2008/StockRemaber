import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Plus, RefreshCw, Trash2, TrendingUp, TrendingDown, Wallet, Wifi, WifiOff, Clock, AlertTriangle } from 'lucide-react';

// ============================================================
// 股票價格抓取核心邏輯
//
// ★ 開發模式 (localhost)：Vite 伺服器幫忙轉發，不需要 CORS Proxy
// ★ 正式上線 (GitHub Pages)：透過公開 CORS Proxy 呼叫 Yahoo Finance
//
// 使用 v7/finance/quote API（比 v8/chart 限制更少、更穩定）
// 支援批次查詢：一次呼叫抓所有股票
// ============================================================

const IS_DEV = import.meta.env.DEV;

// ──────────────────────────────────────────────────────
// 建立 Yahoo Finance v7 quote 查詢 URL
// 可以一次查多支股票：symbols=2330.TW,2317.TW,AAPL
// ──────────────────────────────────────────────────────
function makeYahooQuoteUrl(symbols, host = 'https://query1.finance.yahoo.com') {
  const joined = Array.isArray(symbols) ? symbols.join(',') : symbols;
  return `${host}/v7/finance/quote?symbols=${joined}&fields=regularMarketPrice,previousClose,shortName`;
}

// ──────────────────────────────────────────────────────
// 解析 Yahoo Finance v7 回應，支援批次結果
// ──────────────────────────────────────────────────────
function parseV7QuoteResponse(data, symbolMap) {
  // symbolMap: { "2330.TW": "2330", "AAPL": "AAPL" }
  const results = {};
  const list = data?.quoteResponse?.result ?? [];

  if (list.length === 0) {
    const err = data?.quoteResponse?.error;
    throw new Error(err ? JSON.stringify(err) : 'Yahoo 回應為空（可能暫時限制存取）');
  }

  list.forEach((quote) => {
    const ySymbol = quote.symbol; // e.g. "2330.TW"
    const originalTicker = symbolMap[ySymbol] ?? ySymbol;
    const price = quote.regularMarketPrice ?? quote.previousClose;
    if (price && price > 0) {
      results[originalTicker] = { price, symbol: ySymbol, source: 'Yahoo v7' };
    } else {
      results[originalTicker] = { price: null, error: '股價為空（非交易時段）' };
    }
  });

  return results;
}

// ──────────────────────────────────────────────────────
// 開發模式：Vite 代理（最可靠，無 CORS 問題）
// ──────────────────────────────────────────────────────
async function fetchAllViaDev(symbolMap) {
  const symbols = Object.keys(symbolMap);
  const path = `/v7/finance/quote?symbols=${symbols.join(',')}&fields=regularMarketPrice,previousClose,shortName`;
  const res = await fetch(`/yahoo-proxy${path}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return parseV7QuoteResponse(data, symbolMap);
}

// ──────────────────────────────────────────────────────
// 正式模式：CORS Proxy（GitHub Pages 使用）
// ──────────────────────────────────────────────────────
const CORS_PROXIES = [
  {
    name: 'AllOrigins',
    build: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
    parse: async (res) => {
      const outer = await res.json();
      if (!outer.contents) throw new Error('AllOrigins 空回應');
      return JSON.parse(outer.contents);
    },
  },
  {
    name: 'CorsProxy.io',
    build: (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    parse: async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  },
];

const YAHOO_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];

async function fetchAllViaCorsProxy(symbolMap) {
  const symbols = Object.keys(symbolMap);
  const errors = [];

  for (const host of YAHOO_HOSTS) {
    const yahooUrl = makeYahooQuoteUrl(symbols, host);
    for (const proxy of CORS_PROXIES) {
      try {
        const res = await fetch(proxy.build(yahooUrl), { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await proxy.parse(res);
        return parseV7QuoteResponse(data, symbolMap);
      } catch (err) {
        const label = `${proxy.name}@${host.includes('query1') ? 'q1' : 'q2'}`;
        console.warn(`[${label}]:`, err.message);
        errors.push(`${label}: ${err.message}`);
      }
    }
  }

  throw new Error(`所有來源失敗(${errors.length}次)。最後：${errors.at(-1)}`);
}

// ──────────────────────────────────────────────────────
// 主要對外函式：批次抓所有股票的最新股價
// ──────────────────────────────────────────────────────
async function fetchAllPrices(tickers) {
  if (!tickers || tickers.length === 0) return {};

  // 建立 { Yahoo符號 → 原始代號 } 的對照表
  const symbolMap = {};
  tickers.forEach((t) => {
    const ySymbol = /^\d{4,6}$/.test(t.trim()) ? `${t.trim()}.TW` : t.trim().toUpperCase();
    symbolMap[ySymbol] = t;
  });

  try {
    if (IS_DEV) {
      return await fetchAllViaDev(symbolMap);
    } else {
      return await fetchAllViaCorsProxy(symbolMap);
    }
  } catch (err) {
    // 全部失敗時，每支股票都標記錯誤
    const fallback = {};
    tickers.forEach((t) => { fallback[t] = { price: null, error: err.message }; });
    return fallback;
  }
}

// ============================================================
// React App 主體
// ============================================================

function App() {
  const [stocks, setStocks] = useState(() => {
    try {
      const saved = localStorage.getItem('pwa-stocks-v2');
      if (saved) return JSON.parse(saved);
    } catch (e) { /* ignore */ }
    return [];
  });

  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [globalError, setGlobalError] = useState('');

  // 表單狀態
  const [isAdding, setIsAdding] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [newBuyPrice, setNewBuyPrice] = useState('');
  const [newQuantity, setNewQuantity] = useState('');
  const [formError, setFormError] = useState('');

  // 監聽網路狀態
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // 儲存到 LocalStorage
  useEffect(() => {
    localStorage.setItem('pwa-stocks-v2', JSON.stringify(stocks));
  }, [stocks]);

  // 抓取即時價格
  const fetchPrices = useCallback(async () => {
    if (stocks.length === 0) return;
    if (!isOnline) {
      setGlobalError('目前離線，顯示的是上次抓取的價格');
      return;
    }
    setLoading(true);
    setGlobalError('');
    try {
      const tickers = stocks.map(s => s.ticker);
      const result = await fetchAllPrices(tickers);
      setPrices(result);
      setLastUpdated(new Date());
    } catch (err) {
      setGlobalError(`更新失敗: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [stocks, isOnline]);

  // 啟動時自動抓取
  useEffect(() => {
    if (stocks.length > 0) {
      fetchPrices();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 新增股票
  const handleAddStock = (e) => {
    e.preventDefault();
    const tickerRaw = newTicker.trim();
    const buy = parseFloat(newBuyPrice);
    const qty = parseInt(newQuantity, 10);

    if (!tickerRaw || isNaN(buy) || isNaN(qty) || buy <= 0 || qty <= 0) {
      setFormError('請確認所有欄位均已正確填寫');
      return;
    }

    // 台股代號儲存純數字，美股儲存大寫
    const processedTicker = /^\d{4,6}$/.test(tickerRaw) ? tickerRaw : tickerRaw.toUpperCase();

    const newStock = {
      id: Date.now().toString(),
      ticker: processedTicker,
      buyPrice: buy,
      quantity: qty,
    };
    setStocks(prev => [...prev, newStock]);
    setIsAdding(false);
    setNewTicker('');
    setNewBuyPrice('');
    setNewQuantity('');
    setFormError('');
    setTimeout(() => fetchPrices(), 300);
  };

  const removeStock = (id) => setStocks(prev => prev.filter(s => s.id !== id));

  // 計算總覽
  const summary = useMemo(() => {
    let totalCost = 0;
    let currentValue = 0;
    stocks.forEach(stock => {
      totalCost += stock.buyPrice * stock.quantity;
      const currentPrice = prices[stock.ticker]?.price ?? stock.buyPrice;
      currentValue += currentPrice * stock.quantity;
    });
    const profit = currentValue - totalCost;
    const profitPercent = totalCost > 0 ? (profit / totalCost) * 100 : 0;
    return { totalCost, currentValue, profit, profitPercent };
  }, [stocks, prices]);

  const formatTime = (date) => {
    if (!date) return null;
    return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="glass-header">
        <div className="header-title">
          <Wallet className="icon" size={24} />
          <h1>台股損益計算</h1>
        </div>
        <div className="header-actions">
          <div className={`online-badge ${isOnline ? 'online' : 'offline'}`}>
            {isOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
            <span>{isOnline ? '即時' : '離線'}</span>
          </div>
          <button
            className={`refresh-btn ${loading ? 'spinning' : ''}`}
            onClick={fetchPrices}
            disabled={loading}
            title="更新股價"
          >
            <RefreshCw size={20} />
          </button>
        </div>
      </header>

      <main className="main-content">
        {/* 全域錯誤提示 */}
        {globalError && (
          <div className="error-toast">
            <AlertTriangle size={16} />
            <span>{globalError}</span>
          </div>
        )}

        {/* 最後更新時間 */}
        {lastUpdated && (
          <div className="update-info">
            <Clock size={12} />
            <span>最後更新：{formatTime(lastUpdated)}</span>
            <span className="source-label">· Yahoo Finance</span>
          </div>
        )}

        {/* 總覽卡片 */}
        <section className="dashboard glass-card">
          <p className="dashboard-label">總資產現值 (TWD)</p>
          <h2 className="dashboard-value">
            ${Math.round(summary.currentValue).toLocaleString()}
          </h2>
          <div className="dashboard-stats">
            <div className="stat-item">
              <span className="stat-label">總成本</span>
              <span className="stat-number">${Math.round(summary.totalCost).toLocaleString()}</span>
            </div>
            <div className="stat-divider" />
            <div className="stat-item">
              <span className="stat-label">總損益</span>
              <span className={`stat-number ${summary.profit >= 0 ? 'text-green' : 'text-red'}`}>
                {summary.profit >= 0 ? '+' : ''}{Math.round(summary.profit).toLocaleString()}
                <span className="percent">
                  ({summary.profitPercent >= 0 ? '+' : ''}{summary.profitPercent.toFixed(2)}%)
                </span>
              </span>
            </div>
          </div>
        </section>

        {/* 股票明細 */}
        <section className="stock-list">
          <div className="list-header">
            <h3>庫存明細 ({stocks.length})</h3>
            <button className="btn-icon" onClick={() => setIsAdding(!isAdding)} title="新增股票">
              <Plus size={20} />
            </button>
          </div>

          {/* 新增表單 */}
          {isAdding && (
            <div className="add-form glass-card slide-down">
              <form onSubmit={handleAddStock}>
                <div className="form-group">
                  <label htmlFor="ticker-input">股票代號</label>
                  <input
                    id="ticker-input"
                    type="text"
                    placeholder="台股輸入 4 碼，如 2330；美股輸入 AAPL"
                    value={newTicker}
                    onChange={e => setNewTicker(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="buy-price-input">買進均價</label>
                    <input
                      id="buy-price-input"
                      type="number"
                      step="0.01"
                      placeholder="600.00"
                      value={newBuyPrice}
                      onChange={e => setNewBuyPrice(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="quantity-input">持有股數</label>
                    <input
                      id="quantity-input"
                      type="number"
                      placeholder="1000"
                      value={newQuantity}
                      onChange={e => setNewQuantity(e.target.value)}
                    />
                  </div>
                </div>
                {formError && <p className="form-error">{formError}</p>}
                <div className="form-actions">
                  <button type="button" className="btn-secondary" onClick={() => { setIsAdding(false); setFormError(''); }}>
                    取消
                  </button>
                  <button type="submit" className="btn-primary">新增</button>
                </div>
              </form>
            </div>
          )}

          {/* 卡片列表 */}
          <div className="cards-container">
            {stocks.length === 0 && !isAdding && (
              <div className="empty-state">
                <TrendingUp size={48} className="empty-icon" />
                <p>目前沒有庫存</p>
                <p className="empty-sub">點擊右上角 <strong>+</strong> 新增您的第一支股票</p>
              </div>
            )}
            {stocks.map(stock => {
              const priceData = prices[stock.ticker];
              const currentPrice = priceData?.price ?? stock.buyPrice;
              const hasError = priceData?.error;
              const isPriceLoaded = !!priceData?.price;
              const cost = stock.buyPrice * stock.quantity;
              const value = currentPrice * stock.quantity;
              const profit = value - cost;
              const percent = ((currentPrice - stock.buyPrice) / stock.buyPrice) * 100;
              const isProfit = profit >= 0;

              return (
                <div key={stock.id} className={`stock-card glass-card ${hasError ? 'has-error' : ''}`}>
                  <div className="stock-header">
                    <div className="stock-title">
                      <h4>{stock.ticker.replace('.TW', '')}
                        {/^\d{4,6}$/.test(stock.ticker) && <span className="market-badge">TW</span>}
                      </h4>
                      {hasError && (
                        <span className="stock-error-badge" title={priceData.error}>
                          <AlertTriangle size={12} /> 無法更新
                        </span>
                      )}
                    </div>
                    <button className="btn-delete" onClick={() => removeStock(stock.id)} title="刪除">
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="stock-body">
                    <div className="stock-info">
                      <p className="label">現價</p>
                      <p className={`value ${!isPriceLoaded ? 'value-dim' : ''}`}>
                        ${currentPrice.toFixed(2)}
                      </p>
                      <p className="sub-value">均價 ${stock.buyPrice}</p>
                    </div>
                    <div className="stock-info">
                      <p className="label">市值</p>
                      <p className="value">${Math.round(value).toLocaleString()}</p>
                      <p className="sub-value">{stock.quantity.toLocaleString()} 股</p>
                    </div>
                    <div className={`stock-profit ${isProfit ? 'profit' : 'loss'}`}>
                      <p className="label">損益</p>
                      <div className="profit-value">
                        {isProfit ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                        <span>${Math.round(profit).toLocaleString()}</span>
                      </div>
                      <p className="percent">{isProfit ? '+' : ''}{percent.toFixed(2)}%</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Footer */}
        <footer className="app-footer">
          <p>資料來源：Yahoo Finance · 僅供參考，非投資建議</p>
        </footer>
      </main>
    </div>
  );
}

export default App;
