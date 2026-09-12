//! The process primitives both execution backends share.

mod common;

use common::TempDir;
use dsh_remote_agent::execution::{scrubbed_environment, usable_directory, StreamBuffer};

#[test]
fn reads_are_views_of_one_window_rather_than_consuming_it() {
    let buffer = StreamBuffer::new(64);
    buffer.push(b"abc");
    buffer.push(b"def");

    let (bytes, next, lossy) = buffer.read(0);
    assert_eq!(bytes, b"abcdef");
    assert_eq!(next, 6);
    assert!(!lossy);

    let (again, ..) = buffer.read(0);
    assert_eq!(again, b"abcdef", "a second reader sees the same bytes");
    let (tail, next, lossy) = buffer.read(3);
    assert_eq!(tail, b"def");
    assert_eq!(next, 6);
    assert!(!lossy);
}

#[test]
fn keeps_only_the_tail_and_tells_a_reader_when_its_offset_is_gone() {
    let buffer = StreamBuffer::new(4);
    buffer.push(b"abc");
    buffer.push(b"def");

    let (bytes, next, lossy) = buffer.read(0);
    assert_eq!(bytes, b"cdef");
    assert_eq!(next, 6);
    assert!(lossy, "an offset before the retained tail is reported lost");

    let (bytes, next, lossy) = buffer.read(6);
    assert!(bytes.is_empty());
    assert_eq!(next, 6);
    assert!(!lossy);
}

#[test]
fn the_environment_is_scrubbed_of_secrets_and_harness_names() {
    std::env::set_var("DRW_TEST_SECRET_TOKEN", "leak");
    std::env::set_var("DRW_TEST_PASSWORD", "leak");
    std::env::set_var("DSH_TEST_RESERVED", "leak");
    std::env::set_var("DRW_TEST_ORDINARY", "keep");

    let environment = scrubbed_environment();
    let find = |key: &str| {
        environment
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };
    assert_eq!(find("DRW_TEST_SECRET_TOKEN"), None);
    assert_eq!(find("DRW_TEST_PASSWORD"), None);
    assert_eq!(find("DSH_TEST_RESERVED"), None);
    assert_eq!(find("DRW_TEST_ORDINARY"), Some("keep".to_string()));
    assert!(find("PATH").is_some(), "an ordinary variable survives");
}

#[test]
fn a_working_directory_must_be_an_absolute_existing_directory() {
    let fixture = TempDir::new("drw-exec-cwd");
    std::fs::create_dir(fixture.join("real")).unwrap();
    std::os::unix::fs::symlink(fixture.join("real"), fixture.join("link")).unwrap();

    let resolved =
        usable_directory(fixture.join("link").to_str().unwrap(), "SP_SPAWN_FAILED").unwrap();
    assert_eq!(resolved, fixture.join("real"));

    assert_eq!(
        usable_directory("relative", "SP_SPAWN_FAILED")
            .unwrap_err()
            .code,
        "SP_SPAWN_FAILED"
    );
    let file = fixture.join("file.txt");
    std::fs::write(&file, "x").unwrap();
    assert!(usable_directory(file.to_str().unwrap(), "SP_SPAWN_FAILED").is_err());
}
