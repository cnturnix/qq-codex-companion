@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0同步GitHub.ps1" %*
set "syncExit=%ERRORLEVEL%"
echo.
pause
exit /b %syncExit%
