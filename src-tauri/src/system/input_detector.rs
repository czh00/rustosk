use lazy_static::lazy_static;
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewWindow};

use crate::system::window_manager::{
    hide_osk, show_osk_no_activate, IS_MANUALLY_HIDDEN, IS_PINNED,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, SetWinEventHook, UIA_ComboBoxControlTypeId,
    UIA_EditControlTypeId, HWINEVENTHOOK,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
use windows::Win32::UI::Input::Ime::{
    ImmGetContext, ImmGetConversionStatus, ImmGetDefaultIMEWnd, ImmGetOpenStatus,
    ImmReleaseContext, IME_CMODE_NATIVE, IME_CONVERSION_MODE, IME_SENTENCE_MODE,
};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetWindowTextW, GetWindowThreadProcessId,
    SendMessageTimeoutW, EVENT_OBJECT_FOCUS, EVENT_SYSTEM_FOREGROUND, GUITHREADINFO, GUI_CARETBLINKING,
    SMTO_ABORTIFHUNG, SMTO_NORMAL, WINEVENT_OUTOFCONTEXT, WM_IME_CONTROL,
};
lazy_static! {
    static ref GLOBAL_WINDOW: Mutex<Option<WebviewWindow>> = Mutex::new(None);
    pub static ref OSK_HWND: AtomicUsize = AtomicUsize::new(0);
    static ref UPDATE_COUNTER: AtomicUsize = AtomicUsize::new(0);
    static ref DIAG_ID: AtomicUsize = AtomicUsize::new(0);
    pub static ref PIME_ZH_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
    pub static ref WAS_CHINESE_LAYOUT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
    static ref LAST_ZH_STATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static ref LAST_THREAD_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    static ref LAST_FOREGROUND_HWND: AtomicUsize = AtomicUsize::new(0);
}

#[tauri::command]
pub fn toggle_pime_mode() -> bool {
    let new_val = PIME_ZH_MODE.fetch_xor(true, Ordering::SeqCst) ^ true;
    LAST_ZH_STATE.store(new_val, Ordering::Relaxed);
    if let Ok(guard) = GLOBAL_WINDOW.lock() {
        if let Some(window) = guard.as_ref() {
            let _ = window.emit("manual_ime_toggled", new_val);
        }
    }
    new_val
}

#[tauri::command]
pub fn set_pime_mode(is_zh: bool) {
    PIME_ZH_MODE.store(is_zh, Ordering::SeqCst);
    LAST_ZH_STATE.store(is_zh, Ordering::Relaxed);
}

// Get the class of a window
pub fn get_window_class(hwnd: windows::Win32::Foundation::HWND) -> String {
    unsafe {
        if hwnd.0.is_null() {
            return "".to_string();
        }
        let mut buffer = [0u16; 512];
        let len = GetClassNameW(hwnd, &mut buffer);
        if len > 0 {
            String::from_utf16_lossy(&buffer[..len as usize])
        } else {
            "".to_string()
        }
    }
}

// Get the title of the foreground window
pub fn get_foreground_name() -> String {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return "Unknown".to_string();
        }

        let mut buffer = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buffer);
        let title = if len > 0 {
            String::from_utf16_lossy(&buffer[..len as usize])
        } else {
            "System".to_string()
        };

        let process_name = get_process_name(hwnd);
        format!("{} ({})", process_name, title)
    }
}

pub fn get_process_name(hwnd: HWND) -> String {
    unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return "System".to_string();
        }

        let h_proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if let Ok(h_proc) = h_proc {
            let mut buffer = [0u16; 512];
            let mut size = buffer.len() as u32;
            if QueryFullProcessImageNameW(
                h_proc,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut size,
            )
            .is_ok()
            {
                let path = String::from_utf16_lossy(&buffer[..size as usize]);
                let _ = windows::Win32::Foundation::CloseHandle(h_proc);
                return std::path::Path::new(&path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or("Unknown".to_string());
            }
            let _ = windows::Win32::Foundation::CloseHandle(h_proc);
        }
    }
    "Unknown".to_string()
}

