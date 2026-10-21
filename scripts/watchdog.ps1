# SnowLuma + 隔离 QQ 实例 守护脚本
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1
# 功能: 确保隔离QQ在运行 -> 确保SnowLuma在运行 -> 确保已挂接

$ErrorActionPreference = 'SilentlyContinue'

$QQEXE   = 'C:\Program Files\Tencent\QQNT\QQ.exe'
$QQDATA  = Join-Path $env:LOCALAPPDATA 'QQ-SnowLuma'
$SLDIR   = 'C:\Apps\snowluma'
$BASE    = 'http://127.0.0.1:5099'
$PW      = 'REPLACE_WITH_PASSWORD'
$UIN     = '3799652874'
$LOG     = Join-Path $SLDIR 'logs\watchdog.log'

function Log($m) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Write-Host $line
    Add-Content -Path $LOG -Value $line -Encoding UTF8
}

function Get-MyPid($pattern) {
    # 只取主进程：其父进程不在同一批匹配结果里
    $all = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" |
        Where-Object { $_.CommandLine -match $pattern })
    if ($all.Count -eq 0) { return $null }
    $ids = $all.ProcessId
    $main = $all | Where-Object { $ids -notcontains $_.ParentProcessId } |
        Sort-Object CreationDate | Select-Object -First 1
    if ($main) { return $main.ProcessId }
    return ($all | Sort-Object CreationDate | Select-Object -First 1).ProcessId
}

function Get-SnowLumaPid {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match 'index\.mjs' })
    if ($all.Count -eq 0) { return $null }
    $ids = $all.ProcessId
    $main = $all | Where-Object { $ids -notcontains $_.ParentProcessId } |
        Sort-Object CreationDate | Select-Object -First 1
    if ($main) { return $main.ProcessId }
    return ($all | Sort-Object CreationDate | Select-Object -First 1).ProcessId
}

# ---- 1. 隔离 QQ ----
$qqPid = Get-MyPid 'QQ-SnowLuma'
if (-not $qqPid) {
    Log 'isolated QQ not running -> launching'
    Start-Process -FilePath $QQEXE -ArgumentList "--user-data-dir=$QQDATA" -WorkingDirectory 'C:\Program Files\Tencent\QQNT'
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        $qqPid = Get-MyPid 'QQ-SnowLuma'
        if ($qqPid) { break }
    }
    Log "isolated QQ pid = $qqPid"
} else {
    Log "isolated QQ already running: $qqPid"
}

