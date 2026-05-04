import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Plus, RefreshCw, Trash2, TrendingUp, TrendingDown, Wallet, Wifi, WifiOff, Clock, AlertTriangle } from 'lucide-react';

// ============================================================
// 股票價格抓取策略：
//   台股 → TWSE 官方 Open API（免費、免驗證、政府來源）
//   美股 → Yahoo Finance v8 透過 CORS Proxy
// ============================================================

const IS_DEV = import.meta.env.DEV;

// ──────────────────────────────────────────────────────
// 【台股】TWSE Open API
// ──────────────────────────────────────────────────────
// 共用 CORS Proxy 定義
// ──────────────────────────────────────────────────────
const CORS_PROXIES = [
  {
    name: 'AllOrigins',
    build: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
    parse: async (res) => {
      const outer = await res.json();
      if (!outer.contents) throw new Error('空回應');
      return JSON.parse(outer.contents);
    },
  },
  {
    name: 'CorsProxy.io',
    build: (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    parse: async (res) => res.json(),
  },
];

// ──────────────────────────────────────────────────────
// 【台股】TWSE Open API
//   https://openapi.twse.com.tw — 台灣證交所官方公開資料
//   一次呼叫就能取得所有上市股票當日股價，免驗證
// ──────────────────────────────────────────────────────
let twseCache = null;  // 避免重複呼叫，同一次更新共用快取

async function fetchTWSEPriceMap() {
  if (twseCache) return twseCache;
  const targetUrl = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
  let list = null;

  if (IS_DEV) {
    const res = await fetch('/twse-proxy/v1/exchangeReport/STOCK_DAY_ALL', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`TWSE HTTP ${res.status}`);
    list = await res.json();
  } else {
    const errors = [];
    for (const proxy of CORS_PROXIES) {
      try {
        const res = await fetch(proxy.build(targetUrl), { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        list = await proxy.parse(res);
        break;
      } catch (e) {
        errors.push(`${proxy.name}: ${e.message}`);
      }
    }
    if (!list) throw new Error(`TWSE 全部來源失敗: ${errors.join(' | ')}`);
  }

  const map = {};
  list.forEach((s) => {
    const price = parseFloat((s.ClosingPrice || '').replace(/,/g, ''));
    if (!isNaN(price) && price > 0) map[s.Code] = price;
  });
  twseCache = map;
  setTimeout(() => { twseCache = null; }, 60000); // 60秒後清除快取
  return map;
}

// ──────────────────────────────────────────────────────
// 【美股】Yahoo Finance v8 透過 CORS Proxy
// ──────────────────────────────────────────────────────


async function fetchUSStockPrice(symbol) {
  const errors = [];
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    const url = `${host}/v8/finance/chart/${symbol}?interval=1d&range=5d`;
    for (const proxy of CORS_PROXIES) {
      try {
        const res = await fetch(proxy.build(url), { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await proxy.parse(res);
        const meta = data?.chart?.result?.[0]?.meta;
        const price = meta?.regularMarketPrice ?? meta?.previousClose;
        if (!price || price <= 0) throw new Error('價格為空');
        return price;
      } catch (e) {
        errors.push(`${proxy.name}: ${e.message}`);
      }
    }
  }
  throw new Error(errors.at(-1) || '所有來源失敗');
}

// ──────────────────────────────────────────────────────
// 【開發模式】美股透過 Vite dev proxy（繞過 CORS）
// ──────────────────────────────────────────────────────
async function fetchUSStockViaDev(symbol) {
  const res = await fetch(
    `/yahoo-proxy/v8/finance/chart/${symbol}?interval=1d&range=5d`,
    { signal: AbortSignal.timeout(12000) }
  );
  if (!res.ok) throw new Error(`Dev proxy HTTP ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice ?? meta?.previousClose;
  if (!price) throw new Error('無法取得股價');
  return price;
}

// ──────────────────────────────────────────────────────
// 主函式：批次抓所有股票股價
// ──────────────────────────────────────────────────────
async function fetchAllPrices(tickers) {
  if (!tickers?.length) return {};

  const twTickers = tickers.filter((t) => /^\d{4,6}$/.test(t.trim()));
  const usTickers = tickers.filter((t) => !/^\d{4,6}$/.test(t.trim()));
  const results = {};

  // --- 台股：一次呼叫取全部 ---
  if (twTickers.length > 0) {
    try {
      const map = await fetchTWSEPriceMap();
      twTickers.forEach((t) => {
        const price = map[t.trim()];
        if (price) {
          results[t] = { price, symbol: t + '.TW', source: '台灣證交所' };
        } else {
          results[t] = { price: null, error: '今日無成交資料（休市或代號錯誤）' };
        }
      });
    } catch (e) {
      twTickers.forEach((t) => { results[t] = { price: null, error: `TWSE: ${e.message}` }; });
    }
  }

  // --- 美股：逐一呼叫 Yahoo Finance ---
  await Promise.allSettled(
    usTickers.map(async (t) => {
      const sym = t.trim().toUpperCase();
      try {
        const price = IS_DEV
          ? await fetchUSStockViaDev(sym)
          : await fetchUSStockPrice(sym);
        results[t] = { price, symbol: sym, source: 'Yahoo Finance' };
      } catch (e) {
        results[t] = { price: null, error: e.message };
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
    try { return JSON.parse(localStorage.getItem('pwa-stocks-v2') || '[]'); }
    catch { return []; }
  });
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [globalError, setGlobalError] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [newBuyPrice, setNewBuyPrice] = useState('');
  const [newQuantity, setNewQuantity] = useState('');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  useEffect(() => {
    localStorage.setItem('pwa-stocks-v2', JSON.stringify(stocks));
  }, [stocks]);

  const fetchPrices = useCallback(async () => {
    if (!stocks.length) return;
    if (!isOnline) { setGlobalError('目前離線，顯示上次價格'); return; }
    setLoading(true);
    setGlobalError('');
    try {
      const result = await fetchAllPrices(stocks.map((s) => s.ticker));
      setPrices(result);
      setLastUpdated(new Date());
    } catch (e) {
      setGlobalError(`更新失敗: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [stocks, isOnline]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (stocks.length) fetchPrices(); }, []);

  const handleAddStock = (e) => {
    e.preventDefault();
    const raw = newTicker.trim();
    const buy = parseFloat(newBuyPrice);
    const qty = parseInt(newQuantity, 10);
    if (!raw || isNaN(buy) || isNaN(qty) || buy <= 0 || qty <= 0) {
      setFormError('請確認所有欄位均已正確填寫'); return;
    }
    const ticker = /^\d{4,6}$/.test(raw) ? raw : raw.toUpperCase();
    setStocks((p) => [...p, { id: Date.now().toString(), ticker, buyPrice: buy, quantity: qty }]);
    setIsAdding(false); setNewTicker(''); setNewBuyPrice(''); setNewQuantity(''); setFormError('');
    setTimeout(fetchPrices, 300);
  };

  const removeStock = (id) => setStocks((p) => p.filter((s) => s.id !== id));

  const summary = useMemo(() => {
    let cost = 0, value = 0;
    stocks.forEach((s) => {
      cost += s.buyPrice * s.quantity;
      value += (prices[s.ticker]?.price ?? s.buyPrice) * s.quantity;
    });
    const profit = value - cost;
    return { cost, value, profit, pct: cost > 0 ? (profit / cost) * 100 : 0 };
  }, [stocks, prices]);

  const fmt = (d) => d?.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="app-container">
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
          <button className={`refresh-btn ${loading ? 'spinning' : ''}`} onClick={fetchPrices} disabled={loading}>
            <RefreshCw size={20} />
          </button>
        </div>
      </header>

      <main className="main-content">
        {globalError && <div className="error-toast"><AlertTriangle size={16} /><span>{globalError}</span></div>}
        {lastUpdated && (
          <div className="update-info">
            <Clock size={12} />
            <span>最後更新：{fmt(lastUpdated)}</span>
            <span className="source-label">· 台股 TWSE / 美股 Yahoo</span>
          </div>
        )}

        <section className="dashboard glass-card">
          <p className="dashboard-label">總資產現值 (TWD)</p>
          <h2 className="dashboard-value">${Math.round(summary.value).toLocaleString()}</h2>
          <div className="dashboard-stats">
            <div className="stat-item">
              <span className="stat-label">總成本</span>
              <span className="stat-number">${Math.round(summary.cost).toLocaleString()}</span>
            </div>
            <div className="stat-divider" />
            <div className="stat-item">
              <span className="stat-label">總損益</span>
              <span className={`stat-number ${summary.profit >= 0 ? 'text-green' : 'text-red'}`}>
                {summary.profit >= 0 ? '+' : ''}{Math.round(summary.profit).toLocaleString()}
                <span className="percent">({summary.pct >= 0 ? '+' : ''}{summary.pct.toFixed(2)}%)</span>
              </span>
            </div>
          </div>
        </section>

        <section className="stock-list">
          <div className="list-header">
            <h3>庫存明細 ({stocks.length})</h3>
            <button className="btn-icon" onClick={() => setIsAdding(!isAdding)}><Plus size={20} /></button>
          </div>

          {isAdding && (
            <div className="add-form glass-card slide-down">
              <form onSubmit={handleAddStock}>
                <div className="form-group">
                  <label htmlFor="ticker-input">股票代號</label>
                  <input id="ticker-input" type="text" placeholder="台股輸入 4 碼如 2330；美股輸入 AAPL"
                    value={newTicker} onChange={(e) => setNewTicker(e.target.value)} autoFocus />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="buy-price-input">買進均價</label>
                    <input id="buy-price-input" type="number" step="0.01" placeholder="600.00"
                      value={newBuyPrice} onChange={(e) => setNewBuyPrice(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="quantity-input">持有股數</label>
                    <input id="quantity-input" type="number" placeholder="1000"
                      value={newQuantity} onChange={(e) => setNewQuantity(e.target.value)} />
                  </div>
                </div>
                {formError && <p className="form-error">{formError}</p>}
                <div className="form-actions">
                  <button type="button" className="btn-secondary" onClick={() => { setIsAdding(false); setFormError(''); }}>取消</button>
                  <button type="submit" className="btn-primary">新增</button>
                </div>
              </form>
            </div>
          )}

          <div className="cards-container">
            {stocks.length === 0 && !isAdding && (
              <div className="empty-state">
                <TrendingUp size={48} className="empty-icon" />
                <p>目前沒有庫存</p>
                <p className="empty-sub">點擊右上角 <strong>+</strong> 新增您的第一支股票</p>
              </div>
            )}
            {stocks.map((stock) => {
              const pd = prices[stock.ticker];
              const cur = pd?.price ?? stock.buyPrice;
              const cost = stock.buyPrice * stock.quantity;
              const val = cur * stock.quantity;
              const profit = val - cost;
              const pct = ((cur - stock.buyPrice) / stock.buyPrice) * 100;
              const isProfit = profit >= 0;
              const isTW = /^\d{4,6}$/.test(stock.ticker);

              return (
                <div key={stock.id} className={`stock-card glass-card ${pd?.error ? 'has-error' : ''}`}>
                  <div className="stock-header">
                    <div className="stock-title">
                      <h4>
                        {stock.ticker}
                        {isTW && <span className="market-badge">TW</span>}
                      </h4>
                      {pd?.error && (
                        <span className="stock-error-badge" title={pd.error}>
                          <AlertTriangle size={12} /> 無法更新
                        </span>
                      )}
                    </div>
                    <button className="btn-delete" onClick={() => removeStock(stock.id)}><Trash2 size={16} /></button>
                  </div>
                  <div className="stock-body">
                    <div className="stock-info">
                      <p className="label">現價</p>
                      <p className={`value ${!pd?.price ? 'value-dim' : ''}`}>${cur.toFixed(2)}</p>
                      <p className="sub-value">均價 ${stock.buyPrice}</p>
                    </div>
                    <div className="stock-info">
                      <p className="label">市值</p>
                      <p className="value">${Math.round(val).toLocaleString()}</p>
                      <p className="sub-value">{stock.quantity.toLocaleString()} 股</p>
                    </div>
                    <div className={`stock-profit ${isProfit ? 'profit' : 'loss'}`}>
                      <p className="label">損益</p>
                      <div className="profit-value">
                        {isProfit ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                        <span>${Math.round(profit).toLocaleString()}</span>
                      </div>
                      <p className="percent">{isProfit ? '+' : ''}{pct.toFixed(2)}%</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <footer className="app-footer">
          <p>台股資料：台灣證交所 TWSE · 美股資料：Yahoo Finance · 僅供參考</p>
        </footer>
      </main>
    </div>
  );
}

export default App;
