@echo off

rem Enable silent auto-start on logon. Run this file as Administrator.

net session >nul 2>&1
if not %errorlevel% equ 0 (
  powershell -NoProfile -Command "Write-Host '[????] ????????????????????????????' -ForegroundColor Red"
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable-autostart.ps1"
echo.
pause
