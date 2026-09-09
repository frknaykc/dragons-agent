# Opt-in real NSIS lifecycle check, restricted to disposable GitHub-hosted Windows runners.
# Uses the existing isolated, credential-free installed-app smoke; never accepts manual deletion as uninstall.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'NSIS acceptance requires a disposable GitHub-hosted Windows runner.'
}
$repo = Split-Path $PSScriptRoot -Parent
$installers = @(Get-ChildItem -LiteralPath (Join-Path $repo 'desktop-artifacts') -Filter '*-win-x64.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one Windows x64 NSIS artifact.' }
# Do not replace an existing installation, even on a runner.
$existing = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'Dragons Agent' })
if ($existing.Count -ne 0) { throw 'Existing Dragons installation found; refusing lifecycle acceptance.' }
$root = Join-Path $env:RUNNER_TEMP ('dragons-nsis-' + [guid]::NewGuid().ToString('N'))
$install = Join-Path $root 'app'
# NSIS /D= and _?= require an unquoted final argument. Fail rather than reinterpret an ambiguous path.
if ($root -match '[\s"]') { throw 'NSIS acceptance requires a temporary path without whitespace or quotes.' }
New-Item -ItemType Directory -Path $root | Out-Null
$complete = $false
$attempted = $false
$uninstalled = $false
function Invoke-BoundedInstaller([string] $File, [string[]] $Arguments) {
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
  if (-not $process.WaitForExit(120000)) {
    $process.Kill($true)
    throw 'NSIS process timed out; cleanup is not accepted.'
  }
  if ($process.ExitCode -ne 0) { throw 'NSIS process returned a nonzero exit code.' }
}
try {
  $attempted = $true
  Invoke-BoundedInstaller $installers[0].FullName @('/S', "/D=$install")
  $executable = Join-Path $install 'Dragons Agent.exe'
  $archive = Join-Path $install 'resources/app.asar'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf) -or -not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw 'NSIS did not install the application at the requested destination.'
  }
  & node (Join-Path $PSScriptRoot 'verify-desktop-package.mjs') $archive
  if ($LASTEXITCODE -ne 0) { throw 'Installed archive verification failed.' }
  & node (Join-Path $PSScriptRoot 'verify-desktop-installed.mjs') $executable
  if ($LASTEXITCODE -ne 0) { throw 'Installed executable smoke failed.' }
  $complete = $true
} finally {
  try {
    $uninstallers = @(Get-ChildItem -LiteralPath $install -Filter '*Uninstall*.exe' -File -ErrorAction SilentlyContinue)
    if ($uninstallers.Count -ne 1) { throw 'No unique NSIS uninstaller; retaining uncertain installation.' }
    # _?= runs the actual uninstaller in place (no detached temp-copy child), so its exit is authoritative.
    Invoke-BoundedInstaller $uninstallers[0].FullName @('/S', "_?=$install")
    if ((Test-Path -LiteralPath (Join-Path $install 'Dragons Agent.exe')) -or
        (Test-Path -LiteralPath (Join-Path $install 'resources/app.asar'))) {
      throw 'Application payload remains after NSIS uninstall.'
    }
    $remaining = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
      Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'Dragons Agent' })
    if ($remaining.Count -ne 0) { throw 'Application uninstall registration remains.' }
    # In-place NSIS cannot delete its own executable. Only that exact known residual may be removed manually.
    $residue = @(Get-ChildItem -LiteralPath $install -Recurse -File -ErrorAction SilentlyContinue)
    if (@($residue | Where-Object { $_.FullName -ne $uninstallers[0].FullName }).Count -ne 0) {
      throw 'Unexpected payload residue after NSIS uninstall.'
    }
    $uninstalled = $true
    Write-Output 'NSIS_UNINSTALL_VERIFIED'
  } catch {
    Write-Output "NSIS_CLEANUP_INCOMPLETE retained=$root"
    throw
  } finally {
    if ($uninstalled) { Remove-Item -LiteralPath $root -Recurse -Force }
  }
}
if (-not $attempted -or -not $complete -or -not $uninstalled) { throw 'Incomplete NSIS lifecycle.' }
Write-Output 'NSIS_LIFECYCLE_PASS install / archive / isolated READ smoke / real uninstall / payload and registration removal'
