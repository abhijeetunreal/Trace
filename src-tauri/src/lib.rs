pub mod commands;
pub mod export;
pub mod models;
pub mod simulator;
pub mod storage;
pub mod telemetry;

use std::sync::Arc;
use storage::StorageManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let storage = Arc::new(StorageManager::new());

    tauri::Builder::default()
        .manage(storage)
        .invoke_handler(tauri::generate_handler![
            commands::cmd_load_sessions,
            commands::cmd_save_session,
            commands::cmd_delete_session,
            commands::cmd_process_point,
            commands::cmd_generate_demo_track,
            commands::cmd_export_session,
            commands::cmd_save_export_file,
            commands::cmd_get_app_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running Trace GPS application");
}
