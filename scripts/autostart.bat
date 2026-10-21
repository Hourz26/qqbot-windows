@echo off
REM SnowLuma + 隔离 QQ 守护入口（开机自启用）
REM 首次拉起；若已在运行则静默跳过
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Apps\snowluma\watchdog.ps1"
