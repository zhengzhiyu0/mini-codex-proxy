@echo off

rem Restart the proxy: stop the process listening on the configured port, then relaunch it silently.
rem The PowerShell script requests Administrator rights on its own - the autostart task
rem registers the proxy with -RunLevel Highest, so stopping it needs elevation.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-proxy.ps1"
