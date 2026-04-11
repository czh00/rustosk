use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        
        if let Ok(automation) = windows::Win32::System::Com::CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, windows::Win32::System::Com::CLSCTX_INPROC_SERVER) {
            for _ in 0..5 {
                if let Ok(element) = automation.GetFocusedElement() {
                    let _is_focus = element.CurrentIsKeyboardFocusable().unwrap_or(windows::Win32::Foundation::BOOL(0));
                    let _has_focus = element.CurrentHasKeyboardFocus().unwrap_or(windows::Win32::Foundation::BOOL(0));
                    let ctrl_type = element.CurrentControlType().unwrap_or(windows::Win32::UI::Accessibility::UIA_CONTROLTYPE_ID(0));
                    let class_name = element.CurrentClassName().unwrap_or_default();
                    println!("T:{} | Class:{}", ctrl_type.0, class_name);
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }
        CoUninitialize();
    }
}
