# Read-only exact loopback owner probe. Does NOT emit raw command line or credentials to ChatGPT.
param([ValidateRange(1,65535)][int]$Port=9222)
$ErrorActionPreference='Stop'
try {
  $connections=@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1') })
  $uniqueOwners=@($connections | Select-Object -ExpandProperty OwningProcess -Unique)
  if($uniqueOwners.Count -ne 1){@{listening=$false;pid=0;exe=$null;commandLine=$null}|ConvertTo-Json -Compress;exit 0}
  $ownerPid=[int]$uniqueOwners[0]
  $proc=Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop
  if($null -eq $proc){@{listening=$false;pid=0;exe=$null;commandLine=$null}|ConvertTo-Json -Compress;exit 0}
  # Parse only the two required Chrome switches locally; never emit the full command line.
  $userData = $null; $profileDir = $null
  $m = [regex]::Match([string]$proc.CommandLine, '(?:^|\s)--user-data-dir=(?:"([^"]+)"|(\S+))', 'IgnoreCase')
  if($m.Success){$userData = if($m.Groups[1].Success){$m.Groups[1].Value}else{$m.Groups[2].Value}}
  $m = [regex]::Match([string]$proc.CommandLine, '(?:^|\s)--profile-directory=(?:"([^"]+)"|(\S+))', 'IgnoreCase')
  if($m.Success){$profileDir = if($m.Groups[1].Success){$m.Groups[1].Value}else{$m.Groups[2].Value}}
  @{listening=$true;pid=$ownerPid;exe=[string]$proc.ExecutablePath;userDataDir=$userData;profileDirectory=$profileDir}|ConvertTo-Json -Compress -Depth 3
} catch { [Console]::Error.WriteLine('OWNER_PROBE_FAILED');exit 2 }
