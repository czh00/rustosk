use std::sync::atomic::{AtomicIsize, AtomicBool, Ordering};
use tauri::{WebviewWindow, LogicalSize, Size, PhysicalPosition, Position};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWLP_WNDPROC, HWND_TOPMOST,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WM_MOUSEACTIVATE, MA_NOACTIVATE, CallWindowProcW, ShowWindow, SW_SHOWNOACTIVATE,
    SW_SHOWNORMAL, SW_HIDE, IsWindowVisible, WM_NCHITTEST, WM_SIZING,
    HTLEFT, HTRIGHT, HTTOP, HTBOTTOM, HTTOPLEFT, HTTOPRIGHT, HTBOTTOMLEFT, HTBOTTOMRIGHT, 
    WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::core::PCWSTR;
use crate::system::input_detector::update_osk_state;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;


static CACHED_HWND: AtomicIsize = AtomicIsize::new(0);
pub static IS_PINNED: AtomicBool = AtomicBool::new(true);
pub static IS_MANUALLY_HIDDEN: AtomicBool = AtomicBool::new(false);
static PREV_WNDPROC: AtomicIsize = AtomicIsize::new(0);
pub static IS_DYNAMIC_DISPLAY: AtomicBool = AtomicBool::new(false);
static TARGET_ASPECT_RATIO: AtomicU64 = AtomicU64::new(0); // Bits of f64

#[tauri::command]
pub fn open_sos() {
    unsafe {
        let path: Vec<u16> = "osk.exe\0".encode_utf16().collect();
        let operation: Vec<u16> = "open\0".encode_utf16().collect();
        let _ = ShellExecuteW(
            HWND::default(),
            PCWSTR(operation.as_ptr()),
            PCWSTR(path.as_ptr()),
            PCWSTR(std::ptr::null()),
            PCWSTR(std::ptr::null()),
            SW_SHOWNORMAL,
        );
    }
}

#[tauri::command]
pub fn set_pinned(pinned: bool) {
    IS_PINNED.store(pinned, Ordering::Relaxed);
    if pinned {
        // 開啟固定模式時，自動解除手動隱藏狀態
        IS_MANUALLY_HIDDEN.store(false, Ordering::Relaxed);
    }
    std::thread::spawn(|| {
        update_osk_state();
    });
}

#[tauri::command]
pub fn set_manually_hidden(hidden: bool) {
    IS_MANUALLY_HIDDEN.store(hidden, Ordering::Relaxed);
    std::thread::spawn(|| {
        update_osk_state();
    });
}

#[tauri::command]
pub fn reset_config() -> Result<(), String> {
    let path = get_config_path();
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_dynamic_display(enabled: bool) {
    IS_DYNAMIC_DISPLAY.store(enabled, Ordering::Relaxed);
    std::thread::spawn(|| {
        update_osk_state();
    });
}

#[tauri::command]
pub fn resize_window(window: WebviewWindow, width: f64, height: f64) {
    let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
}

#[tauri::command]
pub fn start_custom_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

#[tauri::command]
pub fn force_exit() {
    std::process::exit(0);
}

fn get_config_path() -> PathBuf {
    // 優先存放在與執行檔相同的目錄下 (Portable Mode)
    if let Ok(mut exe_path) = std::env::current_exe() {
        exe_path.pop(); // 移除檔名，保留目錄
        return exe_path.join("osk.ini");
    }
    
    // 環境變數回退機制
    if let Ok(appdata) = std::env::var("APPDATA") {
        let mut path = PathBuf::from(appdata);
        path.push("rustosk");
        let _ = fs::create_dir_all(&path);
        path.push("osk.ini");
        return path;
    }
    
    PathBuf::from("osk.ini")
}

#[tauri::command]
pub fn save_config(data: String) -> Result<(), String> {
    let path = get_config_path();
    fs::write(path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_config() -> Result<String, String> {
    let path = get_config_path();
    if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())
    } else {
        Err("No config found".to_string())
    }
}

pub fn show_osk_no_activate() {
    let hwnd_ptr = CACHED_HWND.load(Ordering::Relaxed);
    if hwnd_ptr != 0 {
        unsafe {
            let hwnd = HWND(hwnd_ptr as _);
            
            // 視窗顯示邏輯：若目前不可見，執行置頂與顯示指令
            if !IsWindowVisible(hwnd).as_bool() {
                let _ = SetWindowPos(
                    hwnd,
                    HWND(-2 as _),
                    0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            } else {
                // 若已經可見，僅確保置頂屬性，避免觸發全域 Z-order 重算以減少閃爍
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
            
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }
}

pub fn hide_osk() {
    let hwnd_ptr = CACHED_HWND.load(Ordering::Relaxed);
    if hwnd_ptr != 0 {
        unsafe {
            let _ = ShowWindow(HWND(hwnd_ptr as _), SW_HIDE);
        }
    }
}

pub fn is_osk_visible() -> bool {
    let hwnd_ptr = CACHED_HWND.load(Ordering::Relaxed);
    if hwnd_ptr != 0 {
        unsafe {
            IsWindowVisible(HWND(hwnd_ptr as _)).as_bool()
        }
    } else {
        false
    }
}

unsafe extern "system" fn osk_wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_MOUSEACTIVATE {
        return LRESULT(MA_NOACTIVATE as i32 as isize);
    }

    if msg == WM_NCHITTEST {
        let x = (lparam.0 & 0xFFFF) as i16 as i32;
        let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
        
        let mut rect = RECT::default();
        let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect);
        
        let border = 8;
        let left = x < rect.left + border;
        let right = x >= rect.right - border;
        let top = y < rect.top + border;
        let bottom = y >= rect.bottom - border;
        
        if top && left { return LRESULT(HTTOPLEFT as isize); }
        if top && right { return LRESULT(HTTOPRIGHT as isize); }
        if bottom && left { return LRESULT(HTBOTTOMLEFT as isize); }
        if bottom && right { return LRESULT(HTBOTTOMRIGHT as isize); }
        if left { return LRESULT(HTLEFT as isize); }
        if right { return LRESULT(HTRIGHT as isize); }
        if top { return LRESULT(HTTOP as isize); }
        if bottom { return LRESULT(HTBOTTOM as isize); }
    }

    if msg == WM_SIZING {
        let ratio_bits = TARGET_ASPECT_RATIO.load(Ordering::Relaxed);
        if ratio_bits != 0 {
            let ratio = f64::from_bits(ratio_bits);
            let rect = &mut *(lparam.0 as *mut RECT);
            let width = (rect.right - rect.left) as f64;
            let height = (rect.bottom - rect.top) as f64;
            
            match wparam.0 as u32 {
                WMSZ_LEFT | WMSZ_RIGHT | WMSZ_BOTTOMLEFT | WMSZ_BOTTOMRIGHT | WMSZ_TOPLEFT | WMSZ_TOPRIGHT => {
                    // Update height based on width
                    let new_height = width / ratio;
                    if wparam.0 as u32 == WMSZ_TOPLEFT || wparam.0 as u32 == WMSZ_TOPRIGHT || wparam.0 as u32 == WMSZ_TOP {
                        rect.top = rect.bottom - new_height as i32;
                    } else {
                        rect.bottom = rect.top + new_height as i32;
                    }
                }
                WMSZ_TOP | WMSZ_BOTTOM => {
                    // Update width based on height
                    let new_width = height * ratio;
                    rect.right = rect.left + new_width as i32;
                }
                _ => {}
            }
        }
    }
    
    let prev_proc = PREV_WNDPROC.load(Ordering::Relaxed);
    if prev_proc != 0 {
        return CallWindowProcW(std::mem::transmute(prev_proc), hwnd, msg, wparam, lparam);
    }
    
    windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(hwnd, msg, wparam, lparam)
}

pub fn setup_osk_window(window: &WebviewWindow) {
    let hwnd_ptr = match window.hwnd() {
        Ok(handle) => handle.0 as isize,
        Err(_) => return,
    };
    let hwnd = HWND(hwnd_ptr as _);
    CACHED_HWND.store(hwnd_ptr, Ordering::Relaxed);

    unsafe {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if ex_style != 0 {
            // 強制加上 WS_EX_TOPMOST 確保永遠置頂
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex_style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize | WS_EX_TOPMOST.0 as isize) as isize);
            let _ = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | windows::Win32::UI::WindowsAndMessaging::SWP_FRAMECHANGED,
            );
        }

        let current_wndproc = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        if current_wndproc != osk_wndproc as *const () as isize {
            PREV_WNDPROC.store(current_wndproc, Ordering::Relaxed);
            let _ = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, osk_wndproc as *const () as isize);
        }
    }
}

