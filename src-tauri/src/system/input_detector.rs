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
    ImmGetDefaultIMEWnd, IME_CMODE_NATIVE,
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
    static ref DIAG_ID: AtomicUsize = AtomicUsize::new(0);
    pub static ref WAS_CHINESE_LAYOUT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
    static ref LAST_ZH_STATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static ref LAST_FOREGROUND_HWND: AtomicUsize = AtomicUsize::new(0);
    static ref WINDOW_IME_MAP: Mutex<std::collections::HashMap<usize, bool>> = Mutex::new(std::collections::HashMap::new());
    static ref LAST_IMM_STATE_MAP: Mutex<std::collections::HashMap<usize, (usize, usize)>> = Mutex::new(std::collections::HashMap::new());
    static ref EVENT_TRIGGER: (std::sync::mpsc::Sender<()>, Mutex<std::sync::mpsc::Receiver<()>>) = {
        let (tx, rx) = std::sync::mpsc::channel();
        (tx, Mutex::new(rx))
    };
}

pub fn clear_imm_confirmed() {
    if let Ok(mut map) = LAST_IMM_STATE_MAP.lock() {
        map.clear();
    }
}

pub fn get_effective_target_hwnd() -> usize {
    let fg_hwnd = unsafe { GetForegroundWindow() };
    let fg_val = fg_hwnd.0 as usize;
    let osk_hwnd = OSK_HWND.load(Ordering::Relaxed);
    if osk_hwnd != 0 && fg_val == osk_hwnd {
        LAST_FOREGROUND_HWND.load(Ordering::Relaxed)
    } else if fg_val != 0 {
        fg_val
    } else {
        LAST_FOREGROUND_HWND.load(Ordering::Relaxed)
    }
}

pub fn set_window_ime(hwnd: usize, is_zh: bool) {
    if hwnd == 0 {
        return;
    }
    if let Ok(mut map) = WINDOW_IME_MAP.lock() {
        map.insert(hwnd, is_zh);
        if map.len() > 64 {
            map.retain(|&h, _| unsafe {
                windows::Win32::UI::WindowsAndMessaging::IsWindow(HWND(h as _)).as_bool()
            });
        }
    }
}

pub fn get_or_default_window_ime(hwnd: usize, default_zh: bool) -> bool {
    if hwnd == 0 {
        return default_zh;
    }
    if let Ok(mut map) = WINDOW_IME_MAP.lock() {
        if let Some(&val) = map.get(&hwnd) {
            val
        } else {
            map.insert(hwnd, default_zh);
            default_zh
        }
    } else {
        default_zh
    }
}

pub fn toggle_window_ime(hwnd: usize) -> bool {
    let current = get_or_default_window_ime(hwnd, true);
    let new_val = !current;
    set_window_ime(hwnd, new_val);
    new_val
}

#[tauri::command]
pub fn toggle_pime_mode() -> bool {
    let target = get_effective_target_hwnd();
    let new_val = toggle_window_ime(target);
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
    let target = get_effective_target_hwnd();
    set_window_ime(target, is_zh);
    LAST_ZH_STATE.store(is_zh, Ordering::Relaxed);
}

#[tauri::command]
pub fn toggle_ime_key() {
    let target = get_effective_target_hwnd();
    toggle_window_ime(target);

    crate::system::keyboard_simulator::simulate_key_native(0xA0, false);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        crate::system::keyboard_simulator::simulate_key_native(0xA0, true);
        std::thread::sleep(Duration::from_millis(60));
        update_osk_state();
    });
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
    is_ime_active_details(false)
}

