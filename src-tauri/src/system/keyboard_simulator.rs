use std::mem::size_of;
use tauri::command;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, GetAsyncKeyState, MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
};

/// 判斷是否為擴展鍵 (如方向鍵、功能鍵區等)
fn is_extended_key(vk: u16) -> bool {
    (0x21..=0x2E).contains(&vk)
        || (0x25..=0x28).contains(&vk)
        || matches!(vk, 0xA1 | 0xA3 | 0xA5 | 0x5B | 0x5C)
}

#[command]
pub fn simulate_key(vk_code: u16, is_key_up: bool) {
    simulate_key_native(vk_code, is_key_up);
}

pub fn simulate_key_native(vk_code: u16, is_key_up: bool) {
    unsafe {
        let scan_code = MapVirtualKeyW(vk_code as u32, MAPVK_VK_TO_VSC) as u16;
        
        let mut flags = if is_key_up {
            windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0x0002) // KEYEVENTF_KEYUP
        } else {
            windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0)
        };

        if is_extended_key(vk_code) {
            flags |= windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0x0001); // KEYEVENTF_EXTENDEDKEY
        }

        // 使用較老但有時在特定環境下更穩定的 keybd_event
        windows::Win32::UI::Input::KeyboardAndMouse::keybd_event(
            vk_code as u8,
            scan_code as u8,
            flags,
            0,
        );
    }
}

#[command]
pub fn release_all_modifiers() {
    // 強制放開所有「當前正被按下」的修飾鍵，避免干擾巨集
    let modifiers = [
        0xA0, 0xA1, // L/R SHIFT
        0xA2, 0xA3, // L/R CONTROL
        0xA4, 0xA5, // L/R MENU (ALT)
        0x5B, 0x5C, // L/R WIN
        0x10, 0x11, 0x12, // 通用 SHIFT/CTRL/ALT
    ];

    for &vk in &modifiers {
        unsafe {
            // 使用 GetAsyncKeyState 檢查全域按鍵狀態
            if (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 {
                simulate_key_native(vk, true);
                // 僅在必要時給予極短延遲 (1ms)
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }
}

#[command]
pub fn simulate_combination(vk_codes: Vec<u8>) {
    let mut inputs = Vec::new();

    // 按下所有按鍵
    for &vk in &vk_codes {
        let mut flags = windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0);
        if is_extended_key(vk as u16) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk as u16),
                    wScan: unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) as u16 },
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
    }

    // 以相反順序放開所有按鍵
    for &vk in vk_codes.iter().rev() {
        let mut flags = KEYEVENTF_KEYUP;
        if is_extended_key(vk as u16) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk as u16),
                    wScan: unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) as u16 },
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
    }

    unsafe {
        let _ = SendInput(&inputs, size_of::<INPUT>() as i32);
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
