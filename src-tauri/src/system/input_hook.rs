use lazy_static::lazy_static;
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

    thread::spawn(move || unsafe {
        let hmod_result = GetModuleHandleW(PCWSTR::null());
        let hmod = match hmod_result {
            Ok(h) => h,
            Err(_) => return, // Cannot get module handle, abort hook
        };

        let hook_result = SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keyboard_hook_proc),
            hmod,
            0,
        );

        if let Ok(h) = hook_result {
            *HOOK_HANDLE.lock().unwrap() = Some(SafeHook(h));

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

        // LLKHF_INJECTED is 0x00000010
        let is_injected = (kbd_struct.flags.0 & 0x10) != 0;

        if !is_injected {
            let wp = w_param.0 as u32;
            let is_down = wp == WM_KEYDOWN || wp == WM_SYSKEYDOWN;
            let is_up = wp == WM_KEYUP || wp == WM_SYSKEYUP;

            if is_down || is_up {
                if let Ok(guard) = APP_HANDLE.lock() {
                    if let Some(app) = guard.as_ref() {
                        let ev = PhysicalKeyEvent {
                            code: kbd_struct.vkCode,
                            is_down,
                        };
                        let _ = app.emit("physical_key", ev);
                    }
                }
            }
        }
    }

    CallNextHookEx(hook_handle_ptr, n_code, w_param, l_param)
}
