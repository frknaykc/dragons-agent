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
    $stage = 'selection-control'
    $button = $null
    do {
      $button = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.AndCondition]::new(
          [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1'),
          [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
      if (-not $button -or -not $button.Current.IsEnabled) { Start-Sleep -Milliseconds 100 }
    } until (($button -and $button.Current.IsEnabled) -or [DateTime]::UtcNow -gt $deadline)
    if (-not $button -or -not $button.Current.IsEnabled) { throw 'Native selection button unavailable' }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  }
  Write-Output "NATIVE_PICKER_DRIVEN $Mode"
} catch {
  Write-Output "NATIVE_PICKER_DIAGNOSTIC stage=$stage"
  if ($dialog -and $stage -eq 'selection-control') {
    try {
      $controls = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $summary = @()
      foreach ($control in $controls) {
        $type = $control.Current.ControlType.ProgrammaticName
        if ($type -in @('ControlType.Button', 'ControlType.SplitButton')) {
          $id = if ($control.Current.AutomationId -match '^\d{1,8}$') { $control.Current.AutomationId } else { 'non-numeric' }
          $label = if ($control.Current.Name -in @('Select Folder', 'Open', 'Cancel', 'Select', 'Choose', 'OK')) { $control.Current.Name } else { 'other' }
          $summary += @{ type=$type; id=$id; label=$label }
        }
      }
      Write-Output ('NATIVE_PICKER_DIAGNOSTIC ' + (ConvertTo-Json -InputObject $summary -Compress))
    } catch { Write-Output 'NATIVE_PICKER_DIAGNOSTIC controls-unavailable' }
  }
  exit 1
}
