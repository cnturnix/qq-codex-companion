@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0停止群友.ps1"
if errorlevel 1 (
    echo.
    echo 停止失败，请查看上方提示。
    pause
    exit /b 1
)
pause
endlocal
