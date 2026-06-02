# start-copilot-daemon.ps1 — launch the Telegram -> GitHub Copilot CLI bridge.
#
# Usage:
#   .\mcp\start-copilot-daemon.ps1            # runs in foreground (current terminal)
#   .\mcp\start-copilot-daemon.ps1 -Background # detaches; logs to mcp/copilot-daemon.log

param(
  [switch]$Background
)

$ErrorActionPreference = 'Stop'
$repo    = Split-Path -Parent $PSScriptRoot
$daemon  = Join-Path $PSScriptRoot 'copilot-task-daemon.js'
$logFile = Join-Path $PSScriptRoot 'copilot-daemon.log'

# Kill any existing daemon so the shortcut acts as a clean restart.
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'copilot-task-daemon\.js' }
foreach ($p in $existing) {
  Write-Host "Stopping previous daemon (PID=$($p.ProcessId), started $($p.CreationDate))"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($existing) { Start-Sleep -Seconds 2 }

# Validate .telegram-config exists (the daemon reads it directly)
$cfgPath = Join-Path $repo '.telegram-config'
if (-not (Test-Path $cfgPath)) { throw ".telegram-config not found in $repo" }
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
if (-not $cfg.bot_token -or -not $cfg.chat_id) { throw ".telegram-config missing bot_token/chat_id" }

Write-Host "Starting Copilot daemon (chat_id=$($cfg.chat_id))"
Write-Host "Workspace: $repo"

if ($Background) {
  $nodeArgs = "--use-system-ca `"$daemon`""
  $proc = Start-Process -FilePath 'node' -ArgumentList $nodeArgs `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" `
    -PassThru
  Write-Host "Detached PID=$($proc.Id). Logs: $logFile"
  Write-Host "Stop with: Stop-Process -Id $($proc.Id)"
} else {
  Set-Location $repo
  & node --use-system-ca $daemon
}
