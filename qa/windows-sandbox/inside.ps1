# Runs INSIDE Windows Sandbox (the .wsb's LogonCommand); never on a real PC.
# Unpacks the release zip from C:\mvs-in, checks the version, starts MVS,
# checks that the core comes up and stays up, writes C:\results\result.json,
# then shuts the sandbox down (unless options.json says keepOpen).
#
# Windows PowerShell 5.1 (what the sandbox has). No secrets, no network calls
# of its own; with networking disabled the app can't reach any relay.

$ErrorActionPreference = 'Stop'
$InDir = 'C:\mvs-in'
$Results = 'C:\results'
$App = 'C:\mvs'
$checks = New-Object System.Collections.ArrayList
$version = $null
$started = Get-Date

function Add-Check([string]$name, [bool]$ok, [string]$detail) {
  [void]$checks.Add([ordered]@{ name = $name; ok = $ok; detail = $detail })
}

function Write-Result {
  $all = ($checks.Count -gt 0) -and -not ($checks | Where-Object { -not $_.ok })
  $result = [ordered]@{
    ok = [bool]$all
    version = $version
    seconds = [int]((Get-Date) - $started).TotalSeconds
    checks = @($checks)
  }
  $json = $result | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText((Join-Path $Results 'result.json'), $json, (New-Object System.Text.UTF8Encoding $false))
}

# One request to the core over its stdin/stdout line protocol; the answer's
# `ok`, or $null. Uses its own data dir; no --relay, so it stays offline.
function Invoke-CoreOnce([string]$exe, [string]$cmd) {
  $dataDir = Join-Path $env:TEMP 'mvs-core-probe'
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = "--data-dir `"$dataDir`""
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  try {
    $p.StandardInput.WriteLine((@{ id = 1; cmd = $cmd; args = @{} } | ConvertTo-Json -Compress))
    $p.StandardInput.Flush()
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
      $task = $p.StandardOutput.ReadLineAsync()
      if (-not $task.Wait(1000)) { continue }
      $line = $task.Result
      if ($null -eq $line) { break }
      try { $msg = $line | ConvertFrom-Json } catch { continue }
      if ($msg.id -eq 1) {
        if ($msg.PSObject.Properties.Name -contains 'error') { return $null }
        return $msg.ok
      }
    }
    return $null
  } finally {
    if (-not $p.HasExited) { $p.Kill() }
  }
}

function Get-Children([int]$parentId) {
  @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId")
}

$options = @{ keepOpen = $false; waitSeconds = 60 }
try {
  $optFile = Join-Path $InDir 'options.json'
  if (Test-Path $optFile) {
    $o = Get-Content $optFile -Raw | ConvertFrom-Json
    if ($o.keepOpen -eq $true) { $options.keepOpen = $true }
    if ($o.waitSeconds -is [int] -and $o.waitSeconds -ge 10 -and $o.waitSeconds -le 600) { $options.waitSeconds = $o.waitSeconds }
  }

  # 1. Exactly one release zip; the version comes from its name.
  $zips = @(Get-ChildItem $InDir -Filter 'mvs-*-windows-x86_64.zip')
  if ($zips.Count -ne 1) { throw "expected one mvs-<version>-windows-x86_64.zip in $InDir, found $($zips.Count)" }
  if ($zips[0].Name -notmatch '^mvs-(\d+\.\d+\.\d+)-windows-x86_64\.zip$') { throw "unexpected zip name $($zips[0].Name)" }
  $version = $Matches[1]
  Expand-Archive -Path $zips[0].FullName -DestinationPath $App -Force
  $exe = Join-Path $App 'mvs.exe'
  $coreExe = Join-Path $App 'resources\mvs-core.exe'
  Add-Check 'unpacked' ((Test-Path $exe) -and (Test-Path $coreExe)) 'mvs.exe and resources\mvs-core.exe'

  # 2. The app's own version.
  $fileVersion = (Get-Item $exe).VersionInfo.ProductVersion
  Add-Check 'app version' ($fileVersion -like "$version*") "mvs.exe ProductVersion $fileVersion"

  # 3. The core answers, offline, with the same version.
  $info = Invoke-CoreOnce $coreExe 'getAppInfo'
  $coreVersion = if ($info) { $info.version } else { $null }
  Add-Check 'core answers' ($coreVersion -eq $version) "getAppInfo version $coreVersion"

  # 4. MVS starts, and its core comes up and stays up (no restarts).
  $mvs = Start-Process -FilePath $exe -PassThru
  $deadline = (Get-Date).AddSeconds($options.waitSeconds)
  $core = $null
  while ((Get-Date) -lt $deadline -and -not $core) {
    Start-Sleep -Seconds 2
    $core = Get-Children $mvs.Id | Where-Object { $_.Name -eq 'mvs-core.exe' } | Select-Object -First 1
  }
  Add-Check 'app running' (-not $mvs.HasExited) "mvs.exe pid alive after start"
  Add-Check 'core started by the app' ($null -ne $core) 'an mvs-core.exe child of mvs.exe'
  if ($core) {
    Start-Sleep -Seconds 15
    $still = Get-Process -Id $core.ProcessId -ErrorAction SilentlyContinue
    Add-Check 'core stays up' ($null -ne $still) 'the same mvs-core.exe 15 s later'
  }
  $window = Get-Process -Name 'mvs' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  Add-Check 'window shown' ($null -ne $window) 'an mvs.exe main window'

  # 5. The app's log: no core start failures or crashes. (The app already
  # hides relay hosts and IPs in it.)
  $log = Join-Path $env:APPDATA 'MVS\logs\mvs.log'
  if (Test-Path $log) {
    Copy-Item $log (Join-Path $Results 'mvs.log')
    $bad = @(Select-String -Path $log -Pattern 'core failed to start|core exited|not found; core commands')
    Add-Check 'log clean' ($bad.Count -eq 0) "$($bad.Count) core failure lines"
  } else {
    Add-Check 'log clean' $true 'no mvs.log written'
  }
} catch {
  Add-Check 'harness' $false $_.Exception.Message
} finally {
  Write-Result
  if (-not $options.keepOpen) {
    Get-Process -Name 'mvs', 'mvs-core' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    shutdown.exe /s /t 5 | Out-Null
  }
}
