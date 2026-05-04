import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // 重要：部署到 GitHub Pages 時，base 必須設定為你的 repo 名稱
  // 例如你的 GitHub repo 叫 "StockRemaber"，就設定 '/StockRemaber/'
  // 如果你用自訂網域或根目錄部署，改回 '/'
  base: '/StockRemaber/',

  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: '台股損益計算機',
        short_name: '股票計算機',
        description: '純前端 PWA，台股損益即時計算，無需安裝任何軟體',
        theme_color: '#0b0d18',
        background_color: '#0b0d18',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/StockRemaber/',
        scope: '/StockRemaber/',
        lang: 'zh-TW',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        // 讓 PWA 快取核心檔案，確保離線也能開啟
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            // 快取 Google Fonts
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 }
            }
          }
        ]
      }
    })
  ],

  // 開發模式設定（本地測試用，不影響部署）
  server: {
    port: 3000,
    // 在本機開發時，用 Vite 內建的伺服器幫我們「轉發」請求到 Yahoo Finance
    // 這樣瀏覽器就不會有 CORS 錯誤（因為請求是從 Node.js 伺服器發出，不是瀏覽器）
    proxy: {
      '/yahoo-proxy': {
        target: 'https://query2.finance.yahoo.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/yahoo-proxy/, ''),
        // 加入正常瀏覽器的 headers，避免 Yahoo 拒絕請求
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        }
      },
      '/twse-proxy': {
        target: 'https://openapi.twse.com.tw',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/twse-proxy/, ''),
      }
    }
  }
});
