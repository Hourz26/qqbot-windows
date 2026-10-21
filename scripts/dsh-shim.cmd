@echo off
setlocal DisableDelayedExpansion
chcp 65001>nul 2>nul
set "ELECTRON_RUN_AS_NODE=1"
set "DSH_DESKTOP_DEFAULT_PROFILE=desktop"
set "DSH_HOME=C:\Users\Hourz26\.dsh"
"D:\Apps\DSH\DSH Desktop\DSH Desktop.exe" --expose-internals "D:\Apps\DSH\DSH Desktop\resources\app\lib\desktop-cli.js" %*
exit /b %errorlevel%