// Check if the current focused thread has a blinking caret (i.e. is an input field)
pub fn check_caret() -> bool {
    unsafe {
        let h_fore = GetForegroundWindow();
        if h_fore.0.is_null() {
            return false;
        }

        let class_name = get_window_class(h_fore);
        if class_name == "ConsoleWindowClass" || class_name == "CASCADIA_HOSTING_WINDOW_CLASS" {
            return true;
        }

        let mut current_pid = 0;
        let t_id = GetWindowThreadProcessId(h_fore, Some(&mut current_pid));

        let mut gui_info = windows::Win32::UI::WindowsAndMessaging::GUITHREADINFO {
            cbSize: std::mem::size_of::<windows::Win32::UI::WindowsAndMessaging::GUITHREADINFO>()
                as u32,
            ..Default::default()
        };

        if GetGUIThreadInfo(t_id, &mut gui_info).is_ok() {
            // 模式 1: 原生閃爍游標偵測 (如 Notepad)
            if (gui_info.flags.0 & GUI_CARETBLINKING.0) != 0 {
                return true;
            }

            // 模式 2: 自定義繪製但宣告 hwndCaret 的程式 (如 Chrome, VSCode)
            if !gui_info.hwndCaret.0.is_null() {
                let class_name = get_window_class(h_fore);
                let is_search_or_start = crate::system::window_manager::is_search_or_start_window(h_fore);
                if class_name != "Progman"
                    && class_name != "WorkerW"
                    && class_name != "Shell_TrayWnd"
                    && (class_name != "Windows.UI.Core.CoreWindow" || is_search_or_start)
                {
                    return true;
                }
            }
        }
    }
    false
}

#[allow(dead_code)]
pub fn is_ime_active() -> bool {
    is_ime_active_details().0
}

