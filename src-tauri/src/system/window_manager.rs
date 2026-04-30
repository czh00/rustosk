use std::sync::atomic::{AtomicIsize, AtomicBool, Ordering};
use tauri::{WebviewWindow, LogicalSize, Size, PhysicalPosition, Position, Emitter};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM, RECT, HANDLE};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWLP_WNDPROC, HWND_TOPMOST,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WM_MOUSEACTIVATE, MA_NOACTIVATE, CallWindowProcW, ShowWindow, SW_SHOWNOACTIVATE,
    SW_SHOWNORMAL, SW_HIDE, IsWindowVisible, WM_NCHITTEST, FindWindowW,
    HTLEFT, HTRIGHT, HTTOP, HTBOTTOM, HTTOPLEFT, HTTOPRIGHT, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTCAPTION,
    GWL_STYLE, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WM_SYSCOMMAND, SetPropW, HTCLIENT
};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, GetMonitorInfoW, MONITORINFO, MONITOR_DEFAULTTONEAREST};
const WM_EXITSIZEMOVE: u32 = 0x0232;
const WM_NCLBUTTONDBLCLK: u32 = 0x00A3;
const SC_MOVE: usize = 0xF010;
const SC_SIZE: usize = 0xF000;
const SC_MAXIMIZE: usize = 0xF030;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::core::PCWSTR;
// Pointer API currently unused but available
use crate::system::input_detector::update_osk_state;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;


static CACHED_HWND: AtomicIsize = AtomicIsize::new(0);
pub static IS_PINNED: AtomicBool = AtomicBool::new(true);
pub static IS_MANUALLY_HIDDEN: AtomicBool = AtomicBool::new(false);
static PREV_WNDPROC: AtomicIsize = AtomicIsize::new(0);
pub static IS_DYNAMIC_DISPLAY: AtomicBool = AtomicBool::new(false);
pub static IS_TEMPORARY_NOT_TOPMOST: AtomicBool = AtomicBool::new(false);
static TARGET_ASPECT_RATIO: AtomicU64 = AtomicU64::new(0); // Bits of f64

#[tauri::command]
pub fn open_sos(window: WebviewWindow) {
    let original_pinned = IS_PINNED.load(Ordering::Relaxed);
    
    // 1. 設定鎖定模式與隱藏本體
    IS_PINNED.store(true, Ordering::Relaxed);
    IS_MANUALLY_HIDDEN.store(true, Ordering::Relaxed);
    
    // 2. 同步 UI 事件
    let _ = window.emit("backend_pin_updated", true);
    
    // 3. 執行隱藏並觸發顯示偵測
    std::thread::spawn(|| {
        update_osk_state();
    });

    // 4. 啟動系統 osk.exe
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

    // 5. 啟動背景執行緒監控 osk.exe
    std::thread::spawn(move || {
        // 等待一下確保 osk.exe 視窗有機會出現
        std::thread::sleep(std::time::Duration::from_millis(1500));
        
        let class_name: Vec<u16> = "OSKMainClass\0".encode_utf16().collect();
        
        // 輪詢直到 OSK 視窗消失
        loop {
            let hwnd = unsafe { 
                FindWindowW(
                    PCWSTR(class_name.as_ptr()), 
                    PCWSTR(std::ptr::null())
                ) 
            }.unwrap_or(HWND::default());
            
            if hwnd.0.is_null() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1000));
        }
        
        // 恢復原始狀態
        IS_MANUALLY_HIDDEN.store(false, Ordering::Relaxed);
        IS_PINNED.store(original_pinned, Ordering::Relaxed);
        let _ = window.emit("backend_pin_updated", original_pinned);
        update_osk_state();
    });
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
pub fn set_topmost(enabled: bool) {
    IS_TEMPORARY_NOT_TOPMOST.store(!enabled, Ordering::Relaxed);
    std::thread::spawn(|| {
        update_osk_state();
    });
}

#[tauri::command]
pub fn resize_window(window: WebviewWindow, width: f64, height: f64) {
    let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
}

