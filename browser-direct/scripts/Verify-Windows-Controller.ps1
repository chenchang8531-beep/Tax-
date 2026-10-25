# Read-only current process status. Does not open Xero pages or print any token.
param([string]$Root=(Join-Path $env:LOCALAPPDATA 'LimingBrowserDirect'),[string]$Version='0.4.0')
$ErrorActionPreference='Stop'
$probe=Join-Path (Join-Path (Join-Path $Root 'versions') ('v'+$Version)) 'runtime\scripts\inspect-chrome-owner.ps1'
if(!(Test-Path -LiteralPath $probe)){throw 'PROBE_NOT_STAGED'}
$owner=& $probe -Port 9222 | ConvertFrom-Json
$listener=@(Get-NetTCPConnection -LocalPort 59422 -State Listen -ErrorAction SilentlyContinue)
@{version=$Version;chrome_9222_pid=$owner.pid;chrome_port_listening=$owner.listening;chrome_process_is_chrome=([IO.Path]::GetFileName([string]$owner.exe) -ieq 'chrome.exe');local_mcp_59422_listening=($listener.Count -gt 0);tunnel_and_frontend_unverified=$true;read_only=$true}|ConvertTo-Json -Compress|Write-Output