/// 偵測輸入法中英狀態，回傳 (is_zh, is_reliable)
/// is_reliable: 是否有明確的系統訊號 (例如候選字窗、Weasel WM_IME_CONTROL、微軟新注音 IMC 開啟狀態)
/// 若為 false (如 PIME 新酷音純 TSF 無法被外部偵測)，則遵循使用者在 OSK 上的「ㄅ/En」手動切換狀態
pub fn is_ime_active_details() -> (bool, bool) {
    const IMC_GETCONVERSIONMODE: usize = 0x0001;
    const IMC_GETOPENSTATUS: usize = 0x0005;

    unsafe {
        let hwnd_fore = GetForegroundWindow();
        if hwnd_fore.0.is_null() {
            return (LAST_ZH_STATE.load(Ordering::Relaxed), false);
        }

        // 判斷前景視窗是否為 OSK 本身，若為 OSK 則維持最後偵測到的狀態，不視為可靠的目標程式偵測
        let osk_hwnd = OSK_HWND.load(Ordering::Relaxed);
        if osk_hwnd != 0 && (hwnd_fore.0 as usize) == osk_hwnd {
            return (LAST_ZH_STATE.load(Ordering::Relaxed), false);
        }

        // 若前景視窗為輸入法候選字視窗 (包含 PIME 的 LibImeWindow、Weasel 小狼毫、微軟新注音 Candidate)，必定處於中文選字狀態
        let fg_class = get_window_class(hwnd_fore);
        if fg_class.contains("IME") || fg_class.contains("Candidate") || fg_class == "LibImeWindow" || fg_class.contains("Weasel") {
            PIME_ZH_MODE.store(true, Ordering::Relaxed);
            LAST_ZH_STATE.store(true, Ordering::Relaxed);
            return (true, true);
        }

        // 檢查是否有 PIME 候選字視窗 (LibImeWindow) 正處於可見狀態
        if let Ok(libime_hwnd) = windows::Win32::UI::WindowsAndMessaging::FindWindowW(
            windows::core::w!("LibImeWindow"),
            windows::core::PCWSTR::null(),
        ) {
            if !libime_hwnd.0.is_null() && windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(libime_hwnd).as_bool() {
                PIME_ZH_MODE.store(true, Ordering::Relaxed);
                LAST_ZH_STATE.store(true, Ordering::Relaxed);
                return (true, true);
            }
        }

        let mut pid = 0;
        let thread_id = GetWindowThreadProcessId(hwnd_fore, Some(&mut pid));

        let mut gui_info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };

        let target_hwnd = if GetGUIThreadInfo(thread_id, &mut gui_info).is_ok() && !gui_info.hwndFocus.0.is_null() {
            gui_info.hwndFocus
        } else {
            hwnd_fore
        };

        let mut target_pid = 0;
        let target_tid = GetWindowThreadProcessId(target_hwnd, Some(&mut target_pid));
        let effective_tid = if target_tid != 0 { target_tid } else { thread_id };

        // 1. 檢查目標焦點執行緒的鍵盤佈局語系 (HKL)
        let hkl = GetKeyboardLayout(effective_tid);
        let lang_id = (hkl.0 as usize) & 0xFFFF;
        let primary_lang = lang_id & 0x03FF;
        let is_chinese_layout = primary_lang == 0x0004;

        // 若當前鍵盤佈局明確不是中文語系 (例如英文 0x0409)，直接判定為英文模式 (明確可靠)
        if (hkl.0 as usize) != 0 && !is_chinese_layout {
            WAS_CHINESE_LAYOUT.store(false, Ordering::Relaxed);
            LAST_ZH_STATE.store(false, Ordering::Relaxed);
            return (false, true);
        }

        WAS_CHINESE_LAYOUT.store(true, Ordering::Relaxed);

        let ime_wnd = ImmGetDefaultIMEWnd(target_hwnd);

        // 2. 優先嘗試使用 WM_IME_CONTROL 獲取狀態 (支援 Weasel 小狼毫等 IMM32 輸入法)
        // 跨行程呼叫使用 100ms 超時防卡死
        if !ime_wnd.0.is_null() {
            let mut res_open: usize = 0;
            let mut res_conv: usize = 0;

            let ok_open = SendMessageTimeoutW(
                ime_wnd,
                WM_IME_CONTROL,
                WPARAM(IMC_GETOPENSTATUS),
                LPARAM(0),
                SMTO_ABORTIFHUNG | SMTO_NORMAL,
                100,
                Some(&mut res_open),
            );

            let ok_conv = SendMessageTimeoutW(
                ime_wnd,
                WM_IME_CONTROL,
                WPARAM(IMC_GETCONVERSIONMODE),
                LPARAM(0),
                SMTO_ABORTIFHUNG | SMTO_NORMAL,
                100,
                Some(&mut res_conv),
            );

            // 若 WM_IME_CONTROL 明確回應為中文模式 (res_open != 0 && is_native)，代表為活躍之中文輸入法狀態
            if ok_open.0 != 0 && res_open != 0 && ok_conv.0 != 0 {
                let is_native = (res_conv as u32 & IME_CMODE_NATIVE.0) != 0;
                if is_native {
                    PIME_ZH_MODE.store(true, Ordering::Relaxed);
                    LAST_ZH_STATE.store(true, Ordering::Relaxed);
                    return (true, true);
                }
            }
        }

        // 3. 標準 IMM32 API 偵測 (支援微軟新注音及具備 IMC 轉換狀態之輸入法)
        let check_hwnd = if !target_hwnd.0.is_null() { target_hwnd } else { ime_wnd };
        if !check_hwnd.0.is_null() {
            let himc = ImmGetContext(check_hwnd);
            if !himc.0.is_null() {
                let is_open = ImmGetOpenStatus(himc).as_bool();
                let mut conv = IME_CONVERSION_MODE(0);
                let mut sentence = IME_SENTENCE_MODE(0);
                let ok_conv = ImmGetConversionStatus(himc, Some(&mut conv), Some(&mut sentence)).as_bool();
                let _ = ImmReleaseContext(check_hwnd, himc);

                if ok_conv && (conv.0 & IME_CMODE_NATIVE.0) != 0 && is_open {
                    PIME_ZH_MODE.store(true, Ordering::Relaxed);
                    LAST_ZH_STATE.store(true, Ordering::Relaxed);
                    return (true, true);
                }
            }
        }

        // 4. 若既非 Weasel 也非微軟新注音中文模式，且為中文語系 (如 PIME 新酷音等純 TSF 輸入法)
        // 此時無法透過 Win32 API 穩定偵測中英狀態，標記為 is_reliable = false！
        // 遵循使用者在 OSK 點擊「ㄅ/En」或實體 Shift 的手動模式，不進行強制覆蓋
        let is_zh = PIME_ZH_MODE.load(Ordering::Relaxed);
        LAST_ZH_STATE.store(is_zh, Ordering::Relaxed);
        (is_zh, false)
    }
}

