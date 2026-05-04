@echo off
echo 正在建立 PWA 圖示資料夾...
if not exist "frontend\public" mkdir "frontend\public"

echo.
echo 請手動執行以下步驟：
echo.
echo 步驟 1: 到此路徑找到圖示檔案：
echo   C:\Users\User\.gemini\antigravity\brain\4c014c9d-adf8-4482-8be6-3e2dcca23b50\
echo   找到 pwa_icon_stock_*.png 這個檔案
echo.
echo 步驟 2: 複製到以下兩個位置（改名）：
echo   frontend\public\pwa-192x192.png
echo   frontend\public\pwa-512x512.png
echo.
pause
