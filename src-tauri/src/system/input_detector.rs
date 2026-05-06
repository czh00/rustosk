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
use windows::Win32::UI::Input::Ime::{
    ImmGetContext, ImmGetConversionStatus, ImmGetDefaultIMEWnd, ImmGetOpenStatus,
    ImmReleaseContext, IME_CMODE_NATIVE, IME_CONVERSION_MODE, IME_SENTENCE_MODE,
};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetWindowTextW, GetWindowThreadProcessId,
    SendMessageW, EVENT_OBJECT_FOCUS, EVENT_SYSTEM_FOREGROUND, GUITHREADINFO, GUI_CARETBLINKING,
    WINEVENT_OUTOFCONTEXT, WM_IME_CONTROL,
};
lazy_static! {
    static ref GLOBAL_WINDOW: Mutex<Option<WebviewWindow>> = Mutex::new(None);
    static ref UPDATE_COUNTER: AtomicUsize = AtomicUsize::new(0);
    static ref DIAG_ID: AtomicUsize = AtomicUsize::new(0);
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
                if class_name != "Progman"
                    && class_name != "WorkerW"
                    && class_name != "Shell_TrayWnd"
                    && class_name != "Windows.UI.Core.CoreWindow"
                {
                    return true;
                }
            }
        }
    }
    false
}

pub fn is_ime_active() -> bool {
    const IMC_GETCONVERSIONMODE: usize = 0x0001;
    const IMC_GETOPENSTATUS: usize = 0x0005;

    unsafe {
        let hwnd_fore = GetForegroundWindow();
        if hwnd_fore.0.is_null() {
            return false;
        }

        let mut pid = 0;
        let thread_id = GetWindowThreadProcessId(hwnd_fore, Some(&mut pid));

        let mut gui_info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };

        let target_hwnd = if GetGUIThreadInfo(thread_id, &mut gui_info).is_ok() {
            if !gui_info.hwndFocus.0.is_null() {
                gui_info.hwndFocus
            } else {
                hwnd_fore
            }
        } else {
            hwnd_fore
        };

        let ime_wnd = ImmGetDefaultIMEWnd(target_hwnd);
        let mut is_chinese = false;

        // 優先嘗試使用 WM_IME_CONTROL 獲取狀態 (支援 Weasel 小狼毫等 TSF)
        if !ime_wnd.0.is_null() {
            let res_open = SendMessageW(
                ime_wnd,
                WM_IME_CONTROL,
                WPARAM(IMC_GETOPENSTATUS),
                LPARAM(0),
            );
            let res_conv = SendMessageW(
                ime_wnd,
                WM_IME_CONTROL,
                WPARAM(IMC_GETCONVERSIONMODE),
                LPARAM(0),
            );

            let is_open = res_open.0 != 0;
            let is_native = (res_conv.0 as u32 & IME_CMODE_NATIVE.0) != 0;
            if is_open && is_native {
                is_chinese = true;
            }
        }

        // 回退到標準 IMM API 偵測
        if !is_chinese {
            let context_hwnd = if !ime_wnd.0.is_null() {
                ime_wnd
            } else {
                target_hwnd
            };

            let himc = ImmGetContext(context_hwnd);
            if !himc.0.is_null() {
                let is_open = ImmGetOpenStatus(himc).as_bool();
                let mut conv = IME_CONVERSION_MODE(0);
                let mut sentence = IME_SENTENCE_MODE(0);
                if ImmGetConversionStatus(himc, Some(&mut conv), Some(&mut sentence)).as_bool() {
                    let is_native = (conv.0 & IME_CMODE_NATIVE.0) != 0;
                    if is_open && is_native {
                        is_chinese = true;
                    }
                }
                let _ = ImmReleaseContext(context_hwnd, himc);
            }
        }

        is_chinese
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
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
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

    // 判斷前景視窗是否為 OSK 本身，避免在使用鍵盤時被隱藏
    let is_osk_focused = if let Ok(guard) = GLOBAL_WINDOW.lock() {
        if let Some(window) = guard.as_ref() {
            if let Ok(our_hwnd) = window.hwnd() {
                let fg_hwnd = unsafe { GetForegroundWindow() };
                (fg_hwnd.0 as usize) == (our_hwnd.0 as usize)
            } else {
                false
            }
        } else {
            false
        }
    } else {
        false
    };

    // 偵測輸入法系統視窗，避免在選字時頻繁觸發置頂邏輯導致閃爍
    let fg_hwnd = unsafe { GetForegroundWindow() };
    let fg_class = get_window_class(fg_hwnd);
    let is_ime_candidate = fg_class.contains("IME")
        || fg_class.contains("Candidate")
        || fg_class == "Windows.UI.Core.CoreWindow";

    if let Ok(guard) = GLOBAL_WINDOW.lock() {
        if let Some(window) = guard.as_ref() {
            let _diag_id = DIAG_ID.fetch_add(1, Ordering::Relaxed);
            let (_is_caps, _is_num) = crate::system::keyboard_simulator::get_locks();
            let is_zh = is_ime_active();
            let clipboard = get_clipboard_text();

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
    if let Ok(mut guard) = GLOBAL_WINDOW.lock() {
        *guard = Some(window.clone());
    }

    update_osk_state();

    // 定時輪詢備援機制
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_millis(600));
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