# ---- 2. SnowLuma（由 PM2 托管） ----
if (Get-SnowLumaPid) {
    Log "SnowLuma already running: $(Get-SnowLumaPid)"
} else {
    Log 'SnowLuma not running -> asking pm2 to start/restart'
    $pm2 = 'C:\Users\Hourz26\AppData\Roaming\npm\pm2.cmd'
    if (Test-Path $pm2) {
        # PM2 daemon 可能已被上层 Job Object 连带杀死，列表为空 -> 直接 start 而非 restart
        $names = & $pm2 jlist 2>$null | Out-String
        if ($names -match '"name"\s*:\s*"snowluma"') {
            & $pm2 restart snowluma 2>&1 | Out-Null
        } else {
            & $pm2 start (Join-Path $SLDIR 'ecosystem.config.cjs') 2>&1 | Out-Null
        }
    } else {
        Log 'pm2 missing -> direct launch fallback'
        Start-Process -FilePath (Join-Path $SLDIR 'node.exe') -ArgumentList 'index.mjs' `
            -WorkingDirectory $SLDIR -WindowStyle Hidden
    }
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        if (Get-SnowLumaPid) {
            try { $null = Invoke-WebRequest "$BASE/" -UseBasicParsing -TimeoutSec 3; break } catch {}
        }
    }
    Log "SnowLuma pid = $(Get-SnowLumaPid)"
}

# ---- 2b. HTTP 健康闸门（SnowLuma 会自拉子进程，pm2 只盯包装层） ----
$healthy = $false
for ($i = 0; $i -lt 3; $i++) {
    try {
        $resp = Invoke-WebRequest "$BASE/api/status" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        $healthy = $true; break
    } catch {
        # 401 = 服务活着但需要鉴权，也算健康
        if ($_.Exception.Response.StatusCode.value__ -in @(401, 403)) { $healthy = $true; break }
        Start-Sleep -Seconds 2
    }
}
if (-not $healthy) {
    Log 'HTTP health check failed -> pm2 restart snowluma'
    $pm2 = 'C:\Users\Hourz26\AppData\Roaming\npm\pm2.cmd'
    if (Test-Path $pm2) { & $pm2 restart snowluma 2>&1 | Out-Null }
    Start-Sleep -Seconds 12
    try {
        $null = Invoke-WebRequest "$BASE/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        Log 'recovered after restart'
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -in @(401, 403)) { Log 'recovered after restart' }
        else { Log "still unhealthy: $($_.Exception.Message)" }
    }
} else {
    Log 'http health ok'
}

# ---- 3. 挂接 ----
try {
    $body = @{ username = 'admin'; password = $PW } | ConvertTo-Json
    $tok = $null
    for ($i = 0; $i -lt 15; $i++) {
        try {
            $tok = (Invoke-WebRequest "$BASE/api/login" -Method POST -Body $body `
                -ContentType 'application/json' -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
            if ($tok.token) { break }
        } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $tok.token) { throw 'login failed after retries' }
    Log 'webui login ok'
    $h = @{ Authorization = "Bearer $($tok.token)" }

    $procs = (Invoke-WebRequest "$BASE/api/processes" -Headers $h -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json

    # 3a. 纠正错挂：任何已注入/已连接的非目标账号 -> 先卸载
    #     （不能只看 connected，正在 connecting 的进程稍后也会连上）
    $wrong = @($procs.list | Where-Object {
        $_.account.uin -and $_.account.uin -ne $UIN -and ($_.injected -eq $true -or $_.connected -eq $true)
    })
    foreach ($w in $wrong) {
        Log "WRONG account attached: pid=$($w.pid) uin=$($w.account.uin) -> unloading"
        try {
            $null = Invoke-WebRequest "$BASE/api/processes/$($w.pid)/unload" -Method POST `
                -Headers $h -ContentType 'application/json' -UseBasicParsing -TimeoutSec 60
            Start-Sleep -Seconds 4
        } catch { Log "unload failed: $($_.Exception.Message)" }
    }

    # 3b. 重新取进程列表，找目标账号的进程
    if ($wrong.Count -gt 0) {
        $procs = (Invoke-WebRequest "$BASE/api/processes" -Headers $h -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
    }

    $target = $procs.list | Where-Object { $_.account.uin -eq $UIN } | Select-Object -First 1
    if (-not $target) { $target = $procs.list | Where-Object { $_.pid -eq $qqPid } | Select-Object -First 1 }

    if (-not $target) {
        Log "no attachable process for uin=$UIN"
    } elseif ($target.connected -eq $true) {
        Log "already attached to correct account: pid=$($target.pid) uin=$($target.uin) status=$($target.status)"
    } else {
        Log "attaching pid=$($target.pid) uin=$($target.account.uin)"
        $null = Invoke-WebRequest "$BASE/api/processes/$($target.pid)/load" -Method POST `
            -Headers $h -ContentType 'application/json' -UseBasicParsing -TimeoutSec 60
        Start-Sleep -Seconds 6
        $after = (Invoke-WebRequest "$BASE/api/processes" -Headers $h -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
        $p = $after.list | Where-Object { $_.pid -eq $target.pid } | Select-Object -First 1
        Log "attach result: connected=$($p.connected) loggedIn=$($p.loggedIn) status=$($p.status) uin=$($p.account.uin)"
    }
} catch {
    Log "attach/login step failed: $($_.Exception.Message)"
}

Log 'watchdog done'