/// 偵測輸入法中英狀態：
/// 1. 檢查鍵盤佈局語系 (HKL)，若非中文直接回傳 false (英文)
/// 2. 優先嘗試 WM_IME_CONTROL (支援 Weasel 小狼毫等 IMM32 輸入法)
/// 3. 標準 IMM32 API 偵測 (支援微軟新注音及具備 IMC 轉換狀態之輸入法)
/// 4. 若皆無 IMM32 回應，則判定為純 TSF 輸入法 (如 PIME 新酷音)：
///    - 若為程式視窗切換 (is_app_switch)，新視窗在繁中佈局預設為中文模式
///    - 若為同視窗，依循使用者手動切換狀態 (PIME_ZH_MODE)，避免背景輪詢誤判覆蓋
pub fn is_ime_active_details(_is_app_switch: bool) -> bool {
    const IMC_GETCONVERSIONMODE: usize = 0x0001;
    const IMC_GETOPENSTATUS: usize = 0x0005;

    unsafe {
        let hwnd_fore = GetForegroundWindow();
        if hwnd_fore.0.is_null() {
            return LAST_ZH_STATE.load(Ordering::Relaxed);
        }

        // 取得有效目標視窗
        let target_val = get_effective_target_hwnd();
        if target_val == 0 {
            return LAST_ZH_STATE.load(Ordering::Relaxed);
        }
        let target_top_hwnd = HWND(target_val as _);

        // 若前景視窗為輸入法候選字視窗 (包含 PIME 的 LibImeWindow、Weasel 小狼毫、微軟新注音 Candidate)，必定處於中文選字狀態
        let fg_class = get_window_class(hwnd_fore);
        if fg_class.contains("IME") || fg_class.contains("Candidate") || fg_class == "LibImeWindow" || fg_class.contains("Weasel") {
            set_window_ime(target_val, true);
            LAST_ZH_STATE.store(true, Ordering::Relaxed);
            return true;
        }

        // 檢查是否有 PIME 候選字視窗 (LibImeWindow) 正處於可見狀態
        if let Ok(libime_hwnd) = windows::Win32::UI::WindowsAndMessaging::FindWindowW(
            windows::core::w!("LibImeWindow"),
            windows::core::PCWSTR::null(),
        ) {
            if !libime_hwnd.0.is_null() && windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(libime_hwnd).as_bool() {
                set_window_ime(target_val, true);
                LAST_ZH_STATE.store(true, Ordering::Relaxed);
                return true;
            }
        }

        let mut pid = 0;
        let thread_id = GetWindowThreadProcessId(target_top_hwnd, Some(&mut pid));

        let mut gui_info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };

        let target_hwnd = if GetGUIThreadInfo(thread_id, &mut gui_info).is_ok() && !gui_info.hwndFocus.0.is_null() {
            gui_info.hwndFocus
        } else {
            target_top_hwnd
        };

        let mut target_pid = 0;
        let target_tid = GetWindowThreadProcessId(target_hwnd, Some(&mut target_pid));
        let effective_tid = if target_tid != 0 { target_tid } else { thread_id };

        // 1. 檢查目標焦點執行緒的鍵盤佈局語系 (HKL)
        let hkl = GetKeyboardLayout(effective_tid);
        let lang_id = (hkl.0 as usize) & 0xFFFF;
        let primary_lang = lang_id & 0x03FF;
        let is_chinese_layout = primary_lang == 0x0004;

        // 若當前鍵盤佈局明確不是中文語系 (例如英文 0x0409)，直接判定為英文模式
        if (hkl.0 as usize) != 0 && !is_chinese_layout {
            WAS_CHINESE_LAYOUT.store(false, Ordering::Relaxed);
            set_window_ime(target_val, false);
            LAST_ZH_STATE.store(false, Ordering::Relaxed);
            return false;
        }

        WAS_CHINESE_LAYOUT.store(true, Ordering::Relaxed);

        let ime_wnd = ImmGetDefaultIMEWnd(target_hwnd);
        let effective_ime_wnd = if !ime_wnd.0.is_null() {
            ime_wnd
        } else {
            ImmGetDefaultIMEWnd(target_top_hwnd)
        };

        // 2. 針對標準 IMM32 輸入法 (微軟新注音、小狼毫 Weasel)
        // 使用 WM_IME_CONTROL 進行即時硬體/系統層狀態獲取
        if !effective_ime_wnd.0.is_null() {
            let mut res_open: usize = 0;
            let mut res_conv: usize = 0;

            let ok_open = SendMessageTimeoutW(
                effective_ime_wnd,
                WM_IME_CONTROL,
                WPARAM(IMC_GETOPENSTATUS),
                LPARAM(0),
                SMTO_ABORTIFHUNG | SMTO_NORMAL,
                30,
                Some(&mut res_open),
            );

            let ok_conv = SendMessageTimeoutW(
                effective_ime_wnd,
                WM_IME_CONTROL,
                WPARAM(IMC_GETCONVERSIONMODE),
                LPARAM(0),
                SMTO_ABORTIFHUNG | SMTO_NORMAL,
                30,
                Some(&mut res_conv),
            );

            if ok_open.0 != 0 {
                let is_open = res_open != 0;
                let is_native = ok_conv.0 != 0 && ((res_conv as u32 & IME_CMODE_NATIVE.0) != 0);

                let mut state_changed = false;
                if let Ok(mut imm_map) = LAST_IMM_STATE_MAP.lock() {
                    if let Some(&(last_open, last_conv)) = imm_map.get(&target_val) {
                        if last_open != res_open || (ok_conv.0 != 0 && last_conv != res_conv) {
                            state_changed = true;
                            imm_map.insert(target_val, (res_open, res_conv));
                        }
                    } else {
                        // 初次進入視窗記錄當前 IMM 數值，若為微軟新注音 (is_open 且 ok_conv 有效) 則進行初始同步
                        imm_map.insert(target_val, (res_open, res_conv));
                        if is_open && ok_conv.0 != 0 {
                            set_window_ime(target_val, is_native);
                            LAST_ZH_STATE.store(is_native, Ordering::Relaxed);
                            return is_native;
                        }
                    }
                }

                if state_changed {
                    // 微軟新注音：is_open 為 true 且 ok_conv 有效，以 is_native 判斷中英文
                    if is_open && ok_conv.0 != 0 {
                        set_window_ime(target_val, is_native);
                        LAST_ZH_STATE.store(is_native, Ordering::Relaxed);
                        return is_native;
                    }
                    // 小狼毫 Weasel：以 is_open (res_open != 0) 判斷中英文
                    if ok_open.0 != 0 {
                        set_window_ime(target_val, is_open);
                        LAST_ZH_STATE.store(is_open, Ordering::Relaxed);
                        return is_open;
                    }
                }
            }
        }

        // 3. 純 TSF 輸入法 (如 PIME 新酷音) 及穩態維持：
        // 避免因小狼毫或舊視窗殘留之 IMM32 靜態數值覆蓋 PIME 的 Shift 切換；
        // 讀取該目標視窗各自獨立記憶的輸入法狀態；初次開啟之視窗預設為中文模式。
        // 當使用者按實體 Shift 鍵或 ㄅ/En 按鈕切換時，該視窗狀態被即時翻轉並持續保存。
        let is_zh = get_or_default_window_ime(target_val, true);
        LAST_ZH_STATE.store(is_zh, Ordering::Relaxed);
        is_zh
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
        let _ = EVENT_TRIGGER.0.send(());
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

    // 偵測輸入法系統視窗與工作切換器，避免在過渡期誤記暫態視窗
    let fg_class = get_window_class(fg_hwnd);
    let proc_name = get_process_name(fg_hwnd).to_lowercase();
    let is_search_or_start = crate::system::window_manager::is_search_or_start_window(fg_hwnd);
    let is_task_switcher = fg_class == "TaskSwitcherWnd"
        || fg_class == "XamlExplorerHostIslandWindow"
        || fg_class == "MultitaskingViewFrame"
        || (proc_name == "explorer.exe" && fg_class == "Windows.UI.Core.CoreWindow");

    let is_ime_candidate = (fg_class.contains("IME")
        || fg_class.contains("Candidate")
        || fg_class == "LibImeWindow"
        || fg_class.contains("Weasel")
        || (fg_class == "Windows.UI.Core.CoreWindow" && proc_name == "textinputhost.exe"))
        && !is_search_or_start;

    // 記錄當前真正的應用程式視窗代碼 (排除 OSK、候選字窗、工作切換器與開始選單)
    if !is_osk_focused && !fg_hwnd.0.is_null() && !is_ime_candidate && !is_task_switcher && !is_search_or_start {
        let fg_val = fg_hwnd.0 as usize;
        LAST_FOREGROUND_HWND.store(fg_val, Ordering::Relaxed);
    }

    // 在進入互斥鎖前計算所有狀態，避免在持鎖期間產生任何鎖競態或二次呼叫死結
    let (_is_caps, _is_num) = crate::system::keyboard_simulator::get_locks();
    let is_zh = is_ime_active_details(false);
    let clipboard = get_clipboard_text();

    if let Ok(guard) = GLOBAL_WINDOW.lock() {
        if let Some(window) = guard.as_ref() {
            let _diag_id = DIAG_ID.fetch_add(1, Ordering::Relaxed);

            // 構造 UI 狀態更新酬載
            let payload = serde_json::json!({
                "app": app_name,
                "is_zh": is_zh,
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

    // 專用焦點防抖工作執行緒：保證每次焦點改變 100% 被捕獲並更新，絕不遺漏
    std::thread::spawn(|| {
        let rx = EVENT_TRIGGER.1.lock().unwrap();
        while let Ok(()) = rx.recv() {
            std::thread::sleep(Duration::from_millis(35));
            while rx.try_recv().is_ok() {}
            update_osk_state();
        }
    });

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
