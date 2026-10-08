use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetGUIThreadInfo, GetWindowTextW, GetWindowThreadProcessId,
    SendMessageTimeoutW, GUITHREADINFO, SMTO_ABORTIFHUNG, SMTO_NORMAL, WM_IME_CONTROL,
};
use windows::Win32::UI::Input::Ime::{
    ImmGetContext, ImmGetConversionStatus, ImmGetDefaultIMEWnd, ImmGetOpenStatus,
    ImmReleaseContext, IME_CONVERSION_MODE, IME_SENTENCE_MODE,
};

unsafe extern "system" fn enum_proc(hwnd: HWND, _lparam: LPARAM) -> BOOL {
    let mut pid = 0;
    let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid != 31588 && pid != 6164 && pid != 36212 {
        return BOOL(1);
    }

    let mut title_buf = [0u16; 256];
    let len = GetWindowTextW(hwnd, &mut title_buf);
    let title = String::from_utf16_lossy(&title_buf[..len as usize]);

    let mut gui_info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let _ = GetGUIThreadInfo(tid, &mut gui_info);
    let h_focus = gui_info.hwndFocus;

    println!("Found Notepad PID: {}, hwnd: {:p}, title: '{}', hwndFocus: {:p}", pid, hwnd.0, title, h_focus.0);

    for (name, h) in &[("top", hwnd), ("focus", h_focus)] {
        if h.0.is_null() { continue; }
        let mut class_buf = [0u16; 256];
        let clen = GetClassNameW(*h, &mut class_buf);
        let class_name = String::from_utf16_lossy(&class_buf[..clen as usize]);

        let ime_wnd = ImmGetDefaultIMEWnd(*h);

        let mut res_open: usize = 0;
        let mut res_conv: usize = 0;

        let ok_open = SendMessageTimeoutW(
            ime_wnd,
            WM_IME_CONTROL,
            WPARAM(0x0005),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_NORMAL,
            30,
            Some(&mut res_open),
        );

        let ok_conv = SendMessageTimeoutW(
            ime_wnd,
            WM_IME_CONTROL,
            WPARAM(0x0001),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_NORMAL,
            30,
            Some(&mut res_conv),
        );

        let himc = ImmGetContext(*h);
        let mut himc_open = false;
        let mut himc_conv = 0;
        let mut ok_himc = false;
        if !himc.0.is_null() {
            himc_open = ImmGetOpenStatus(himc).as_bool();
            let mut conv = IME_CONVERSION_MODE(0);
            let mut sent = IME_SENTENCE_MODE(0);
            ok_himc = ImmGetConversionStatus(himc, Some(&mut conv), Some(&mut sent)).as_bool();
            himc_conv = conv.0;
            let _ = ImmReleaseContext(*h, himc);
        }

        println!("  [{}] HWND: {:p} | Cls: {} | ime_wnd: {:p} | ok_open: {}, res_open: {} | ok_conv: {}, res_conv: 0x{:X}",
            name, h.0, class_name, ime_wnd.0, ok_open.0, res_open, ok_conv.0, res_conv);
        println!("  [{}] himc: {:p} | himc_open: {} | ok_himc: {}, conv: 0x{:X}",
            name, himc.0, himc_open, ok_himc, himc_conv);
    }

    BOOL(1)
}

fn main() {
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(0));
    }
}
