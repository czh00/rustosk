Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class ImeChecker {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint idThread);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("imm32.dll")] public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
    [DllImport("imm32.dll")] public static extern IntPtr ImmGetContext(IntPtr hWnd);
    [DllImport("imm32.dll")] public static extern bool ImmGetOpenStatus(IntPtr hIMC);
    [DllImport("imm32.dll")] public static extern bool ImmGetConversionStatus(IntPtr hIMC, out uint lpfdwConversion, out uint lpfdwSentence);
    [DllImport("imm32.dll")] public static extern bool ImmReleaseContext(IntPtr hWnd, IntPtr hIMC);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);

    public static void CheckWindow(IntPtr hWnd) {
        StringBuilder title = new StringBuilder(256);
        GetWindowText(hWnd, title, 256);
        StringBuilder cls = new StringBuilder(256);
        GetClassName(hWnd, cls, 256);

        uint pid = 0;
        uint tid = GetWindowThreadProcessId(hWnd, out pid);
        IntPtr hkl = GetKeyboardLayout(tid);
        long hklVal = hkl.ToInt64();
        long langId = hklVal & 0xFFFF;
        long primaryLang = langId & 0x03FF;
        bool isChineseLayout = (primaryLang == 0x0004);

        IntPtr imeWnd = ImmGetDefaultIMEWnd(hWnd);

        UIntPtr resOpen = UIntPtr.Zero;
        IntPtr okOpen = SendMessageTimeout(imeWnd, 0x0283, (UIntPtr)5, IntPtr.Zero, 2, 30, out resOpen);

        UIntPtr resConv = UIntPtr.Zero;
        IntPtr okConv = SendMessageTimeout(imeWnd, 0x0283, (UIntPtr)1, IntPtr.Zero, 2, 30, out resConv);

        IntPtr himc = ImmGetContext(hWnd);
        bool himcOpen = false;
        uint himcConv = 0;
        uint himcSent = 0;
        bool okHimcConv = false;
        if (himc != IntPtr.Zero) {
            himcOpen = ImmGetOpenStatus(himc);
            okHimcConv = ImmGetConversionStatus(himc, out himcConv, out himcSent);
            ImmReleaseContext(hWnd, himc);
        }

        Console.WriteLine(string.Format("HWND: 0x{0:X} PID: {1} TID: {2} Cls: {3} Title: '{4}' | HKL: 0x{5:X} isZhLayout: {6} | imeWnd: 0x{7:X} okOpen: {8} resOpen: {9} okConv: {10} resConv: 0x{11:X} | himc: 0x{12:X} himcOpen: {13} okHimcConv: {14} conv: 0x{15:X}",
            hWnd.ToInt64(), pid, tid, cls.ToString(), title.ToString(), hklVal, isChineseLayout, imeWnd.ToInt64(), okOpen != IntPtr.Zero, resOpen.ToUInt64(), okConv != IntPtr.Zero, resConv.ToUInt64(), himc.ToInt64(), himcOpen, okHimcConv, himcConv));
    }
}
'@

$proc = [ImeChecker+EnumWindowsProc]{
    param($hwnd, $lparam)
    if ([ImeChecker]::IsWindowVisible($hwnd)) {
        $title = New-Object System.Text.StringBuilder 256
        [ImeChecker]::GetWindowText($hwnd, $title, 256) | Out-Null
        $t = $title.ToString()
        if ($t.Length -gt 0 -and $t -notmatch "^(Setup|Default IME|Program Manager|MSCTFIME UI)") {
            [ImeChecker]::CheckWindow($hwnd)
        }
    }
    return $true
}

[ImeChecker]::EnumWindows($proc, [IntPtr]::Zero) | Out-Null
