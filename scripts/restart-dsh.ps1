# 重启 DeepSeek Harness（在独立进程里延时执行，避免被自身进程树带走）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File restart-dsh.ps1 [-Exe <DSH 可执行文件>] [-DelaySeconds 20]
#
# 说明：内置订阅引擎由插件在「启动服务」时拉起（会自动建 venv、装依赖），
# 这个脚本只负责重启 DSH，重启后顺带探一下引擎是否还活着（仅记录，不代管）。
param(
    [string]$Exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe",
    [int]$DelaySeconds = 20
)

$log = Join-Path $env:TEMP "dsh-restart.log"
function Log($msg) { "$(Get-Date -Format 'HH:mm:ss')  $msg" | Out-File -FilePath $log -Append -Encoding utf8 }

Log "等待 $DelaySeconds 秒，让当前回合把答复发完"
Start-Sleep -Seconds $DelaySeconds

Log "停止 DeepSeek Harness 进程"
Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | ForEach-Object {
    Log ("  stop pid " + $_.Id)
    try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch { Log ("  fail: " + $_.Exception.Message) }
}

Start-Sleep -Seconds 5

Log "重新拉起： $Exe"
try {
    $p = Start-Process -FilePath $Exe -PassThru
    Log ("  started pid " + $p.Id)
} catch {
    Log ("  拉起失败: " + $_.Exception.Message)
}

# 引擎是 detached 进程，DSH 重启不一定会带走它；这里只探活并记录，方便判断
# 是否需要到面板里再点一次「启动服务」。
Start-Sleep -Seconds 8
try {
    $api = Invoke-RestMethod "http://127.0.0.1:4001/api/v1/health" -TimeoutSec 4
    Log ("  内置引擎在线: " + ($api | ConvertTo-Json -Compress))
} catch {
    Log "  内置引擎离线（进面板点「启动服务」即可）"
}
Log "完成"