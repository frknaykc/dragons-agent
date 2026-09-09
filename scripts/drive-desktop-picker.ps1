param(
  [Parameter(Mandatory=$true)][int]$ApplicationPid,
  [Parameter(Mandatory=$true)][ValidateSet('cancel','select')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$Workspace
)
$ErrorActionPreference = 'Stop'
Write-Output 'NATIVE_PICKER_DIAGNOSTIC stage=automation-initialization'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PickerFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct GuiInfo {
    public int Size, Flags;
    public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
    public Rect CaretRect;
  }
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr handle, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder text, int capacity);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, UIntPtr capacity, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  public static IntPtr FocusedEdit(IntPtr dialog) {
    uint pid;
    uint thread = GetWindowThreadProcessId(dialog, out pid);
    var info = new GuiInfo { Size = Marshal.SizeOf(typeof(GuiInfo)) };
    if (thread == 0 || !GetGUIThreadInfo(thread, ref info) || GetAncestor(info.Focus, 2) != dialog) return IntPtr.Zero;
    var name = new StringBuilder(128);
    GetClassName(info.Focus, name, name.Capacity);
    return name.ToString() == "Edit" ? info.Focus : IntPtr.Zero;
  }
  public static bool ContainsPath(IntPtr edit, string expected) {
    var text = new StringBuilder(4096);
    UIntPtr result;
    return edit != IntPtr.Zero && SendMessageTimeout(edit, 13, (UIntPtr)text.Capacity, text, 2, 1000, out result) != IntPtr.Zero && text.ToString() == expected;
  }
  delegate bool EnumWindow(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindow callback, IntPtr parameter);
  static string ClassLabel(IntPtr handle) {
    var text = new StringBuilder(128);
    GetClassName(handle, text, text.Capacity);
    switch (text.ToString()) {
      case "Edit": case "ComboBox": case "ComboBoxEx32": case "ToolbarWindow32":
      case "DirectUIHWND": case "SysTreeView32": case "Button": case "#32770":
      case "SysListView32": case "Static": return text.ToString();
      default: return "other";
    }
  }
  public static string FocusDiagnostic(IntPtr dialog) {
    uint pid;
    uint thread = GetWindowThreadProcessId(dialog, out pid);
    var info = new GuiInfo { Size = Marshal.SizeOf(typeof(GuiInfo)) };
    bool available = GetGUIThreadInfo(thread, ref info);
    var counts = new System.Collections.Generic.SortedDictionary<string, int>();
    int total = 0;
    EnumChildWindows(dialog, (child, unused) => {
      string label = ClassLabel(child);
      if (!counts.ContainsKey(label)) counts[label] = 0;
      counts[label]++;
      return ++total < 128;
    }, IntPtr.Zero);
    return "gui=" + available + " owned=" + (GetAncestor(info.Focus, 2) == dialog) + " focus=" + ClassLabel(info.Focus) + " children=" + String.Join(",", counts);
  }
}
'@
try {
  $stage = 'dialog-discovery'
  Write-Output "NATIVE_PICKER_DIAGNOSTIC stage=$stage"
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
  Write-Output "NATIVE_PICKER_DIAGNOSTIC stage=$stage"
  $handle = [IntPtr]$dialog.Current.NativeWindowHandle
  [void][PickerFocus]::SetForegroundWindow($handle)
  if ([PickerFocus]::GetForegroundWindow() -ne $handle) { throw 'Native dialog focus unavailable' }
  if ($Mode -eq 'cancel') {
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  } else {
    $stage = 'directory-navigation'
    Write-Output "NATIVE_PICKER_DIAGNOSTIC stage=$stage"
    # Navigate through the real shell dialog; never pass a workspace to the application.
    [System.Windows.Forms.SendKeys]::SendWait('%d')
    $stage = 'navigation-edit-focus'
    $edit = [IntPtr]::Zero
    do {
      if ([PickerFocus]::GetForegroundWindow() -ne $handle) { throw 'Native dialog lost focus' }
      $edit = [PickerFocus]::FocusedEdit($handle)
      if ($edit -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
    } until ($edit -ne [IntPtr]::Zero -or [DateTime]::UtcNow -gt $deadline)
    if ($edit -eq [IntPtr]::Zero) {
      Write-Output ('NATIVE_PICKER_DIAGNOSTIC ' + [PickerFocus]::FocusDiagnostic($handle))
      throw 'Native edit focus unavailable'
    }
    $escaped = [regex]::Replace($Workspace, '[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' })
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
    $stage = 'navigation-path-readback'
    do {
      if ([PickerFocus]::GetForegroundWindow() -ne $handle -or [PickerFocus]::FocusedEdit($handle) -ne $edit) { throw 'Native edit lost focus' }
      $matches = [PickerFocus]::ContainsPath($edit, $Workspace)
      if (-not $matches) { Start-Sleep -Milliseconds 100 }
    } until ($matches -or [DateTime]::UtcNow -gt $deadline)
    if (-not $matches) { throw 'Native path input not confirmed' }
    Write-Output 'NATIVE_PICKER_DIAGNOSTIC stage=navigation-path-confirmed'
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    $stage = 'keyboard-confirmation'
    Write-Output "NATIVE_PICKER_DIAGNOSTIC stage=$stage"
    # Hosted Windows exposes the dialog but an empty UIA descendant tree.
    # Use its native Select Folder accelerator; persisted session binding is the oracle.
    # Enter may already complete the folder selection and destroy the native dialog.
    # Never deliver another shortcut to the application window in that case.
    while ([PickerFocus]::IsWindow($handle) -and [PickerFocus]::GetForegroundWindow() -ne $handle -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 100
    }
    if ([PickerFocus]::IsWindow($handle)) {
      if ([PickerFocus]::GetForegroundWindow() -ne $handle) { throw 'Native dialog lost focus' }
      [System.Windows.Forms.SendKeys]::SendWait('%s')
    }
  }
  Write-Output "NATIVE_PICKER_DRIVEN $Mode"
} catch {
  Write-Output "NATIVE_PICKER_DIAGNOSTIC stage=$stage"
  exit 1
}
