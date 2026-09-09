# Shared by the NSIS acceptance and disposable filesystem regression fixtures.
function Remove-VerifiedNsisResidue([string] $Root, [string] $Uninstaller) {
  $rootPath = [IO.Path]::GetFullPath($Root)
  $knownPath = [IO.Path]::GetFullPath($Uninstaller)
  if (-not $knownPath.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Uninstaller must be inside the acceptance root.'
  }
  $rootItem = Get-Item -LiteralPath $rootPath -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Acceptance root must be a regular directory.'
  }
  $pending = [Collections.Generic.Stack[string]]::new()
  $directories = [Collections.Generic.List[string]]::new()
  $knownFile = $null
  $pending.Push($rootPath)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    $directories.Add($directory)
    # Include hidden/system entries; traversal errors fail closed before any deletion.
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected reparse-point residue.' }
      if ($item.PSIsContainer) {
        $pending.Push($item.FullName)
      } elseif ($item.FullName -eq $knownPath) {
        $knownFile = $item.FullName
      } else {
        throw 'Unexpected payload residue after NSIS uninstall.'
      }
    }
  }
  # Only the exact known uninstaller file may be deleted manually. Never recursively delete the root.
  if ($null -ne $knownFile) { [IO.File]::Delete($knownFile) }
  for ($i = $directories.Count - 1; $i -ge 0; $i--) {
    [IO.Directory]::Delete($directories[$i], $false)
  }
}
