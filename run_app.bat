@echo off
echo [Debug] Starting script...
pause
set BASE_DIR=%~dp0

echo Installing Python backend dependencies...
cd /d "%BASE_DIR%backend"
call pip install -r requirements.txt

echo.
echo Starting Backend (FastAPI)...
start "Backend" cmd /k "python -m uvicorn main:app --reload --host 0.0.0.0"

echo.
echo Installing Frontend NPM dependencies...
cd /d "%BASE_DIR%frontend"
call npm install

echo.
echo Starting Frontend (Vite)...
start "Frontend" cmd /k "npm run dev -- --host"

echo.
echo ========================================================
echo App is starting!
echo.
echo [On this computer]:
echo Open browser and go to: http://localhost:3000
echo.
echo [On your phone]:
echo 1. Ensure phone and PC are on the same Wi-Fi.
echo 2. Check your PC's IPv4 Address below:
ipconfig | findstr /i "ipv4"
echo 3. Open browser on phone and go to: http://[Your IPv4 Address]:3000
echo 4. Add to Home Screen to install as APP!
echo ========================================================
pause
