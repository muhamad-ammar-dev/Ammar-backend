@echo off
cd /d "%~dp0"
echo ============================================
echo   U T L O B - S A N A I   S E R V E R
echo ============================================
echo.
echo Checking port 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do (
  echo Stopping old server PID %%a
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul
echo Starting server...
echo (Output shows in this window and is saved to server.stdout.log)
echo.
powershell -NoProfile -Command "node src\server.js 2>&1 | Tee-Object -FilePath server.stdout.log"
echo.
echo Server stopped. Check server.stdout.log for details.
pause
