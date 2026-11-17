<#
.SYNOPSIS
  Runs a packaged MVS release inside Windows Sandbox and checks that it starts
  (qa/windows-sandbox/README.md). A packaged build must never run on a real
  PC: it ignores MVS_TEST_USER_DATA and writes its identity to Credential
  Manager. The sandbox is thrown away when it closes.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File qa\windows-sandbox\run.ps1 -Tag v0.4.5
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File qa\windows-sandbox\run.ps1 -Zip D:\builds\mvs-0.4.6-windows-x86_64.zip -KeepOpen
#>
[CmdletBinding()]
param(
  # A release tag: its windows zip is downloaded with gh and checked against SHA256SUMS.
  [string]$Tag,
  # Or a local mvs-<version>-windows-x86_64.zip.
  [string]$Zip,
  # Let the sandbox reach the network, so the app talks to the live relay in
  # its mvs-config.json. Off by default; only with the manager's OK.
  [switch]$Network,
  # Leave the sandbox open after the checks, for exploratory testing.
  [switch]$KeepOpen,
  # Generate the .wsb and stop (no sandbox): for checking the harness itself.
  [switch]$DryRun,
  # How long to wait for the core to come up inside, in seconds.
  [ValidateRange(10, 600)][int]$WaitSeconds = 60,
  # How long to wait for the whole run, in minutes.
  [ValidateRange(1, 60)][int]$TimeoutMinutes = 10
)

$ErrorActionPreference = 'Stop'
if ($env:CI -or $env:GITHUB_ACTIONS) { throw 'qa/windows-sandbox is for a QA PC, not CI.' }
if ([bool]$Tag -eq [bool]$Zip) { throw 'Give exactly one of -Tag or -Zip.' }

$here = $PSScriptRoot
$sandboxExe = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'
if (-not $DryRun -and -not (Test-Path $sandboxExe)) {
  throw @'
Windows Sandbox is not enabled on this PC. Turning it on is the owner's call;
as admin: Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
then reboot. (It needs Windows Pro/Enterprise and virtualisation on.)
'@
}
if (-not $DryRun -and (Get-Process -Name 'WindowsSandbox', 'WindowsSandboxClient', 'WindowsSandboxRemoteSession' -ErrorAction SilentlyContinue)) {
  throw 'Windows Sandbox is already running (only one may run at a time). Close it first.'
}

$run = Join-Path $here (".build\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$inDir = Join-Path $run 'in'
$results = Join-Path $run 'results'
New-Item -ItemType Directory -Force -Path $inDir, $results | Out-Null

if ($Tag) {
  if ($Tag -notmatch '^v(\d+\.\d+\.\d+)$') { throw "-Tag must look like v0.4.5, got $Tag" }
  $v = $Matches[1]
  $name = "mvs-$v-windows-x86_64.zip"
  & gh release download $Tag -R moranmoa/MVS -D $inDir -p $name -p SHA256SUMS
  if ($LASTEXITCODE -ne 0) { throw "gh release download $Tag failed" }
  $line = Get-Content (Join-Path $inDir 'SHA256SUMS') | Where-Object { $_ -match "\s\*?$([regex]::Escape($name))$" } | Select-Object -First 1
  if (-not $line) { throw "$name is not in SHA256SUMS" }
  $want = ($line -split '\s+')[0].ToLowerInvariant()
  $got = (Get-FileHash (Join-Path $inDir $name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($want -ne $got) { throw "SHA256 mismatch for $name" }
  Remove-Item (Join-Path $inDir 'SHA256SUMS')
} else {
  $item = Get-Item $Zip
  if ($item.Name -notmatch '^mvs-\d+\.\d+\.\d+-windows-x86_64\.zip$') { throw "-Zip must be a mvs-<version>-windows-x86_64.zip, got $($item.Name)" }
  Copy-Item $item.FullName $inDir
}

$options = [ordered]@{ keepOpen = [bool]$KeepOpen; waitSeconds = $WaitSeconds }
[System.IO.File]::WriteAllText((Join-Path $inDir 'options.json'), ($options | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

# The .wsb: absolute host paths, XML-escaped.
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$wsb = Get-Content (Join-Path $here 'sandbox.wsb.template') -Raw
$wsb = $wsb.Replace('{{NETWORKING}}', $(if ($Network) { 'Default' } else { 'Disable' }))
$wsb = $wsb.Replace('{{HARNESS_DIR}}', (& $esc $here))
$wsb = $wsb.Replace('{{IN_DIR}}', (& $esc $inDir))
$wsb = $wsb.Replace('{{RESULTS_DIR}}', (& $esc $results))
[void][xml]$wsb # must be well-formed
$wsbPath = Join-Path $run 'mvs.wsb'
[System.IO.File]::WriteAllText($wsbPath, $wsb, (New-Object System.Text.UTF8Encoding $false))

if ($Network) { Write-Warning 'Networking is ON: the app will try the live relay in its config.' }
if ($DryRun) {
  Write-Output "Dry run: $wsbPath"
  return
}

Write-Output "Starting Windows Sandbox ($run)..."
Start-Process -FilePath $sandboxExe -ArgumentList "`"$wsbPath`""

$resultFile = Join-Path $results 'result.json'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while (-not (Test-Path $resultFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
if (-not (Test-Path $resultFile)) { throw "No result after $TimeoutMinutes minutes; the sandbox may still be open. See $run" }
Start-Sleep -Seconds 1 # let the write finish
$result = Get-Content $resultFile -Raw | ConvertFrom-Json

foreach ($c in $result.checks) {
  $mark = if ($c.ok) { 'PASS' } else { 'FAIL' }
  Write-Output ("{0}  {1}: {2}" -f $mark, $c.name, $c.detail)
}
Write-Output ("MVS {0}: {1} ({2} s). Results: {3}" -f $result.version, $(if ($result.ok) { 'OK' } else { 'FAILED' }), $result.seconds, $results)
if (-not $result.ok) { exit 1 }
