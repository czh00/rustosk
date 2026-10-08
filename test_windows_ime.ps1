Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class Win32Test {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern IntPtr GetKeyboardLayout(uint idThread);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

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

$procs = Get-Process
foreach ($p in $procs) {
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
        $hwnd = $p.MainWindowHandle
        $title = $p.MainWindowTitle
        $pname = $p.ProcessName
        $pidVal = $p.Id
        $targetPid = 0
        $tid = [Win32Test]::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
        $hkl = [Win32Test]::GetKeyboardLayout($tid)
        $hklVal = $hkl.ToInt64()
        $imeWnd = [Win32Test]::ImmGetDefaultIMEWnd($hwnd)

        $resOpen = [UIntPtr]::Zero
        $okOpen = [Win32Test]::SendMessageTimeout($imeWnd, 0x0283, [UIntPtr]0x0005, [IntPtr]::Zero, 2, 30, [ref]$resOpen)
        $resConv = [UIntPtr]::Zero
        $okConv = [Win32Test]::SendMessageTimeout($imeWnd, 0x0283, [UIntPtr]0x0001, [IntPtr]::Zero, 2, 30, [ref]$resConv)

        $himc = [Win32Test]::ImmGetContext($hwnd)
        $immOpen = $false
        $immConv = 0
        if ($himc -ne [IntPtr]::Zero) {
            $immOpen = [Win32Test]::ImmGetOpenStatus($himc)
            $sent = 0
            [Win32Test]::ImmGetConversionStatus($himc, [ref]$immConv, [ref]$sent) | Out-Null
            [Win32Test]::ImmReleaseContext($hwnd, $himc) | Out-Null
        }

        Write-Host ("Process: {0,-15} ({1,-25}) HWND: 0x{2:X} HKL: 0x{3:X} Open: {4}(res={5}) Conv: {6}(res=0x{7:X}) himcOpen: {8} himcConv: 0x{9:X}" -f `
            $pname, $title, $hwnd.ToInt64(), $hklVal, $okOpen, $resOpen.ToUInt64(), $okConv, $resConv.ToUInt64(), $immOpen, $immConv)
    }
}
