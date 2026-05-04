@echo off
echo Installing Backend Dependencies...
cd backend
call pip install -r requirements.txt

echo.
echo Installing Frontend Dependencies...
cd ../frontend
call npm install

echo.
echo Installation Complete! You can now run start.bat
pause
