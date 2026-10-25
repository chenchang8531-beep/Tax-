# Called only after private cloud gateway token has been provisioned separately.
param([string]$Root=(Join-Path $env:LOCALAPPDATA 'LimingBrowserDirect'))
$ErrorActionPreference='Stop'
$secret=Read-Host 'Enter the separate private gateway Agent token (not the frontend token)' -AsSecureString
if($secret.Length -lt 32){throw 'AGENT_TOKEN_TOO_SHORT'}
$dir=Join-Path $Root 'secrets';New-Item -ItemType Directory -Path $dir -Force|Out-Null
$encrypted=$secret|ConvertFrom-SecureString
[IO.File]::WriteAllText((Join-Path $dir 'gateway-agent.dpapi'),$encrypted,[Text.Encoding]::UTF8)
@{state='ENCRYPTED_LOCALLY';file='gateway-agent.dpapi';printed_secret=$false}|ConvertTo-Json -Compress|Write-Output
