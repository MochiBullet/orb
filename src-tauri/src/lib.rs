mod commands;
mod config;
mod error;
mod pty;
mod shell;
mod state;
mod usage;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::spawn_pty,
            commands::write_pty,
            commands::resize_pty,
            commands::close_pty,
            commands::list_projects,
            commands::get_config,
            commands::get_usage,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // アプリ終了時に全 PTY をツリーごと kill して子 pwsh の孤児化を防ぐ
            // （process::exit で Drop が走らない経路の保険）。
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<AppState>();
                let mut ptys = state.ptys.lock().unwrap();
                for (_, mut handle) in ptys.drain() {
                    handle.kill();
                }
            }
        });
}