// 手動拖曳與縮放的共用邏輯
fn start_manual_interaction(hwnd: HWND, direction: Option<&'static str>) {
    let hwnd_ptr = hwnd.0 as isize;
    std::thread::spawn(move || {
        let hwnd = windows::Win32::Foundation::HWND(hwnd_ptr as _);
        unsafe {
            let mut start_pt = POINT::default();
            if GetCursorPos(&mut start_pt).is_err() { return; }
            
            let mut start_rect = RECT::default();
            let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut start_rect);
            
            let ratio_bits = TARGET_ASPECT_RATIO.load(Ordering::Relaxed);
            let ratio = if ratio_bits != 0 { Some(f64::from_bits(ratio_bits)) } else { None };

            let offset_x = start_pt.x - start_rect.left;
            let offset_y = start_pt.y - start_rect.top;

            std::thread::sleep(std::time::Duration::from_millis(10));
            loop {
                // 檢查左鍵是否仍按下 (支援滑鼠與大多數觸控)
                if GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000 == 0 {
                    break;
                }
                
                let mut pt = POINT::default();
                if GetCursorPos(&mut pt).is_ok() {
                    if let Some(dir) = direction {
                        let mut new_rect = start_rect;
                        let dx = pt.x - start_pt.x;
                        let dy = pt.y - start_pt.y;
                        
                        match dir {
                            "left" => { new_rect.left += dx; }
                            "right" => { new_rect.right += dx; }
                            "top" => { new_rect.top += dy; }
                            "bottom" => { new_rect.bottom += dy; }
                            "topleft" => { new_rect.left += dx; new_rect.top += dy; }
                            "topright" => { new_rect.right += dx; new_rect.top += dy; }
                            "bottomleft" => { new_rect.left += dx; new_rect.bottom += dy; }
                            "bottomright" => { new_rect.right += dx; new_rect.bottom += dy; }
                            _ => {}
                        }
                        
                        let mut width = (new_rect.right - new_rect.left) as f64;
                        let mut height = (new_rect.bottom - new_rect.top) as f64;
                        
                        if let Some(r) = ratio {
                            match dir {
                                "left" | "right" | "bottomleft" | "bottomright" | "topleft" | "topright" => {
                                    height = width / r;
                                    if dir.contains("top") {
                                        new_rect.top = new_rect.bottom - height as i32;
                                    } else {
                                        new_rect.bottom = new_rect.top + height as i32;
                                    }
                                }
                                "top" | "bottom" => {
                                    width = height * r;
                                    new_rect.right = new_rect.left + width as i32;
                                }
                                _ => {}
                            }
                        }
                        
                        let _ = SetWindowPos(hwnd, HWND::default(), new_rect.left, new_rect.top, 
                                             new_rect.right - new_rect.left, new_rect.bottom - new_rect.top, 
                                             SWP_NOACTIVATE | SWP_NOZORDER);
                    } else {
                        let _ = SetWindowPos(hwnd, HWND::default(), pt.x - offset_x, pt.y - offset_y, 0, 0, 
                                             SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            keep_hwnd_in_screen(hwnd);
        }
    });
}

use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SWP_NOZORDER};
use windows::Win32::Foundation::POINT;

#[tauri::command]
pub fn start_poll_drag(_window: WebviewWindow, _pointer_id: u32) {
    // 現在改由 wndproc 自動處理，保留此函式以相容舊程式碼
}

#[tauri::command]
pub fn start_poll_resize(_window: WebviewWindow, _direction: String, _pointer_id: u32) {
    // 現在改由 wndproc 自動處理，保留此函式以相容舊程式碼
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
            let is_temp_no_top = IS_TEMPORARY_NOT_TOPMOST.load(Ordering::Relaxed);
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let is_currently_topmost = (ex_style as u32 & WS_EX_TOPMOST.0) != 0;
            let should_be_topmost = !is_temp_no_top;
            
            // 視窗顯示邏輯：若目前不可見，執行置頂與顯示指令
            if !IsWindowVisible(hwnd).as_bool() {
                let _ = SetWindowPos(
                    hwnd,
                    HWND(-2 as _), // HWND_NOTOPMOST
                    0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                
                if !is_temp_no_top {
                    let _ = SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
            } else {
                // 若已經可見，僅在置頂屬性不符合預期時才調用 SetWindowPos
                // 這能避免在暫時取消置頂期間，因輪詢而不斷將視窗提至非置頂層的最前端，導致遮擋調色盤
                if is_currently_topmost != should_be_topmost {
                    let target_z = if is_temp_no_top { HWND(-2 as _) } else { HWND_TOPMOST };
                    let _ = SetWindowPos(
                        hwnd,
                        target_z,
                        0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
            }
            
            if !IsWindowVisible(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
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
        
        let border = 10;
        let corner = 20;
        
        let is_left = x < rect.left + border;
        let is_right = x >= rect.right - border;
        let is_top = y < rect.top + border;
        let is_bottom = y >= rect.bottom - border;
        
        let is_top_corner = y < rect.top + corner;
        let is_bottom_corner = y >= rect.bottom - corner;
        let is_left_corner = x < rect.left + corner;
        let is_right_corner = x >= rect.right - corner;

        // 優先判定角落
        if is_top_corner && is_left_corner { return LRESULT(HTTOPLEFT as isize); }
        if is_top_corner && is_right_corner { return LRESULT(HTTOPRIGHT as isize); }
        if is_bottom_corner && is_left_corner { return LRESULT(HTBOTTOMLEFT as isize); }
        if is_bottom_corner && is_right_corner { return LRESULT(HTBOTTOMRIGHT as isize); }
        
        // 判定邊緣 (10px 範圍)
        if is_left { return LRESULT(HTLEFT as isize); }
        if is_right { return LRESULT(HTRIGHT as isize); }
        if is_top { return LRESULT(HTTOP as isize); }
        if is_bottom { return LRESULT(HTBOTTOM as isize); }
        
        // 判定標題列按鈕區 (右側約 300px 範圍，高度 24px)
        // 回傳 HTCLIENT 讓 WebView2 (及 touch) 能正常點擊按鈕
        if y < rect.top + 24 && x > rect.right - 300 {
            return LRESULT(HTCLIENT as i32 as isize);
        }

        // 其他區域由系統處理 (包括 -webkit-app-region: drag)
    }

    if msg == WM_SYSCOMMAND {
        let cmd = wparam.0 & 0xFFF0;
        match cmd as usize {
            SC_MOVE => {
                // 攔截系統拖曳，改用自定義輪詢以避免鬼影框
                start_manual_interaction(hwnd, None);
                return LRESULT(0);
            }
            SC_SIZE => {
                // 攔截系統縮放
                // 注意：SC_SIZE 的具體方向在 wparam 低位，但這裡簡化處理
                // 實際上大部份縮放會由下面的 WM_NCLBUTTONDOWN 觸發
            }
            _ => {}
        }
    }

    const WM_NCLBUTTONDOWN: u32 = 0x00A1;
    if msg == WM_NCLBUTTONDOWN {
        let hit_test = wparam.0 as i32;
        match hit_test {
            h if h == HTLEFT as i32 => { start_manual_interaction(hwnd, Some("left")); return LRESULT(0); }
            h if h == HTRIGHT as i32 => { start_manual_interaction(hwnd, Some("right")); return LRESULT(0); }
            h if h == HTTOP as i32 => { start_manual_interaction(hwnd, Some("top")); return LRESULT(0); }
            h if h == HTBOTTOM as i32 => { start_manual_interaction(hwnd, Some("bottom")); return LRESULT(0); }
            h if h == HTTOPLEFT as i32 => { start_manual_interaction(hwnd, Some("topleft")); return LRESULT(0); }
            h if h == HTTOPRIGHT as i32 => { start_manual_interaction(hwnd, Some("topright")); return LRESULT(0); }
            h if h == HTBOTTOMLEFT as i32 => { start_manual_interaction(hwnd, Some("bottomleft")); return LRESULT(0); }
            h if h == HTBOTTOMRIGHT as i32 => { start_manual_interaction(hwnd, Some("bottomright")); return LRESULT(0); }
            _ => {}
        }
    }
    
    // 禁用雙擊標題列自動放大 (Aero Snap 觸發)
    if msg == WM_NCLBUTTONDBLCLK && wparam.0 == HTCAPTION as usize {
        return LRESULT(0);
    }

    // 禁用系統選單或快捷鍵觸發的最大化
    if msg == WM_SYSCOMMAND && (wparam.0 & 0xFFF0) == SC_MAXIMIZE {
        return LRESULT(0);
    }
    
    if msg == WM_EXITSIZEMOVE {
        keep_hwnd_in_screen(hwnd);
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
        
        // 移除 WS_MAXIMIZEBOX / WS_MINIMIZEBOX 來避免 Windows 觸發畫面邊緣自動放大 (Aero Snap)
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        if style != 0 {
            let new_style = (style as u32 & !WS_MAXIMIZEBOX.0 & !WS_MINIMIZEBOX.0) as isize;
            let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);
        }

        // 禁用 Windows 10/11 的畫面邊緣動作 (Edge Gestures)
        let prop_name: Vec<u16> = "Microsoft.TabletPC.DisableEdgeGestures\0".encode_utf16().collect();
        let _ = SetPropW(hwnd, PCWSTR(prop_name.as_ptr()), HANDLE(1 as *mut _));
    }
}

#[tauri::command]
pub fn resize_and_recenter(window: WebviewWindow, width: f64, height: f64, force_center: bool) -> Result<(), String> {
    // 設定視窗尺寸
    let _ = window.set_size(Size::Logical(LogicalSize::new(width, height)));
    if force_center {
        let hwnd_ptr = CACHED_HWND.load(Ordering::Relaxed);
        if hwnd_ptr != 0 {
            unsafe {
                let hwnd = HWND(hwnd_ptr as _);
                let monitor_handle = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                let mut info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                
                if GetMonitorInfoW(monitor_handle, &mut info).as_bool() {
                    let work_rect = info.rcWork;
                    let work_width = (work_rect.right - work_rect.left) as f64;
                    
                    // 獲取目前的縮放倍率 (DPI)
                    let scale_factor = match window.primary_monitor() {
                        Ok(Some(m)) => m.scale_factor(),
                        _ => 1.0,
                    };
                    
                    // 計算目標物理尺寸 (v1.3.2)
                    let target_width = (width * scale_factor) as f64;
                    let target_height = (height * scale_factor) as f64;
                    
                    // 定位至工作區域 (Work Area) 的底部中央，避開工作列
                    let x = work_rect.left as f64 + (work_width - target_width) / 2.0;
                    let y = work_rect.bottom as f64 - target_height; 
                    
                    let _ = window.set_position(Position::Physical(PhysicalPosition {
                        x: x as i32,
                        y: y as i32,
                    }));
                }
            }
        } else if let Some(monitor) = window.primary_monitor().ok().flatten() {
            // 回退機制：若無 HWND 則使用 Tauri 預設主螢幕
            let scale_factor = monitor.scale_factor();
            let screen_size = monitor.size();
            
            let target_width = (width * scale_factor) as u32;
            let target_height = (height * scale_factor) as u32;
            
            // 安全回退：若無 HWND 則使用螢幕底部中央 (暫不排除工作列，因為無法從 tauri::Monitor 拿到 rcWork)
            // 但實務上 Windows 平台幾乎總是有 HWND
            let x = (screen_size.width as f64 - target_width as f64) / 2.0;
            let y = screen_size.height as f64 - target_height as f64;
            
            let _ = window.set_position(Position::Physical(PhysicalPosition { x: x as i32, y: y as i32 }));
        }
        
    } else {
        // 如果不是強制居中，也應確保視窗在工作區域內 (v1.3.2)
        if let Ok(handle) = window.hwnd() {
            keep_hwnd_in_screen(HWND(handle.0 as _));
        } else {
            let _ = keep_window_in_screen(&window);
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
        let _ = keep_window_in_screen(&window);
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

pub fn keep_window_in_screen(window: &WebviewWindow) -> Result<(), String> {
    if let Ok(handle) = window.hwnd() {
        keep_hwnd_in_screen(HWND(handle.0 as _));
        return Ok(());
    }

    // 回退機制 (Fallback): 雖然 Windows 平台應優先使用 HWND 版本
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or("No monitor found")?;

    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    
    let window_pos = window.outer_position().map_err(|e| e.to_string())?;
    let window_size = window.outer_size().map_err(|e| e.to_string())?;
    
    let mut new_x = window_pos.x;
    let mut new_y = window_pos.y;
    
    let screen_right = monitor_pos.x + monitor_size.width as i32;
    let screen_bottom = monitor_pos.y + monitor_size.height as i32;
    
    if new_x < monitor_pos.x {
        new_x = monitor_pos.x;
    }
    if new_y < monitor_pos.y {
        new_y = monitor_pos.y;
    }
    if (new_x + window_size.width as i32) > screen_right {
        new_x = screen_right - window_size.width as i32;
    }
    if (new_y + window_size.height as i32) > screen_bottom {
        new_y = screen_bottom - window_size.height as i32;
    }
    
    if new_x != window_pos.x || new_y != window_pos.y {
        let _ = window.set_position(Position::Physical(PhysicalPosition { x: new_x, y: new_y }));
    }
    
    Ok(())
}

fn keep_hwnd_in_screen(hwnd: HWND) {
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let mut rect = RECT::default();
            let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect);
            
            let win_width = rect.right - rect.left;
            let win_height = rect.bottom - rect.top;
            
            let mut new_x = rect.left;
            let mut new_y = rect.top;
            
            let monitor_rect = info.rcWork;
            
            if new_x < monitor_rect.left { new_x = monitor_rect.left; }
            if new_y < monitor_rect.top { new_y = monitor_rect.top; }
            if (new_x + win_width) > monitor_rect.right { new_x = monitor_rect.right - win_width; }
            if (new_y + win_height) > monitor_rect.bottom { new_y = monitor_rect.bottom - win_height; }
            
            if new_x != rect.left || new_y != rect.top {
                let _ = SetWindowPos(
                    hwnd,
                    HWND::default(),
                    new_x,
                    new_y,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOACTIVATE | windows::Win32::UI::WindowsAndMessaging::SWP_NOZORDER,
                );
            }
        }
    }
}

