use lazy_static::lazy_static;
use crate::system::window_manager::IS_RECORDING;
use std::sync::atomic::Ordering;
use serde::Serialize;
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
    WM_SYSKEYDOWN, WM_SYSKEYUP,
};

#[derive(Clone, Copy)]
struct SafeHook(HHOOK);
unsafe impl Send for SafeHook {}
unsafe impl Sync for SafeHook {}

lazy_static! {
    static ref APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);
    static ref HOOK_HANDLE: Mutex<Option<SafeHook>> = Mutex::new(None);
    static ref KEY_CHANNEL: (std::sync::mpsc::Sender<PhysicalKeyEvent>, Mutex<std::sync::mpsc::Receiver<PhysicalKeyEvent>>) = {
        let (tx, rx) = std::sync::mpsc::channel();
        (tx, Mutex::new(rx))
    };
}

#[derive(Serialize, Clone)]
struct PhysicalKeyEvent {
    code: u32,
    is_down: bool,
}

pub fn init_global_hook(app_handle: AppHandle) {
    if APP_HANDLE.lock().unwrap().is_some() {
        return; // Already initialized
    }

    *APP_HANDLE.lock().unwrap() = Some(app_handle);

    // Start background worker for key emission
    thread::spawn(|| {
        let rx = KEY_CHANNEL.1.lock().unwrap();
        while let Ok(ev) = rx.recv() {
            if let Ok(guard) = APP_HANDLE.lock() {
                if let Some(app) = guard.as_ref() {
                    let _ = app.emit("physical_key", ev);
                }
            }
        }
    });

    thread::spawn(move || unsafe {
        let hmod_result = GetModuleHandleW(PCWSTR::null());
        let hmod = match hmod_result {
            Ok(h) => h,
            Err(_) => return, // Cannot get module handle, abort hook
        };

        let hook_result = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), hmod, 0);

        if let Ok(h) = hook_result {
            *HOOK_HANDLE.lock().unwrap() = Some(SafeHook(h));

            // Dedicated message loop to prevent Hook Timeout
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, None, 0, 0).into() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let handle = *HOOK_HANDLE.lock().unwrap();
            if let Some(sh) = handle {
                let _ = UnhookWindowsHookEx(sh.0);
            }
        } else {
            eprintln!("Failed to install global keyboard hook.");
        }
    });
}

unsafe extern "system" fn keyboard_hook_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    let hook_handle = *HOOK_HANDLE.lock().unwrap();
    let hook_handle_ptr = hook_handle.map(|s| s.0).unwrap_or_default();

    if n_code >= 0 {
        let kbd_struct = *(l_param.0 as *const KBDLLHOOKSTRUCT);

        let wp = w_param.0 as u32;
        let is_down = wp == WM_KEYDOWN || wp == WM_SYSKEYDOWN;
        let is_up = wp == WM_KEYUP || wp == WM_SYSKEYUP;

        let is_recording = IS_RECORDING.load(Ordering::SeqCst);

        if is_down || is_up {
            if let Ok(guard) = APP_HANDLE.lock() {
                if let Some(_app) = guard.as_ref() {
                    let ev = PhysicalKeyEvent {
                        code: kbd_struct.vkCode,
                        is_down,
                    };
                    let _ = KEY_CHANNEL.0.send(ev);
                }
            }
        }

        if is_recording {
            if crate::system::window_manager::is_app_focused() {
                unsafe {
                    let ctrl = (windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x11) as u16 & 0x8000) != 0;
                    let alt = (windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x12) as u16 & 0x8000) != 0;
                    let shift = (windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x10) as u16 & 0x8000) != 0;
                    let esc = (windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x1B) as u16 & 0x8000) != 0;
                    
                    if ctrl && alt && shift && esc {
                        IS_RECORDING.store(false, Ordering::SeqCst);
                        return CallNextHookEx(hook_handle_ptr, n_code, w_param, l_param);
                    }
                }
                
                return LRESULT(1);
            }
            
            return CallNextHookEx(hook_handle_ptr, n_code, w_param, l_param);
        }
    }

    CallNextHookEx(hook_handle_ptr, n_code, w_param, l_param)
}
