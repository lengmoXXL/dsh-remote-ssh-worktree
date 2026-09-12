//! The state file the plugin reads to find the agent's port.

mod common;

use common::TempDir;
use dsh_remote_agent::protocol::PROTOCOL_VERSION;
use dsh_remote_agent::state;
use std::time::{Duration, UNIX_EPOCH};

#[test]
fn publishes_the_keys_the_plugin_reads() {
    let fixture = TempDir::new("drw-state");
    let path = fixture.join("state.json");
    state::write(&path, 41_234).unwrap();

    let document: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    // The plugin decides reuse from these three and points the forward at the
    // fourth; a rename here would silently strand every connection.
    assert_eq!(document["version"], state::AGENT_VERSION);
    assert_eq!(document["protocol"], PROTOCOL_VERSION);
    assert_eq!(document["pid"], std::process::id());
    assert_eq!(document["port"], 41_234);
    let started = document["startedAt"].as_str().expect("startedAt");
    assert_eq!(started.len(), "1970-01-01T00:00:00Z".len());
    assert!(started.ends_with('Z'));
}

#[test]
fn creates_missing_directories_and_replaces_the_previous_state() {
    let fixture = TempDir::new("drw-state-nested");
    let path = fixture.join("nested/deeper/state.json");
    state::write(&path, 1).unwrap();
    state::write(&path, 2).unwrap();

    let document: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(document["port"], 2);

    // The publication is a rename, so no temp file survives it.
    let leftovers: Vec<String> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "left behind {leftovers:?}");
}

#[test]
fn renders_known_instants_as_iso8601() {
    assert_eq!(state::iso8601(UNIX_EPOCH), "1970-01-01T00:00:00Z");
    assert_eq!(
        state::iso8601(UNIX_EPOCH + Duration::from_secs(1_767_225_600)),
        "2026-01-01T00:00:00Z"
    );
}
