mod system;

use system::input_detector::start_detector;
use system::keyboard_simulator::simulate_key;
use system::window_manager::setup_osk_window;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            simulate_key,
            system::keyboard_simulator::simulate_combination,
            system::keyboard_simulator::release_all_modifiers,
            system::keyboard_simulator::get_locks,
            system::window_manager::force_exit,
            system::window_manager::open_sos,
            system::window_manager::set_pinned,
            system::window_manager::resize_window,
            system::window_manager::save_config,
            system::window_manager::load_config,
            system::window_manager::resize_and_recenter,
            system::window_manager::get_relative_pos,
            system::window_manager::apply_relative_pos,
            system::window_manager::set_manually_hidden,
            system::window_manager::reset_config,
            system::window_manager::set_dynamic_display,
            system::window_manager::update_aspect_ratio,
            system::window_manager::set_topmost,
            system::window_manager::start_poll_drag,
            system::window_manager::start_poll_resize,
            system::window_manager::execute_app,
            system::window_manager::set_recording_mode
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // 初始化 OSK 視窗樣式
            setup_osk_window(&window);

            // 初始化全域實體鍵盤掛鉤
            system::input_hook::init_global_hook(app.handle().clone());

            // 設定系統托盤 (System Tray)
            let reset_i =
                MenuItem::with_id(app, "reset", "重置設定 (Reset Config)", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "完全退出 (Exit)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&reset_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "reset" => {
                        let _ = system::window_manager::reset_config();
                        tauri::process::restart(&app.env());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let is_visible = system::window_manager::is_osk_visible();
                        if is_visible {
                            // 當前為顯示狀態 -> 執行手動隱藏
                            system::window_manager::set_manually_hidden(true);
                            if let Some(window) = _tray.app_handle().get_webview_window("main") {
                                let _ = window.emit("backend_pin_updated", false);
                            }
                        } else {
                            // 當前為隱藏狀態 -> 強制恢復顯示（並設為固定模式，避免焦點改變後立刻消失）
                            system::window_manager::set_manually_hidden(false);
                            system::window_manager::set_pinned(true);
                            if let Some(window) = _tray.app_handle().get_webview_window("main") {
                                let _ = window.emit("backend_pin_updated", true);
                            }
                        }
                    }
                })
                .build(app)?;

            // 初始螢幕邊界檢查
            let _ = system::window_manager::keep_window_in_screen(&window);

            // 啟動輸入焦點偵測器
            start_detector(window.clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(_) = event {
                if let Ok(hwnd) = window.hwnd() {
                    crate::system::window_manager::register_hwnd(hwnd.0 as isize);
                    unsafe {
                        use windows::Win32::UI::WindowsAndMessaging::SetPropW;
                        use windows::Win32::Foundation::HANDLE;
                        use windows::core::PCWSTR;
                        let prop_name: Vec<u16> = "IS_RUSTOSK_WINDOW\0".encode_utf16().collect();
                        let _ = SetPropW(windows::Win32::Foundation::HWND(hwnd.0 as _), PCWSTR::from_raw(prop_name.as_ptr()), HANDLE(1 as *mut _));
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
