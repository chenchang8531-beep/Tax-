# Safe side-by-side staging, NOT a Live promotion; no Chrome/CCOS/Tunnel changes.
param(
 [Parameter(Mandatory=$true)][string]$ZipPath,
 [string]$Root=(Join-Path $env:LOCALAPPDATA 'LimingBrowserDirect'),
 [string]$Version='0.3.1'
)
$ErrorActionPreference='Stop'
if(!(Test-Path -LiteralPath $ZipPath -PathType Leaf)){throw 'ZIP_NOT_FOUND'}
if($Version -ne '0.3.1'){throw 'VERSION_MISMATCH'}
$versions=Join-Path $Root 'versions';$target=Join-Path $versions ('v'+$Version)
if(Test-Path -LiteralPath $target){throw 'EXISTING_VERSION_NOT_OVERWRITTEN'}
$staging=Join-Path $Root ('staging_'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
 Expand-Archive -LiteralPath $ZipPath -DestinationPath $staging -Force
 $manifestPath=Join-Path $staging 'SHA256_MANIFEST.json'
 if(!(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw 'MANIFEST_MISSING'}
 $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
 if($manifest.version -ne $Version){throw 'MANIFEST_VERSION_MISMATCH'}
 $files=@($manifest.files);if($files.Count -lt 20){throw 'MANIFEST_TOO_SMALL'}
 foreach($item in $files){
  $rel=[string]$item.path
  if([IO.Path]::IsPathRooted($rel) -or $rel.Contains('..') -or $rel.Contains(':')){throw 'UNSAFE_MANIFEST_PATH'}
  $full=Join-Path $staging $rel
  if(!(Test-Path -LiteralPath $full -PathType Leaf)){throw ('MISSING_SOURCE: '+$rel)}
  $actual=(Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
  if($actual -ne [string]$item.sha256){throw ('HASH_MISMATCH: '+$rel)}
 }
 New-Item -ItemType Directory -Path $versions -Force | Out-Null
 Move-Item -LiteralPath $staging -Destination $target -ErrorAction Stop
 $receipt=@{status='STAGED_ONLY';version=$Version;path=$target;files=$files.Count;verified_at=(Get-Date).ToUniversalTime().ToString('o');chrome_changed=$false;tunnel_changed=$false}
 $receipt|ConvertTo-Json -Compress | Write-Output
} catch {
 Write-Error ('STAGE_FAILED: '+$_.Exception.Message)
 throw
}
