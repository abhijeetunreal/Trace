use crate::models::Session;
use parking_lot::RwLock;
use std::fs::{create_dir_all, File};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

pub struct StorageManager {
    file_path: PathBuf,
    cache: RwLock<Vec<Session>>,
}

impl StorageManager {
    /// Initialize storage manager with automatic platform path resolution
    pub fn new() -> Self {
        let base_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("TraceGPS");

        let _ = create_dir_all(&base_dir);
        let file_path = base_dir.join("sessions.json");

        let initial_sessions = Self::read_from_disk(&file_path);

        Self {
            file_path,
            cache: RwLock::new(initial_sessions),
        }
    }

    /// Custom path constructor (useful for testing)
    pub fn with_path(file_path: PathBuf) -> Self {
        if let Some(parent) = file_path.parent() {
            let _ = create_dir_all(parent);
        }
        let initial_sessions = Self::read_from_disk(&file_path);
        Self {
            file_path,
            cache: RwLock::new(initial_sessions),
        }
    }

    fn read_from_disk(path: &PathBuf) -> Vec<Session> {
        if !path.exists() {
            return Vec::new();
        }

        let mut file = match File::open(path) {
            Ok(f) => f,
            Err(_) => return Vec::new(),
        };

        let mut contents = String::new();
        if file.read_to_string(&mut contents).is_err() {
            return Vec::new();
        }

        serde_json::from_str(&contents).unwrap_or_default()
    }

    fn write_to_disk(&self) -> Result<(), String> {
        let list = self.cache.read();
        let json_str = serde_json::to_string_pretty(&*list).map_err(|e| e.to_string())?;

        if let Some(parent) = self.file_path.parent() {
            let _ = create_dir_all(parent);
        }

        let mut file = File::create(&self.file_path).map_err(|e| e.to_string())?;
        file.write_all(json_str.as_bytes()).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Retrieve all stored sessions in descending order (newest first)
    pub fn get_all(&self) -> Vec<Session> {
        self.cache.read().clone()
    }

    /// Prepend or update a session
    pub fn save(&self, session: Session) -> Result<(), String> {
        {
            let mut list = self.cache.write();
            if let Some(existing_idx) = list.iter().position(|s| s.id == session.id) {
                list[existing_idx] = session;
            } else {
                list.insert(0, session);
            }
        }
        self.write_to_disk()
    }

    /// Remove a session by unique ID
    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let removed = {
            let mut list = self.cache.write();
            let initial_len = list.len();
            list.retain(|s| s.id != id);
            list.len() < initial_len
        };

        if removed {
            self.write_to_disk()?;
        }
        Ok(removed)
    }
}

pub type SharedStorage = Arc<StorageManager>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SessionStats;
    use tempfile::tempdir;

    #[test]
    fn test_storage_lifecycle() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("test_sessions.json");
        let storage = StorageManager::with_path(file);

        assert_eq!(storage.get_all().len(), 0);

        let s1 = Session {
            id: "s1".to_string(),
            name: "Morning Run".to_string(),
            created_at: "2026-10-27T08:00:00Z".to_string(),
            points: vec![],
            stats: SessionStats::default(),
        };

        storage.save(s1.clone()).unwrap();
        let loaded = storage.get_all();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Morning Run");

        let deleted = storage.delete("s1").unwrap();
        assert!(deleted);
        assert_eq!(storage.get_all().len(), 0);
    }
}
