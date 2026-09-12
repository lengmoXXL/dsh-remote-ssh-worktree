//! JSON-RPC 2.0 framing over a line-delimited header block.
//!
//! The plugin speaks the LSP-style framing `vscode-jsonrpc` implements: a
//! `Content-Length` header block terminated by a blank line, then exactly that
//! many bytes of UTF-8 JSON. Nothing here validates the protocol semantics —
//! that is `wire.rs` and `server.rs`.
//!
//! @module dsh-remote-agent/jsonrpc

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};

use crate::failure::Failure;

/// Frame one JSON value the way the plugin's reader expects it.
/// @param value - the message to frame.
/// @returns the bytes to write.
pub fn encode(value: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(&body);
    frame
}

/// Read one framed message.
/// @param reader - the connection's buffered reader.
/// @returns the message, or `None` at a clean end of stream.
/// @throws when the stream ends mid-message or the frame is malformed.
pub async fn read_message<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<Value>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = Vec::new();
        if reader.read_until(b'\n', &mut line).await? == 0 {
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&line);
        let header = text.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let Some(length) = content_length else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "message carried no usable Content-Length header",
        ));
    };
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    serde_json::from_slice(&body).map(Some).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("malformed JSON body: {error}"),
        )
    })
}

/// Build a successful response.
/// @param id - the request id being answered.
/// @param result - the method result.
/// @returns the message.
pub fn response(id: &Value, result: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Build a failure response carrying the protocol's own error data.
/// @param id - the request id being answered.
/// @param failure - the failure to report.
/// @returns the message.
pub fn error_response(id: &Value, failure: &Failure) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": failure.rpc_code,
            "message": failure.message,
            "data": { "code": failure.code, "message": failure.message },
        },
    })
}

/// Build a notification.
/// @param method - the notification method.
/// @param params - the notification payload.
/// @returns the message.
pub fn notification(method: &str, params: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}
