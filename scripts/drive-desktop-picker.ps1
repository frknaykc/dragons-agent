param(
  [Parameter(Mandatory=$true)][int]$ApplicationPid,
  [Parameter(Mandatory=$true)][ValidateSet('cancel','select')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$Workspace
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PickerFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
try {
  $stage = 'dialog-discovery'
  if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Hosted runner required' }
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $dialog = $null
  do {
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ApplicationPid))
    foreach ($window in $windows) {
      if ($window.Current.Name -eq 'Choose a Dragons workspace') { $dialog = $window; break }
    }
    if (-not $dialog) { Start-Sleep -Milliseconds 100 }
  } until ($dialog -or [DateTime]::UtcNow -gt $deadline)
  if (-not $dialog) { throw 'Native dialog unavailable' }
  $stage = 'dialog-focus'
  $handle = [IntPtr]$dialog.Current.NativeWindowHandle
  [void][PickerFocus]::SetForegroundWindow($handle)
  if ([PickerFocus]::GetForegroundWindow() -ne $handle) { throw 'Native dialog focus unavailable' }
  if ($Mode -eq 'cancel') {
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  } else {
    $stage = 'directory-navigation'
    # Navigate through the real shell dialog; never pass a workspace to the application.
    [System.Windows.Forms.SendKeys]::SendWait('^l')
    $escaped = [regex]::Replace($Workspace, '[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' })
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    $stage = 'keyboard-confirmation'
    # Hosted Windows exposes the dialog but an empty UIA descendant tree.
    # Use its native Select Folder accelerator; persisted session binding is the oracle.
    if ([PickerFocus]::GetForegroundWindow() -ne $handle) { throw 'Native dialog lost focus' }
    [System.Windows.Forms.SendKeys]::SendWait('%s')
  }
  Write-Output "NATIVE_PICKER_DRIVEN $Mode"
} catch {
  Write-Output "NATIVE_PICKER_DIAGNOSTIC stage=$stage"
  exit 1
}
