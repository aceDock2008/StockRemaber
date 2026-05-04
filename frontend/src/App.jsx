import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Plus, RefreshCw, Trash2, TrendingUp, TrendingDown, Wallet, Wifi, WifiOff, Clock, AlertTriangle } from 'lucide-react';

// ============================================================
// 股票價格抓取核心邏輯
//
// ★ 開發模式 (localhost)：
//   → 透過 Vite 內建的伺服器轉發，完全沒有 CORS 問題
//
// ★ 正式上線 (GitHub Pages)：
//   → 使用公開 CORS Proxy 繞過瀏覽器安全限制
// ============================================================

// import.meta.env.DEV 是 Vite 提供的環境變數：
//   true  = 你在電腦本地跑 npm run dev
//   false = 已經 build 好並部署到 GitHub Pages
const IS_DEV = import.meta.env.DEV;

// Yahoo Finance API 路徑（v8 chart，支援台股和美股）
const YAHOO_PATH = (symbol) =>
  `/v8/finance/chart/${symbol}?interval=1d&range=2d`;

// 解析 Yahoo Finance API 回應，取出股價
function parseYahooResponse(data) {
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('回應格式不符，Yahoo 可能暫時限制存取');
  const price = meta.regularMarketPrice ?? meta.previousClose;
  if (!price || price <= 0) throw new Error('未取得有效股價');
  return price;
}

// ────────────────────────────────────────────
// 開發模式：使用 Vite 開發伺服器代理（最可靠）
// ────────────────────────────────────────────
async function fetchViaDev(symbol) {
  const res = await fetch(`/yahoo-proxy${YAHOO_PATH(symbol)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${errText ? ': ' + errText.slice(0, 80) : ''}`);
  }
  const data = await res.json();
  const price = parseYahooResponse(data);
  return { price, symbol, source: 'Yahoo Finance (本地代理)' };
}

// ────────────────────────────────────────────
// 正式模式：透過 CORS Proxy 呼叫 Yahoo Finance
// ────────────────────────────────────────────

// 嘗試三個不同的 Proxy 服務（依序試，誰回應就用誰）
const CORS_PROXIES = [
  {
    name: 'AllOrigins',
    // allorigins 需要把目標 URL 編碼後放在 url= 參數裡
    build: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
    parse: async (res) => {
      const outer = await res.json();
      if (!outer.contents) throw new Error('回傳空內容');
      return JSON.parse(outer.contents);
    },
  },
  {
    name: 'CorsProxy.io',
    // ★ 修正：必須 encodeURIComponent，否則 URL 裡的 & 會被誤解
    build: (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    parse: async (res) => res.json(),
  },
  {
    name: 'ThingProxy',
    // thingproxy 直接附在路徑後面，不需編碼
    build: (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
    parse: async (res) => res.json(),
  },
];

// Yahoo Finance 嘗試兩個不同的主機（有時候 query1 快、有時候 query2 快）
const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

async function fetchViaCorsProxy(symbol) {
  const errors = [];

  for (const host of YAHOO_HOSTS) {
    const yahooUrl = `${host}/v8/finance/chart/${symbol}?interval=1d&range=5d`;

    for (const proxy of CORS_PROXIES) {
      try {
        const res = await fetch(proxy.build(yahooUrl), {
          signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await proxy.parse(res);
        const price = parseYahooResponse(data);
        return { price, symbol, source: `Yahoo (${proxy.name})` };
      } catch (err) {
        const label = `${proxy.name}/${host.includes('query1') ? 'q1' : 'q2'}`;
        console.warn(`[${label}] ${symbol}:`, err.message);
        errors.push(`${label}: ${err.message}`);
      }
    }
  }

  throw new Error(`全部 ${errors.length} 個來源失敗。最後錯誤：${errors[errors.length - 1]}`);
}

// ────────────────────────────────────────────
// 主要對外函式：自動選擇正確模式
// ────────────────────────────────────────────
async function fetchYahooPrice(rawTicker) {
  // 台股代號（4~6位數字）自動加 .TW；美股維持大寫
  const symbol = /^\d{4,6}$/.test(rawTicker.trim())
    ? `${rawTicker.trim()}.TW`
    : rawTicker.trim().toUpperCase();

  if (IS_DEV) {
    return await fetchViaDev(symbol);
  } else {
    return await fetchViaCorsProxy(symbol);
  }
}

// 批次抓取所有股票價格（平行化，互不影響）
async function fetchAllPrices(tickers) {
  const results = {};
  await Promise.allSettled(
    tickers.map(async (ticker) => {
      try {
        const data = await fetchYahooPrice(ticker);
        results[ticker] = { price: data.price, symbol: data.symbol, source: data.source };
      } catch (err) {
        results[ticker] = { price: null, error: err.message };
      }
    })
  );
  return results;
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

    // 自動為台股代號附加 .TW
    let processedTicker = /^\d{4,6}$/.test(tickerRaw) ? tickerRaw : tickerRaw.toUpperCase();

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

    // 新增後自動抓取新股票的價格
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
