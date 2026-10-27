use crate::export::export_session;
use crate::models::{ExportFormat, ExportResult, GpsPoint, RawLocationInput, Session, SessionStats};
use crate::simulator::generate_demo_track;
use crate::storage::SharedStorage;
use crate::telemetry::calculate_point;
use tauri::State;

#[tauri::command]
pub fn cmd_load_sessions(storage: State<'_, SharedStorage>) -> Result<Vec<Session>, String> {
    Ok(storage.get_all())
}

#[tauri::command]
pub fn cmd_save_session(session: Session, storage: State<'_, SharedStorage>) -> Result<(), String> {
    storage.save(session)
}

#[tauri::command]
pub fn cmd_delete_session(id: String, storage: State<'_, SharedStorage>) -> Result<bool, String> {
    storage.delete(&id)
}

#[tauri::command]
pub fn cmd_process_point(
    prev_pt: Option<GpsPoint>,
    raw: RawLocationInput,
    mut stats: SessionStats,
    count: usize,
    sum_speeds: f64,
) -> Result<(GpsPoint, SessionStats), String> {
    let pt = calculate_point(prev_pt.as_ref(), raw, &mut stats, count, sum_speeds);
    Ok((pt, stats))
}

#[tauri::command]
pub fn cmd_generate_demo_track(custom_name: Option<String>) -> Result<Session, String> {
    Ok(generate_demo_track(custom_name))
}

#[tauri::command]
pub fn cmd_export_session(session: Session, format: String) -> Result<ExportResult, String> {
    let fmt = match format.to_lowercase().as_str() {
        "gpx" => ExportFormat::Gpx,
        "geojson" => ExportFormat::Geojson,
        "csv" => ExportFormat::Csv,
        other => return Err(format!("Unsupported format: {}", other)),
    };

    Ok(export_session(&session, fmt))
}

#[tauri::command]
pub fn cmd_save_export_file(filename: String, content: String) -> Result<String, String> {
    let base_dir = dirs::download_dir()
        .or_else(dirs::document_dir)
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let target_path = base_dir.join(&filename);
    std::fs::write(&target_path, content.as_bytes()).map_err(|e| e.to_string())?;

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cmd_get_app_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "name": "Trace",
        "version": "1.0.0",
        "engine": "Rust 2021 + Tauri v2",
        "features": [
            "Hardware GPS Blackbox",
            "Indoor Sensor Simulation",
            "Vector Map Replay",
            "Dynamic Gradient & Speed Scrubber",
            "GPX / GeoJSON / CSV Native Export",
            "Audio & Screen Keep-Alive"
        ]
    }))
}