#[tauri::command]
pub fn resize_and_recenter(window: WebviewWindow, width: f64, height: f64, force_center: bool) -> Result<(), String> {
    // 設定視窗尺寸
    let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
    if force_center {
        if let Some(monitor) = window.primary_monitor().ok().flatten() {
            let scale_factor = monitor.scale_factor();
            let screen_size = monitor.size();
            
            // Calculate physical dimensions
            let target_width = (width * scale_factor) as u32;
            let target_height = (height * scale_factor) as u32;
            
            let x = (screen_size.width as f64 - target_width as f64) / 2.0;
            let y = screen_size.height as f64 - target_height as f64; // 貼著下緣
            
            let _ = window.set_position(Position::Physical(PhysicalPosition {
                x: x as i32,
                y: y as i32,
            }));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_relative_pos(window: WebviewWindow) -> Result<(f64, f64), String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    
    // 優先獲取當前視窗所在的螢幕資訊
    let monitor_opt = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten());
    
    if let Some(monitor) = monitor_opt {
        let size = monitor.size();
        let origin = monitor.position(); // 螢幕左上角的全局座標
        
        // 計算相對於該螢幕原點的比例 (0.0 ~ 1.0 代表在該螢幕內)
        let rx = (pos.x - origin.x) as f64 / size.width as f64;
        let ry = (pos.y - origin.y) as f64 / size.height as f64;
        return Ok((rx, ry));
    }
    
    Ok((0.0, 0.0))
}

#[tauri::command]
pub fn apply_relative_pos(window: WebviewWindow, rx: f64, ry: f64) -> Result<(), String> {
    // 這裡我們需要決定該套用到哪一個螢幕。
    // 通常載入時視窗會在預設位置，我們假設使用者希望恢復到「當前主螢幕」或「上次所在的螢幕」。
    // 由於我們只存了比例，如果螢幕佈局沒變，用原來的邏輯找 monitor 即可。
    let monitor_opt = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten());
    
    if let Some(monitor) = monitor_opt {
        let size = monitor.size();
        let origin = monitor.position();
        
        // 根據比例與螢幕原點還原全局座標
        let x = origin.x + (rx * size.width as f64) as i32;
        let y = origin.y + (ry * size.height as f64) as i32;
        let _ = window.set_position(Position::Physical(PhysicalPosition { x, y }));
    }
    Ok(())
}
#[tauri::command]
pub fn update_aspect_ratio(width: f64, height: f64) {
    if height > 0.0 {
        let ratio = width / height;
        TARGET_ASPECT_RATIO.store(ratio.to_bits(), Ordering::Relaxed);
    }
}
