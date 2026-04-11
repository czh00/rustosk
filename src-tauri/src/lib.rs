mod system;

use tauri::{Manager, Emitter, menu::{Menu, MenuItem}, tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState}};
use system::keyboard_simulator::simulate_key;
use system::window_manager::setup_osk_window;
use system::input_detector::start_detector;


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            simulate_key, 
            system::keyboard_simulator::get_locks,
            system::window_manager::start_custom_drag, 
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
            system::window_manager::update_aspect_ratio
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            
            // Initialize the OSK window styles
            setup_osk_window(&window);
            
            // Setup System Tray
            let reset_i = MenuItem::with_id(app, "reset", "重置設定 (Reset Config)", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "完全退出 (Exit)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&reset_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "reset" => {
                            let _ = system::window_manager::reset_config();
                            app.exit(0);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|_tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
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

            // Start focus detector
            start_detector(window.clone());
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
