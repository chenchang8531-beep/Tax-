# Staged Windows desktop process. Does NOT modify Chrome, CCOS or Xero.
param(
 [string]$Root=(Join-Path $env:LOCALAPPDATA 'LimingBrowserDirect'),
 [string]$Version='0.4.0',
 [Parameter(Mandatory=$true)][string]$ExpectedUserDataDir,
 [string]$ExpectedProfileDirectory='',
 [string]$ExpectedChromeExe=''
)
$ErrorActionPreference='Stop'
$versionDir=Join-Path (Join-Path $Root 'versions') ('v'+$Version)
$entry=Join-Path $versionDir 'runtime\src\mcp-server.mjs'
if(!(Test-Path -LiteralPath $entry -PathType Leaf)){throw 'STAGED_SERVER_NOT_FOUND'}
$existing=@(Get-NetTCPConnection -LocalPort 59422 -State Listen -ErrorAction SilentlyContinue)
if($existing.Count -gt 0){throw 'PORT_59422_ALREADY_BOUND_DO_NOT_KILL_OTHER_PROCESS'}
$node=(Get-Command node -ErrorAction Stop).Source
if([version]((& $node --version).TrimStart('v')) -lt [version]'22.5.0'){throw 'NODE_22_5_REQUIRED'}
$secretsDir=Join-Path $Root 'secrets';$runtimeDir=Join-Path $Root 'state'
New-Item -ItemType Directory -Path $secretsDir,$runtimeDir -Force|Out-Null
$tokenFile=Join-Path $secretsDir 'local-mcp-token.dpapi'
if(!(Test-Path -LiteralPath $tokenFile)){
 $plain=[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
 $encrypted=(ConvertTo-SecureString $plain -AsPlainText -Force)|ConvertFrom-SecureString
 [IO.File]::WriteAllText($tokenFile,$encrypted,[Text.Encoding]::UTF8)
 $plain=$null
}
$secure=Get-Content -LiteralPath $tokenFile -Raw -Encoding UTF8|ConvertTo-SecureString
$bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try{$env:LIMING_BROWSER_TOKEN=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)}
$env:LIMING_EXPECTED_CHROME_USER_DATA_DIR=$ExpectedUserDataDir
$env:LIMING_EXPECTED_CHROME_PROFILE_DIRECTORY=$ExpectedProfileDirectory
$env:LIMING_EXPECTED_CHROME_EXE=$ExpectedChromeExe
$env:LIMING_BROWSER_PORT='59422'
$env:LIMING_ACTION_LEDGER_PATH=(Join-Path $runtimeDir 'action-wal.jsonl')
$env:LIMING_TASK_LEDGER_PATH=(Join-Path $runtimeDir 'task-tabs-wal.jsonl')
$env:LIMING_ALLOWED_ORIGINS=''
$stdout=Join-Path $runtimeDir 'server-stdout.log';$stderr=Join-Path $runtimeDir 'server-stderr.log'
try {
 $proc=Start-Process -FilePath $node -ArgumentList @('runtime/src/mcp-server.mjs') -WorkingDirectory $versionDir -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -ErrorAction Stop
 @{state='STARTED_NOT_ATTESTED';pid=$proc.Id;port=59422;entry=$entry;token_protected_in_local_dpapi=$true;user_data_dir_check='INITIAL_EXCEPTION_FINAL'}|ConvertTo-Json -Compress|Write-Output
}finally{
 Remove-Item Env:LIMING_BROWSER_TOKEN -ErrorAction SilentlyContinue
 Remove-Item Env:LIMING_GATEWAY_AGENT_TOKEN -ErrorAction SilentlyContinue
}
