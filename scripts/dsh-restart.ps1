$ErrorActionPreference = 'Continue'
$LOG = 'C:\Apps\snowluma\logs\dsh-restart.log'
function L($m) { Add-Content -Path $LOG -Value ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 }

L 'restart requested'
Start-Sleep -Seconds 4

$exe = 'D:\Apps\DSH\DSH Desktop\DSH Desktop.exe'
$mains = @(Get-CimInstance Win32_Process -Filter "Name='DSH Desktop.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' })
foreach ($m in $mains) {
    L "killing main pid $($m.ProcessId)"
    Stop-Process -Id $m.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 5

$left = @(Get-Process 'DSH Desktop' -ErrorAction SilentlyContinue)
if ($left.Count -gt 0) {
    L "forcing remaining $($left.Count) processes"
    $left | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

L 'launching DSH Desktop'
Start-Process -FilePath $exe -WorkingDirectory 'D:\Apps\DSH\DSH Desktop'
Start-Sleep -Seconds 20

$ok = $false
for ($i = 0; $i -lt 10; $i++) {
    try {
        $r = Invoke-WebRequest 'http://127.0.0.1:43120/' -UseBasicParsing -TimeoutSec 4
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { Start-Sleep -Seconds 3 }
}
$running = @(Get-CimInstance Win32_Process -Filter "Name='DSH Desktop.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' }).Count
L ("done: gui_http200=$ok main_processes=$running")
