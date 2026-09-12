//! The state file the plugin reads to find the port this agent bound.
//!
//! The agent listens on a kernel-assigned loopback port, so the address is
//! knowable only from the machine itself. Publishing it here — atomically, so a
//! reader never sees a half-written file — is what lets the operator configure
//! a machine by its SSH destination and a token alone.
//!
//! The shape is part of the plugin's contract: it parses `version`, `port`, and
//! `pid` to decide whether the running agent is the expected build, and reads
//! `port` again to point the SSH forward at it. `startedAt` is diagnostic only.
//!
//! @module dsh-remote-agent/state

use serde_json::json;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::protocol::PROTOCOL_VERSION;

/// Build identity written into the state file.
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The state document one running agent publishes.
/// @param port - the loopback port the listener actually bound.
/// @param started_at - the instant the agent published it.
/// @returns the document.
pub fn document(port: u16, started_at: SystemTime) -> serde_json::Value {
    json!({
        "version": AGENT_VERSION,
        "protocol": PROTOCOL_VERSION,
        "pid": std::process::id(),
        "port": port,
        "startedAt": iso8601(started_at),
    })
}

/// Publish the bound address so the plugin can find it.
///
/// The bytes land on a private temp path in the same directory and are renamed
/// into place in one step, so a poller either sees the previous agent's state
/// or this one's, never a partial file.
/// @param path - where to publish the state.
/// @param port - the loopback port the listener actually bound.
/// @throws the underlying filesystem error.
pub fn write(path: &Path, port: u16) -> std::io::Result<()> {
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    std::fs::write(&temporary, document(port, SystemTime::now()).to_string())?;
    std::fs::rename(&temporary, path)
}

/// Render an instant as an ISO-8601 UTC timestamp.
/// @param time - the instant to render.
/// @returns the timestamp, e.g. `2026-01-01T00:00:00Z`.
pub fn iso8601(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64);
    let days = seconds.div_euclid(86_400);
    let remainder = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        remainder / 3600,
        (remainder % 3600) / 60,
        remainder % 60
    )
}

/// Convert a count of days since the Unix epoch into `(year, month, day)`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}
