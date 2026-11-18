# Packaged Windows build in Windows Sandbox (INS-20)

A packaged MVS build must never run on the owner's PC or any developer's PC. It ignores `MVS_TEST_USER_DATA`, uses the real `%APPDATA%\MVS` profile, and writes the identity to Windows Credential Manager. This harness runs a release in **Windows Sandbox** instead. The sandbox is a throwaway VM, and everything in it is gone when it closes.

```powershell
powershell -ExecutionPolicy Bypass -File qa\windows-sandbox\run.ps1 -Tag v0.4.5
powershell -ExecutionPolicy Bypass -File qa\windows-sandbox\run.ps1 -Zip D:\builds\mvs-0.4.6-windows-x86_64.zip
```

## What it checks

`inside.ps1` runs in the sandbox at logon and writes `result.json`. `run.ps1` prints each check as PASS or FAIL, and exits 1 if any check fails.

| Check | Pass when |
| --- | --- |
| unpacked | The zip holds `mvs.exe` and `resources\mvs-core.exe` |
| app version | `mvs.exe`'s ProductVersion is the version in the zip's name |
| core answers | `mvs-core.exe` started on its own (offline, temp data dir) answers `getAppInfo` with that version |
| app running | `mvs.exe` is still running after start |
| core started by the app | `mvs.exe` has an `mvs-core.exe` child within `-WaitSeconds` (60 by default) |
| core stays up | The same core process is still alive 15 s later, so there is no crash or restart loop |
| window shown | `mvs.exe` has a main window |
| log clean | `%APPDATA%\MVS\logs\mvs.log` has no "core failed to start", "core exited" or "core not found" lines. The log is copied to the results |

## Options

| Option | Effect |
| --- | --- |
| `-Tag vX.Y.Z` | Downloads `mvs-X.Y.Z-windows-x86_64.zip` with `gh` (a draft works too, with gh auth) and checks it against the release's `SHA256SUMS` |
| `-Zip <path>` | Uses a local `mvs-<version>-windows-x86_64.zip`, e.g. a CI artifact |
| `-Network` | Turns the sandbox's networking on, so the app reaches the **live relay** in its `mvs-config.json`. Off by default; use it only with the manager's OK for that run |
| `-KeepOpen` | Leaves the sandbox open after the checks, for manual tests (INS-03, INS-18). Closing the sandbox window throws everything away |
| `-DryRun` | Writes the `.wsb` and stops. Use it to check the harness on a PC without Windows Sandbox |
| `-WaitSeconds`, `-TimeoutMinutes` | How long to wait for the core (default 60 s) and for the whole run (default 10 min) |

## Rules

- **Never on CI.** The script stops when `CI` or `GITHUB_ACTIONS` is set.
- **No secrets.** The sandbox gets three mapped folders:
  - the harness, read-only;
  - the zip plus `options.json`, read-only;
  - an empty results folder, the only writable one.

  Clipboard, printer, microphone and camera are off.
- **No network unless `-Network`.** Without it, the app can't reach any relay; it starts offline, which is enough for these checks.
- **Results stay local.** They go to `qa/windows-sandbox/.build/<time>/results/`, which is git-ignored. The app's own log already hides relay hosts and IPs. Still, don't paste logs from a `-Network` run anywhere public.

## Setup (once per QA PC)

Windows Sandbox needs Windows 11/10 Pro or Enterprise, and virtualisation on in the firmware. **Enabling the feature is the owner's call.** On a PC where the owner agreed, run this as admin, then reboot:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
```

Only one sandbox can run at a time. `run.ps1` refuses to start if one is already open.

## Files

- `run.ps1`: the host side. Gets the zip, writes `.build/<time>/mvs.wsb` from the template, starts the sandbox, waits for `result.json`, and prints it.
- `sandbox.wsb.template`: the sandbox config. A `.wsb` needs absolute host paths, so `run.ps1` fills them in.
- `inside.ps1`: the in-sandbox checks (Windows PowerShell 5.1). When done, it closes MVS and shuts the sandbox down, unless `-KeepOpen` was given.
