use tauri::command;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    KEYEVENTF_EXTENDEDKEY, MapVirtualKeyW, MAPVK_VK_TO_VSC, GetKeyState
};
use std::mem::size_of;

/// 判斷是否為擴展鍵 (如方向鍵、功能鍵區等)
fn is_extended_key(vk: u16) -> bool {
    (0x21..=0x2E).contains(&vk)
        || (0x25..=0x28).contains(&vk)
        || matches!(vk, 0xA1 | 0xA3 | 0xA5 | 0x5B | 0x5C)
}

#[command]
pub fn simulate_key(vk_code: u8, is_key_up: bool) {
    let mut flags = if is_key_up {
        KEYEVENTF_KEYUP
    } else {
        windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0)
    };

    if is_extended_key(vk_code as u16) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }

    let scan_code = unsafe { MapVirtualKeyW(vk_code as u32, MAPVK_VK_TO_VSC) as u16 };

    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk_code as u16),
                wScan: scan_code,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };

    unsafe {
        let _ = SendInput(&[input], size_of::<INPUT>() as i32);
    }
}

#[command]
pub fn get_locks() -> (bool, bool) {
    unsafe {
        let caps = (GetKeyState(0x14) & 1) == 1; // VK_CAPITAL
        let num = (GetKeyState(0x90) & 1) == 1; // VK_NUMLOCK
        (caps, num)
    }
}
