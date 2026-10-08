//! Capped raw-frame log. Lives on tmpfs (RAM), so no flash wear; when the
//! file passes `max` bytes it is renamed to `<name>.1`, replacing the old one.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

pub struct RawLog {
    path: PathBuf,
    max: u64,
    file: Option<File>,
    size: u64,
}

impl RawLog {
    pub fn open(path: PathBuf, max: u64) -> RawLog {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let file = OpenOptions::new().create(true).append(true).open(&path).ok();
        RawLog { path, max, file, size }
    }

    pub fn line(&mut self, s: &str) {
        if self.size + s.len() as u64 + 1 > self.max {
            self.file = None;
            let mut old = self.path.clone().into_os_string();
            old.push(".1");
            let _ = fs::rename(&self.path, PathBuf::from(old));
            self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
            self.size = 0;
        }
        if let Some(f) = self.file.as_mut() {
            if f.write_all(s.as_bytes()).and_then(|_| f.write_all(b"\n")).is_ok() {
                self.size += s.len() as u64 + 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_and_stays_capped() {
        let dir = std::env::temp_dir().join(format!("stick-gw-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let p = dir.join("frames.jsonl");
        let mut l = RawLog::open(p.clone(), 100);
        for i in 0..50 {
            l.line(&format!("{{\"n\":{i}}}......"));
        }
        let a = fs::metadata(&p).unwrap().len();
        let b = fs::metadata(dir.join("frames.jsonl.1")).unwrap().len();
        assert!(a <= 100 && b <= 100 && a > 0 && b > 0);
        fs::remove_dir_all(&dir).unwrap();
    }
}
