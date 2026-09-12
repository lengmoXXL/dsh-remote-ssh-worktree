//! The remote agent, as a library the binary and its tests both drive.
//!
//! `main.rs` is only the command line around these modules: parse, bind,
//! publish the bound port, serve. Splitting them out is what lets the test
//! suite exercise the backends and the connection directly, the way the
//! TypeScript daemon's tests used to.
//!
//! @module dsh-remote-agent

pub mod execution;
pub mod failure;
pub mod fs;
pub mod git;
pub mod jsonrpc;
pub mod outbound;
pub mod protocol;
pub mod server;
pub mod state;
pub mod subprocess;
pub mod terminal;
pub mod wire;
