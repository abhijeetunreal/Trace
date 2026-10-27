use crate::models::{GpsPoint, RawLocationInput, Session, SessionStats};

const EARTH_RADIUS_KM: f64 = 6371.0;

/// Haversine great-circle distance between two GPS coordinates in kilometers
pub fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let r_lat1 = lat1.to_radians();
    let r_lat2 = lat2.to_radians();

    let a = (d_lat / 2.0).sin().powi(2) + r_lat1.cos() * r_lat2.cos() * (d_lon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).max(0.0).sqrt());

    EARTH_RADIUS_KM * c
}

/// Computes a new telemetry point and updates session statistics
pub fn calculate_point(
    prev: Option<&GpsPoint>,
    raw: RawLocationInput,
    stats: &mut SessionStats,
    points_count: usize,
    sum_speeds: f64,
) -> GpsPoint {
    let alt = raw.alt.unwrap_or(0.0);
    let acc = raw.acc.unwrap_or(4.0);
    let ts = raw.ts.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    let mut d_km = 0.0;
    let mut spd_kmh = raw.speed_ms.map(|s| s * 3.6).unwrap_or(0.0);
    let mut grade = 0.0;

    if let Some(prev_pt) = prev {
        d_km = haversine_km(prev_pt.lat, prev_pt.lon, raw.lat, raw.lon);
        let dt_sec = ((ts - prev_pt.ts) as f64 / 1000.0).max(0.1);

        if raw.speed_ms.is_none() {
            spd_kmh = d_km / (dt_sec / 3600.0);
        }

        let alt_diff = alt - prev_pt.alt;
        if alt_diff > 0.0 {
            stats.elevation_gain_m += alt_diff;
        }

        if d_km > 0.002 {
            let slope = (alt_diff / (d_km * 1000.0)) * 100.0;
            grade = slope.clamp(-40.0, 40.0);
        }
    }

    let total_dist = prev.map(|p| p.dist_km).unwrap_or(0.0) + d_km;

    let point = GpsPoint {
        lat: (raw.lat * 1_000_000.0).round() / 1_000_000.0,
        lon: (raw.lon * 1_000_000.0).round() / 1_000_000.0,
        alt: (alt * 10.0).round() / 10.0,
        speed: (spd_kmh * 10.0).round() / 10.0,
        acc: (acc * 10.0).round() / 10.0,
        grade: (grade * 10.0).round() / 10.0,
        ts,
        dist_km: (total_dist * 10_000.0).round() / 10_000.0,
    };

    // Update aggregate stats
    stats.distance_km = point.dist_km;
    if point.speed > stats.max_speed_kmh {
        stats.max_speed_kmh = point.speed;
    }
    match stats.min_alt_m {
        Some(min) if point.alt < min => stats.min_alt_m = Some(point.alt),
        None => stats.min_alt_m = Some(point.alt),
        _ => {}
    }
    match stats.max_alt_m {
        Some(max) if point.alt > max => stats.max_alt_m = Some(point.alt),
        None => stats.max_alt_m = Some(point.alt),
        _ => {}
    }

    let new_count = points_count + 1;
    let new_sum = sum_speeds + point.speed;
    stats.avg_speed_kmh = ((new_sum / new_count as f64) * 10.0).round() / 10.0;

    point
}

/// Recomputes complete statistics from an existing list of points
pub fn recompute_session_stats(session: &mut Session) {
    let mut stats = SessionStats::default();
    if session.points.is_empty() {
        session.stats = stats;
        return;
    }

    let mut dist = 0.0;
    let mut gain = 0.0;
    let mut max_speed: f64 = 0.0;
    let mut sum_speed = 0.0;
    let mut min_alt = session.points[0].alt;
    let mut max_alt = session.points[0].alt;

    for i in 0..session.points.len() {
        let p = &session.points[i];
        if p.speed > max_speed {
            max_speed = p.speed;
        }
        sum_speed += p.speed;
        if p.alt < min_alt {
            min_alt = p.alt;
        }
        if p.alt > max_alt {
            max_alt = p.alt;
        }

        if i > 0 {
            let prev = &session.points[i - 1];
            dist += haversine_km(prev.lat, prev.lon, p.lat, p.lon);
            let d_alt = p.alt - prev.alt;
            if d_alt > 0.0 {
                gain += d_alt;
            }
        }
    }

    let first_ts = session.points.first().map(|p| p.ts).unwrap_or(0);
    let last_ts = session.points.last().map(|p| p.ts).unwrap_or(0);
    let duration = (last_ts - first_ts).max(0);

    stats.distance_km = (dist * 100.0).round() / 100.0;
    stats.max_speed_kmh = (max_speed * 10.0).round() / 10.0;
    stats.avg_speed_kmh = ((sum_speed / session.points.len() as f64) * 10.0).round() / 10.0;
    stats.elevation_gain_m = gain.round();
    stats.min_alt_m = Some((min_alt * 10.0).round() / 10.0);
    stats.max_alt_m = Some((max_alt * 10.0).round() / 10.0);
    stats.duration_ms = duration;

    session.stats = stats;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_haversine_accuracy() {
        // Distance between London (51.5074, -0.1278) and Paris (48.8566, 2.3522)
        let d = haversine_km(51.5074, -0.1278, 48.8566, 2.3522);
        // Approximate distance is ~343 km
        assert!((d - 343.5).abs() < 2.0);
    }

    #[test]
    fn test_calculate_point_progression() {
        let mut stats = SessionStats::default();
        let p1 = calculate_point(
            None,
            RawLocationInput {
                lat: 46.5286,
                lon: 10.4531,
                alt: Some(2150.0),
                speed_ms: Some(10.0),
                acc: Some(3.0),
                ts: Some(1700000000000),
            },
            &mut stats,
            0,
            0.0,
        );

        assert_eq!(p1.dist_km, 0.0);
        assert_eq!(p1.speed, 36.0); // 10 m/s = 36 km/h
        assert_eq!(stats.elevation_gain_m, 0.0);

        let p2 = calculate_point(
            Some(&p1),
            RawLocationInput {
                lat: 46.5296,
                lon: 10.4541,
                alt: Some(2160.0),
                speed_ms: Some(12.0),
                acc: Some(2.5),
                ts: Some(1700000005000),
            },
            &mut stats,
            1,
            p1.speed,
        );

        assert!(p2.dist_km > 0.0);
        assert_eq!(p2.speed, 43.2); // 12 m/s = 43.2 km/h
        assert_eq!(stats.elevation_gain_m, 10.0);
        assert_eq!(stats.min_alt_m, Some(2150.0));
        assert_eq!(stats.max_alt_m, Some(2160.0));
    }
}
