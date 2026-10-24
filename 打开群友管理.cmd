@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0打开管理页面.ps1" %*
if errorlevel 1 (
    echo.
    echo 管理页面打开失败，请查看上方提示。
    pause
    exit /b 1
)
endlocal
