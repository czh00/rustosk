Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class Win32Fg {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern IntPtr GetKeyboardLayout(uint idThread);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("imm32.dll")]
    public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

    [DllImport("imm32.dll")]
    public static extern IntPtr ImmGetContext(IntPtr hWnd);

    [DllImport("imm32.dll")]
    public static extern bool ImmGetOpenStatus(IntPtr hIMC);

    [DllImport("imm32.dll")]
    public static extern bool ImmGetConversionStatus(IntPtr hIMC, out uint lpfdwConversion, out uint lpfdwSentence);

    [DllImport("imm32.dll")]
    public static extern bool ImmReleaseContext(IntPtr hWnd, IntPtr hIMC);
}
'@

for ($i = 0; $i -lt 5; $i++) {
    $hwnd = [Win32Fg]::GetForegroundWindow()
    $titleBuf = New-Object System.Text.StringBuilder 256
    [Win32Fg]::GetWindowText($hwnd, $titleBuf, 256) | Out-Null
    $classBuf = New-Object System.Text.StringBuilder 256
    [Win32Fg]::GetClassName($hwnd, $classBuf, 256) | Out-Null

    $pidVal = 0
    $tid = [Win32Fg]::GetWindowThreadProcessId($hwnd, [ref]$pidVal)
    $hkl = [Win32Fg]::GetKeyboardLayout($tid)
    $hklVal = $hkl.ToInt64()
    $imeWnd = [Win32Fg]::ImmGetDefaultIMEWnd($hwnd)

    $resOpen = [UIntPtr]::Zero
    $okOpen = [Win32Fg]::SendMessageTimeout($imeWnd, 0x0283, [UIntPtr]0x0005, [IntPtr]::Zero, 2, 30, [ref]$resOpen)
    $resConv = [UIntPtr]::Zero
    $okConv = [Win32Fg]::SendMessageTimeout($imeWnd, 0x0283, [UIntPtr]0x0001, [IntPtr]::Zero, 2, 30, [ref]$resConv)

    $himc = [Win32Fg]::ImmGetContext($hwnd)
    $immOpen = $false
    $immConv = 0
    if ($himc -ne [IntPtr]::Zero) {
        $immOpen = [Win32Fg]::ImmGetOpenStatus($himc)
        $sent = 0
        [Win32Fg]::ImmGetConversionStatus($himc, [ref]$immConv, [ref]$sent) | Out-Null
        [Win32Fg]::ImmReleaseContext($hwnd, $himc) | Out-Null
    }

    Write-Host ("[{0}] HWND: 0x{1:X} Title: '{2}' Class: '{3}' PID: {4} TID: {5} HKL: 0x{6:X} okOpen: {7} resOpen: {8} okConv: {9} resConv: 0x{10:X} himcOpen: {11} himcConv: 0x{12:X}" -f `
        $i, $hwnd.ToInt64(), $titleBuf.ToString(), $classBuf.ToString(), $pidVal, $tid, $hklVal, $okOpen, $resOpen.ToUInt64(), $okConv, $resConv.ToUInt64(), $immOpen, $immConv)
    Start-Sleep -Seconds 1
}