pub fn check_uia() -> bool {
    let mut result = false;
    unsafe {
        let co_init = CoInitializeEx(None, COINIT_MULTITHREADED);

        if let Ok(automation) = windows::Win32::System::Com::CoCreateInstance::<_, IUIAutomation>(
            &CUIAutomation,
            None,
            windows::Win32::System::Com::CLSCTX_INPROC_SERVER,
        ) {
            if let Ok(element) = automation.GetFocusedElement() {
                if let Ok(ctrl_type) = element.CurrentControlType() {
                    let is_focus = element.CurrentHasKeyboardFocus().unwrap_or(BOOL(0)).0 != 0;
                    if is_focus
                        && (ctrl_type == UIA_EditControlTypeId
                            || ctrl_type == UIA_ComboBoxControlTypeId)
                    {
                        result = true;
                    }
                }
            }
        }

        if co_init.is_ok() {
            CoUninitialize();
        }
    }
    result
}



unsafe extern "system" fn win_event_callback(
    _h_win_event_hook: HWINEVENTHOOK,
    event_type: u32,
    _hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _dw_event_thread: u32,
    _dwms_event_time: u32,
) {
    if event_type == EVENT_SYSTEM_FOREGROUND || event_type == EVENT_OBJECT_FOCUS {
        let count = UPDATE_COUNTER.fetch_add(1, Ordering::SeqCst);
        let delay_ms = if event_type == EVENT_SYSTEM_FOREGROUND { 30 } else { 80 };
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
            // 只執行最後一次觸發
            if UPDATE_COUNTER.load(Ordering::SeqCst) == count + 1 {
                update_osk_state();
            }
        });
    }
}

pub fn get_clipboard_text() -> String {
    unsafe {
        if OpenClipboard(HWND::default()).is_ok() {
            // 1. 優先偵測檔案 (CF_HDROP = 15)
            let h_drop = GetClipboardData(15);
            if let Ok(handle) = h_drop {
                let hdrop = HDROP(handle.0 as _);
                let count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);
                if count > 0 {
                    let mut buffer = [0u16; 512];
                    let len = DragQueryFileW(hdrop, 0, Some(&mut buffer));
                    if len > 0 {
                        let path = String::from_utf16_lossy(&buffer[..len as usize]);
                        let filename = std::path::Path::new(&path)
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or(path);

                        let _ = CloseClipboard();
                        if count > 1 {
                            return format!("{} (+{})", filename, count - 1);
                        } else {
                            return filename;
                        }
                    }
                }
            }

            // 2. 次之偵測純文字 (CF_UNICODETEXT = 13)
            let handle = GetClipboardData(13);
            if let Ok(handle) = handle {
                let ptr = GlobalLock(windows::Win32::Foundation::HGLOBAL(handle.0 as _));
                if !ptr.is_null() {
                    let mut len = 0;
                    let p_u16 = ptr as *const u16;
                    while *p_u16.add(len) != 0 && len < 1024 {
                        len += 1;
                    }
                    let text = String::from_utf16_lossy(std::slice::from_raw_parts(p_u16, len));
                    let _ = GlobalUnlock(windows::Win32::Foundation::HGLOBAL(handle.0 as _));
                    let _ = CloseClipboard();
                    return text;
                }
            }
            let _ = CloseClipboard();
        }
    }
    "".to_string()
}

