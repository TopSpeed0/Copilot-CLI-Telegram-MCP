# start-copilot-daemon.ps1 — Launch the Copilot CLI Telegram daemon
param([switch]$Background)

$DaemonScript = Join-Path $PSScriptRoot "copilot-task-daemon.js"
$LockFile     = Join-Path $PSScriptRoot "..\\.copilot-daemon.lock"

# Kill any previous instance
if (Test-Path $LockFile) {
  $prev = [int](Get-Content $LockFile -ErrorAction SilentlyContinue)
  if ($prev) {
    try { Stop-Process -Id $prev -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Milliseconds 500
  }
  Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}

if ($Background) {
  $proc = Start-Process node -ArgumentList "--use-system-ca $DaemonScript" `
    -WorkingDirectory (Split-Path $DaemonScript) `
    -WindowStyle Hidden -PassThru
  Write-Host "Copilot daemon started in background (PID=$($proc.Id))"
} else {
  Write-Host "Starting Copilot CLI Telegram daemon (Ctrl+C to stop)..."
  node --use-system-ca $DaemonScript
}
