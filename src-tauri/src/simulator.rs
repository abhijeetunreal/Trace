use crate::models::{GpsPoint, Session, SessionStats};
use crate::telemetry::recompute_session_stats;
use chrono::Utc;

/// Generates a realistic high-resolution telemetry recording of an Alpine Mountain Pass
pub fn generate_demo_track(custom_name: Option<String>) -> Session {
    let now = Utc::now();
    let name = custom_name.unwrap_or_else(|| "Stelvio Alpine Pass".to_string());
    let session_id = format!("trc_{}_{:x}", now.timestamp_millis(), rand_suffix());

    let mut lat = 46.5286;
    let mut lon = 10.4531;
    let mut alt = 2165.0;
    let mut dist = 0.0;
    let t0 = now.timestamp_millis() - 150_000;

    let mut points = Vec::with_capacity(95);

    for i in 0..95 {
        let t = i as f64 * 0.14;
        let spd = (42.0 + (t * 0.7).sin() * 25.0 + (t * 1.4).cos() * 10.0).max(12.0);
        let spd = (spd * 10.0).round() / 10.0;
        let hdg = (t * 26.0 + (t * 0.5).sin() * 50.0).to_radians();
        let step_km = (spd / 3600.0) * 1.4;
        let prev_alt = alt;

        lat += (hdg.cos() * step_km) / 111.32;
        lon += (hdg.sin() * step_km) / (111.32 * lat.to_radians().cos());
        alt += (t * 0.35).sin() * 2.2 + 0.45;
        dist += step_km;

        let d_alt = alt - prev_alt;
        let grade = ((d_alt / (step_km * 1000.0)) * 100.0).clamp(-30.0, 30.0);

        points.push(GpsPoint {
            lat: (lat * 1_000_000.0).round() / 1_000_000.0,
            lon: (lon * 1_000_000.0).round() / 1_000_000.0,
            alt: (alt * 10.0).round() / 10.0,
            speed: spd,
            acc: 2.4,
            grade: (grade * 10.0).round() / 10.0,
            ts: t0 + (i as i64 * 1400),
            dist_km: (dist * 10_000.0).round() / 10_000.0,
        });
    }

    let mut session = Session {
        id: session_id,
        name,
        created_at: now.to_rfc3339(),
        points,
        stats: SessionStats::default(),
    };

    recompute_session_stats(&mut session);
    session
}

fn rand_suffix() -> u32 {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(12345);
    nanos ^ 0x5deece66
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_demo_track_generation() {
        let track = generate_demo_track(Some("Test Route".to_string()));
        assert_eq!(track.name, "Test Route");
        assert_eq!(track.points.len(), 95);
        assert!(track.stats.distance_km > 1.0);
        assert!(track.stats.max_speed_kmh > 40.0);
        assert!(track.stats.elevation_gain_m > 10.0);
    }
}