pub fn update_osk_state() {
    let mut has_caret = check_caret();
    if !has_caret {
        has_caret = check_uia();
    }
    let app_name = get_foreground_name();
    let is_pinned = IS_PINNED.load(Ordering::Relaxed);
    let is_manually_hidden = IS_MANUALLY_HIDDEN.load(Ordering::Relaxed);

    // 判斷前景視窗是否為 OSK 本身，避免在使用鍵盤時被隱藏 (免鎖原子讀取)
    let fg_hwnd = unsafe { GetForegroundWindow() };
    let osk_hwnd = OSK_HWND.load(Ordering::Relaxed);
    let is_osk_focused = osk_hwnd != 0 && (fg_hwnd.0 as usize) == osk_hwnd;

    // 偵測輸入法系統視窗，避免在選字時頻繁觸發置頂邏輯導致閃爍
    let fg_class = get_window_class(fg_hwnd);
    let proc_name = get_process_name(fg_hwnd).to_lowercase();
    let is_search_or_start = crate::system::window_manager::is_search_or_start_window(fg_hwnd);
    let is_ime_candidate = (fg_class.contains("IME")
        || fg_class.contains("Candidate")
        || fg_class == "LibImeWindow"
        || fg_class.contains("Weasel")
        || (fg_class == "Windows.UI.Core.CoreWindow" && proc_name == "textinputhost.exe"))
        && !is_search_or_start;

    // 偵測前景視窗切換 (程式變換焦點)
    let mut is_app_switch = false;
    if !is_osk_focused && !fg_hwnd.0.is_null() && !is_ime_candidate {
        let fg_val = fg_hwnd.0 as usize;
        let prev_hwnd = LAST_FOREGROUND_HWND.swap(fg_val, Ordering::Relaxed);
        if prev_hwnd != 0 && prev_hwnd != fg_val {
            is_app_switch = true;
            // 當切換到新視窗時，若為中文鍵盤佈局，自動將 PIME 預設狀態重設為中文 (PIME 啟動在新視窗預設為中文)
            if WAS_CHINESE_LAYOUT.load(Ordering::Relaxed) {
                PIME_ZH_MODE.store(true, Ordering::Relaxed);
            }
        }
    }

    // 在進入互斥鎖前計算所有狀態，避免在持鎖期間產生任何鎖競態或二次呼叫死結
    let (_is_caps, _is_num) = crate::system::keyboard_simulator::get_locks();
    let (is_zh, is_reliable) = is_ime_active_details();
    let clipboard = get_clipboard_text();

    if let Ok(guard) = GLOBAL_WINDOW.lock() {
        if let Some(window) = guard.as_ref() {
            let _diag_id = DIAG_ID.fetch_add(1, Ordering::Relaxed);

            // 構造 UI 狀態更新酬載
            let payload = serde_json::json!({
                "app": app_name,
                "is_zh": is_zh,
                "is_reliable": is_reliable,
                "is_app_switch": is_app_switch,
                "diag": "", // 移除診斷資訊以保持發布版本精簡
                "clipboard": clipboard
            })
            .to_string();

            let _ = window.emit("focus_changed", payload);

            let _ = window.app_handle().run_on_main_thread(move || {
                if is_manually_hidden {
                    hide_osk();
                } else if is_ime_candidate {
                    // 若正在顯示輸入法候選字，維持現狀但不強制執行置頂週期
                    // 但若先前正在避讓開始選單，而現在開始選單已關閉，必須恢復原位！
                    if !is_search_or_start && crate::system::window_manager::IS_AVOIDING.load(Ordering::Relaxed) {
                        crate::system::window_manager::restore_avoidance_position();
                    }
                } else if has_caret || is_pinned || is_osk_focused {
                    show_osk_no_activate();
                } else {
                    hide_osk();
                }
            });
        }
    }
}

pub fn start_detector(window: WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        OSK_HWND.store(hwnd.0 as usize, Ordering::Relaxed);
    }
    if let Ok(mut guard) = GLOBAL_WINDOW.lock() {
        *guard = Some(window.clone());
    }

    update_osk_state();

    // 定時輪詢備援機制 (避讓中提升頻率至 200ms 以便開始選單關閉時即時恢復)
    std::thread::spawn(|| loop {
        let is_avoiding = crate::system::window_manager::IS_AVOIDING.load(Ordering::Relaxed);
        let sleep_ms = if is_avoiding { 200 } else { 600 };
        std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
        update_osk_state();
    });

    std::thread::spawn(|| unsafe {
        let _hook1 = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(win_event_callback),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );

        let _hook2 = SetWinEventHook(
            EVENT_OBJECT_FOCUS,
            EVENT_OBJECT_FOCUS,
            None,
            Some(win_event_callback),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );

        let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
        while windows::Win32::UI::WindowsAndMessaging::GetMessageW(&mut msg, None, 0, 0).into() {
            let _ = windows::Win32::UI::WindowsAndMessaging::TranslateMessage(&msg);
            windows::Win32::UI::WindowsAndMessaging::DispatchMessageW(&msg);
        }
    });
}
