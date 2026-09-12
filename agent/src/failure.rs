//! The typed failures every backend reports.
//!
//! A failure carries two things: a stable code the plugin rethrows unchanged,
//! and a human-readable message it logs but never parses. The JSON-RPC code is
//! separate because a malformed request, an unknown method, and a backend fault
//! are distinguishable to a generic client even though they all arrive as one.
//!
//! @module dsh-remote-agent/failure

/// JSON-RPC code for a request that is not valid JSON-RPC.
pub const INVALID_REQUEST: i64 = -32600;
/// JSON-RPC code for a method this build does not serve.
pub const METHOD_NOT_FOUND: i64 = -32601;
/// JSON-RPC code for parameters that do not match the method.
pub const INVALID_PARAMS: i64 = -32602;
/// JSON-RPC code for a backend fault.
pub const INTERNAL_ERROR: i64 = -32603;

/// A failure carrying the protocol's own stable code.
#[derive(Debug, Clone)]
pub struct Failure {
    /// The wire code the plugin rethrows unchanged.
    pub code: &'static str,
    /// Human-readable detail the plugin logs but does not parse.
    pub message: String,
    /// The JSON-RPC code the response carries.
    pub rpc_code: i64,
}

impl Failure {
    /// Build a backend failure, which reports as an internal error.
    /// @param code - the protocol's stable code.
    /// @param message - human-readable detail.
    /// @returns the failure.
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            rpc_code: INTERNAL_ERROR,
        }
    }

    /// Build a malformed-parameter failure for one method.
    /// @param method - the method being served.
    /// @param detail - what is wrong with the parameters.
    /// @returns the failure.
    pub fn invalid_params(method: &str, detail: impl AsRef<str>) -> Self {
        let message = format!("{method}: {}", detail.as_ref());
        Self {
            code: "FS_IO_ERROR",
            message,
            rpc_code: INVALID_PARAMS,
        }
    }

    /// Build the failure an unknown method reports.
    /// @param method - the method the client named.
    /// @returns the failure.
    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: "FS_IO_ERROR",
            message: format!("unknown method \"{method}\""),
            rpc_code: METHOD_NOT_FOUND,
        }
    }
}

/// The result every backend method returns.
pub type Result<T> = std::result::Result<T, Failure>;
