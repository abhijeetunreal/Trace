use crate::models::{ExportFormat, ExportResult, Session};
use chrono::{DateTime, Utc};

/// Sanitize a string to be safely used as a filename
pub fn sanitize_filename(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect();
    let cleaned = slug.split('_').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("_");
    if cleaned.is_empty() {
        "trace_track".to_string()
    } else {
        cleaned
    }
}

/// Escape XML entities
fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Convert timestamp in milliseconds to ISO-8601 UTC string
fn ts_to_iso(ts: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ts)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

/// Generate GPX 1.1 XML track representation
pub fn generate_gpx(session: &Session) -> String {
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str("<gpx version=\"1.1\" creator=\"Trace Precision GPS Telemetry\" xmlns=\"http://www.topografix.com/GPX/1/1\">\n");
    out.push_str("  <metadata>\n");
    out.push_str(&format!("    <name>{}</name>\n", xml_escape(&session.name)));
    out.push_str(&format!("    <time>{}</time>\n", xml_escape(&session.created_at)));
    out.push_str("  </metadata>\n");
    out.push_str("  <trk>\n");
    out.push_str(&format!("    <name>{}</name>\n", xml_escape(&session.name)));
    out.push_str("    <trkseg>\n");

    for p in &session.points {
        let speed_ms = (p.speed / 3.6 * 100.0).round() / 100.0;
        out.push_str(&format!(
            "      <trkpt lat=\"{:.6}\" lon=\"{:.6}\">\n",
            p.lat, p.lon
        ));
        out.push_str(&format!("        <ele>{:.1}</ele>\n", p.alt));
        out.push_str(&format!("        <time>{}</time>\n", ts_to_iso(p.ts)));
        out.push_str(&format!(
            "        <extensions><speed>{:.2}</speed><grade>{:.1}</grade></extensions>\n",
            speed_ms, p.grade
        ));
        out.push_str("      </trkpt>\n");
    }

    out.push_str("    </trkseg>\n");
    out.push_str("  </trk>\n");
    out.push_str("</gpx>\n");

    out
}

/// Generate GeoJSON FeatureCollection representation
pub fn generate_geojson(session: &Session) -> String {
    let coordinates: Vec<[f64; 3]> = session
        .points
        .iter()
        .map(|p| [p.lon, p.lat, p.alt])
        .collect();

    let speeds_kmh: Vec<f64> = session.points.iter().map(|p| p.speed).collect();
    let timestamps: Vec<i64> = session.points.iter().map(|p| p.ts).collect();

    let geojson = serde_json::json!({
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": session.name,
                    "createdAt": session.created_at,
                    "stats": session.stats,
                    "speedsKmh": speeds_kmh,
                    "timestamps": timestamps
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coordinates
                }
            }
        ]
    });

    serde_json::to_string_pretty(&geojson).unwrap_or_else(|_| "{}".to_string())
}

/// Generate CSV export data
pub fn generate_csv(session: &Session) -> String {
    let mut out = String::new();
    out.push_str("iso_time,latitude,longitude,altitude_m,speed_kmh,distance_km,grade_pct,accuracy_m\n");

    for p in &session.points {
        out.push_str(&format!(
            "{},{:.6},{:.6},{:.1},{:.1},{:.4},{:.1},{:.1}\n",
            ts_to_iso(p.ts),
            p.lat,
            p.lon,
            p.alt,
            p.speed,
            p.dist_km,
            p.grade,
            p.acc
        ));
    }

    out
}

/// Formats the session into the desired export payload
pub fn export_session(session: &Session, format: ExportFormat) -> ExportResult {
    let slug = sanitize_filename(&session.name);
    match format {
        ExportFormat::Gpx => ExportResult {
            body: generate_gpx(session),
            mime_type: "application/gpx+xml".to_string(),
            filename: format!("{}.gpx", slug),
        },
        ExportFormat::Geojson => ExportResult {
            body: generate_geojson(session),
            mime_type: "application/geo+json".to_string(),
            filename: format!("{}.geojson", slug),
        },
        ExportFormat::Csv => ExportResult {
            body: generate_csv(session),
            mime_type: "text/csv".to_string(),
            filename: format!("{}.csv", slug),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{GpsPoint, SessionStats};

    fn make_test_session() -> Session {
        Session {
            id: "test_123".to_string(),
            name: "Alpine Pass Demo".to_string(),
            created_at: "2026-10-27T10:00:00Z".to_string(),
            points: vec![
                GpsPoint {
                    lat: 46.5286,
                    lon: 10.4531,
                    alt: 2150.0,
                    speed: 36.0,
                    acc: 3.0,
                    grade: 0.0,
                    ts: 1700000000000,
                    dist_km: 0.0,
                },
                GpsPoint {
                    lat: 46.5296,
                    lon: 10.4541,
                    alt: 2160.0,
                    speed: 42.0,
                    acc: 2.5,
                    grade: 5.2,
                    ts: 1700000005000,
                    dist_km: 0.15,
                },
            ],
            stats: SessionStats {
                distance_km: 0.15,
                max_speed_kmh: 42.0,
                avg_speed_kmh: 39.0,
                elevation_gain_m: 10.0,
                min_alt_m: Some(2150.0),
                max_alt_m: Some(2160.0),
                duration_ms: 5000,
            },
        }
    }

    #[test]
    fn test_gpx_generation() {
        let s = make_test_session();
        let gpx = generate_gpx(&s);
        assert!(gpx.contains("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(gpx.contains("<trkpt lat=\"46.528600\" lon=\"10.453100\">"));
        assert!(gpx.contains("<ele>2150.0</ele>"));
        assert!(gpx.contains("<extensions><speed>10.00</speed><grade>0.0</grade></extensions>"));
    }

    #[test]
    fn test_geojson_generation() {
        let s = make_test_session();
        let geojson_str = generate_geojson(&s);
        let val: serde_json::Value = serde_json::from_str(&geojson_str).unwrap();
        assert_eq!(val["type"], "FeatureCollection");
        assert_eq!(val["features"][0]["geometry"]["type"], "LineString");
    }

    #[test]
    fn test_csv_generation() {
        let s = make_test_session();
        let csv = generate_csv(&s);
        assert!(csv.starts_with("iso_time,latitude,longitude,altitude_m,speed_kmh,distance_km,grade_pct,accuracy_m"));
        assert!(csv.contains("46.528600,10.453100,2150.0,36.0,0.0000,0.0,3.0"));
    }
}
