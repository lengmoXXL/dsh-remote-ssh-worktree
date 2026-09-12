//! Fixtures the agent's integration tests share.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Monotonic suffix so concurrent tests never share a directory.
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A directory that removes itself when the test ends.
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// Create one uniquely named directory under the system temp root.
    ///
    /// The path is canonicalized because on macOS a temp directory is reached
    /// through a symlinked `/var`, and every path the daemon answers with is
    /// canonical; expectations must compare canonical to canonical.
    /// @param prefix - a short label for the directory name.
    /// @returns the fixture.
    pub fn new(prefix: &str) -> Self {
        let raw = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&raw).expect("create temp dir");
        Self {
            path: std::fs::canonicalize(&raw).expect("canonicalize temp dir"),
        }
    }

    /// The directory's canonical path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// One entry inside the directory.
    /// @param name - the entry's name.
    /// @returns its path.
    pub fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
