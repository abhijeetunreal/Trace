use serde::{Deserialize, Serialize};

/// High-precision GPS telemetry point recorded by the hardware GPS or simulator
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpsPoint {
    pub lat: f64,
    pub lon: f64,
    pub alt: f64,
    pub speed: f64,    // in km/h
    pub acc: f64,      // accuracy in meters
    pub grade: f64,    // slope/gradient in percentage (%)
    pub ts: i64,       // Unix timestamp in milliseconds
    pub dist_km: f64,  // Cumulative distance from start of track
}

/// Aggregated statistical summary for a recording session
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub distance_km: f64,
    pub max_speed_kmh: f64,
    pub avg_speed_kmh: f64,
    pub elevation_gain_m: f64,
    pub min_alt_m: Option<f64>,
    pub max_alt_m: Option<f64>,
    pub duration_ms: i64,
}

/// Full recorded trace session holding all breadcrumbs and statistics
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub points: Vec<GpsPoint>,
    pub stats: SessionStats,
}

/// Raw input payload received from hardware GPS / Web Geolocation API / Simulator
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawLocationInput {
    pub lat: f64,
    pub lon: f64,
    pub alt: Option<f64>,
    pub speed_ms: Option<f64>,
    pub acc: Option<f64>,
    pub ts: Option<i64>,
}

/// Supported telemetry export file formats
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Gpx,
    Geojson,
    Csv,
}

/// Payload returned upon formatting telemetry for export or native share
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub body: String,
    pub mime_type: String,
    pub filename: String,
}
