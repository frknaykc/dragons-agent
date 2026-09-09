$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'desktop-nsis-cleanup.ps1')
$fixtures = Join-Path ([IO.Path]::GetTempPath()) ('dragons-nsis-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtures | Out-Null
try {
  foreach ($case in @('known-only', 'directory-absent', 'hidden-payload', 'root-payload', 'enumeration-error')) {
    $root = Join-Path $fixtures $case
    $app = Join-Path $root 'app'
    New-Item -ItemType Directory -Path $app -Force | Out-Null
    $known = Join-Path $app 'Uninstall Dragons Agent.exe'
    [IO.File]::WriteAllText($known, 'synthetic uninstaller fixture')
    if ($case -eq 'directory-absent') {
      [IO.File]::Delete($known)
      [IO.Directory]::Delete($app, $false)
    }
    $payload = $null
    if ($case -eq 'hidden-payload') {
      $payload = Join-Path $app '.payload'
      [IO.File]::WriteAllText($payload, 'synthetic residue')
      if ($IsWindows) { [IO.File]::SetAttributes($payload, [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System) }
    }
    if ($case -eq 'root-payload') {
      $payload = Join-Path $root 'unexpected.txt'
      [IO.File]::WriteAllText($payload, 'synthetic residue')
    }
    $rejected = $false
    try {
      if ($case -eq 'enumeration-error') {
        & {
          function Get-ChildItem { throw 'Injected enumeration failure' }
          Remove-VerifiedNsisResidue $root $known
        }
      } else { Remove-VerifiedNsisResidue $root $known }
    } catch { $rejected = $true }
    if ($case -in @('known-only', 'directory-absent')) {
      if ($rejected -or (Test-Path -LiteralPath $root)) { throw "Successful cleanup failed: $case" }
    } else {
      if (-not $rejected -or -not (Test-Path -LiteralPath $known)) { throw "Unsafe cleanup accepted: $case" }
      if ($null -ne $payload -and -not (Test-Path -LiteralPath $payload)) { throw "Payload was removed: $case" }
    }
    Write-Output "NSIS_CLEANUP_REGRESSION_PASS $case"
  }
} finally {
  # Only test-owned synthetic fixtures, never the real installer acceptance root.
  Remove-Item -LiteralPath $fixtures -Recurse -Force
}
