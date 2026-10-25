# Outbound HTTPS reverse tunnel; never exposes 9222 or stores plaintext secrets in GitHub.
param(
 [Parameter(Mandatory=$true)][string]$GatewayUrl,
 [Parameter(Mandatory=$true)][string]$AgentId,
 [string]$Root=(Join-Path $env:LOCALAPPDATA 'LimingBrowserDirect'),
 [string]$Version='0.3.1'
)
$ErrorActionPreference='Stop'
if(-not $GatewayUrl.StartsWith('https://')){throw 'GATEWAY_HTTPS_REQUIRED'}
$versionDir=Join-Path (Join-Path $Root 'versions') ('v'+$Version)
$entry=Join-Path $versionDir 'tunnel\agent.mjs'
if(!(Test-Path -LiteralPath $entry -PathType Leaf)){throw 'AGENT_NOT_STAGED'}
$tokenA=Join-Path $Root 'secrets\local-mcp-token.dpapi'
$tokenB=Join-Path $Root 'secrets\gateway-agent.dpapi'
if(!(Test-Path $tokenA) -or !(Test-Path $tokenB)){throw 'LOCAL_DPAPI_TOKEN_MISSING'}
function Reveal([string]$file){
 $secure=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertTo-SecureString
 $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
 try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)}
}
$env:LIMING_BROWSER_TOKEN=Reveal $tokenA
$env:LIMING_GATEWAY_AGENT_TOKEN=Reveal $tokenB
$env:LIMING_GATEWAY_URL=$GatewayUrl
$env:LIMING_GATEWAY_AGENT_ID=$AgentId
$dir=Join-Path $Root 'state';New-Item -ItemType Directory -Path $dir -Force|Out-Null
try {
 $node=(Get-Command node -ErrorAction Stop).Source
 $proc=Start-Process -FilePath $node -ArgumentList @('tunnel/agent.mjs') -WorkingDirectory $versionDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir 'agent-stdout.log') -RedirectStandardError (Join-Path $dir 'agent-stderr.log') -PassThru
 @{state='AGENT_STARTED_NOT_CONNECTED_UNTIL_RECEIPT';pid=$proc.Id;gateway_tls_required=$true;cdp_exposed=$false}|ConvertTo-Json -Compress|Write-Output
}finally{Remove-Item Env:LIMING_BROWSER_TOKEN -ErrorAction SilentlyContinue;Remove-Item Env:LIMING_GATEWAY_AGENT_TOKEN -ErrorAction SilentlyContinue}
