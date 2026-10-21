@echo off
REM ============================================================
REM  SnowLuma + 隔离 QQ 实例 一键启动
REM  隔离数据目录: %LOCALAPPDATA%\QQ-SnowLuma
REM  启动后 10 秒自动挂接 SnowLuma 到该 QQ 进程
REM ============================================================
setlocal
set "QQEXE=C:\Program Files\Tencent\QQNT\QQ.exe"
set "QQDATA=%LOCALAPPDATA%\QQ-SnowLuma"
set "SLDIR=C:\Apps\snowluma"

REM ---- 1. 若隔离 QQ 实例未运行，则启动 ----
tasklist /FI "IMAGENAME eq QQ.exe" 2>nul | find /I "QQ.exe" >nul
powershell -NoProfile -Command ^
  "$p = Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" | Where-Object { $_.CommandLine -match 'QQ-SnowLuma' }; if (-not $p) { Start-Process -FilePath '%QQEXE%' -ArgumentList '--user-data-dir=%QQDATA%' -WorkingDirectory 'C:\Program Files\Tencent\QQNT'; Write-Host 'launched isolated QQ' } else { Write-Host ('isolated QQ already running: PID ' + ($p.ProcessId -join ',')) }"

REM ---- 2. 启动 SnowLuma（若未运行） ----
powershell -NoProfile -Command ^
  "$n = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'snowluma' -or $_.CommandLine -match 'index.mjs' }; if (-not $n) { Start-Process -FilePath '%SLDIR%\node.exe' -ArgumentList 'index.mjs' -WorkingDirectory '%SLDIR%' -WindowStyle Hidden; Write-Host 'launched SnowLuma' } else { Write-Host ('SnowLuma already running: PID ' + ($n.ProcessId -join ',')) }"

endlocal
