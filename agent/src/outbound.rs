//! The write half of one connection.
//!
//! Requests are served concurrently, so every response and pushed frame funnels
//! through one channel to one writer task; that task is what guarantees frames
//! reach the socket whole and in the order they were queued.
//!
//! @module dsh-remote-agent/outbound

use serde_json::Value;
use tokio::sync::mpsc;

use crate::failure::Result;
use crate::jsonrpc::{encode, error_response, notification, response};

/// One queued write, or the order to finish after everything already queued.
pub enum WriteCommand {
    /// One encoded JSON-RPC frame.
    Frame(Vec<u8>),
    /// Flush what is queued, close the socket, and stop the writer task.
    Shutdown,
}

/// A handle any part of a connection may write through.
#[derive(Clone)]
pub struct Outbound {
    sender: mpsc::Sender<WriteCommand>,
}

impl Outbound {
    /// Wrap one connection's writer channel.
    /// @param sender - the channel the connection's writer task drains.
    /// @returns the handle.
    pub fn new(sender: mpsc::Sender<WriteCommand>) -> Self {
        Self { sender }
    }

    /// Answer one request, waiting for room rather than dropping the answer.
    /// @param id - the request id being answered.
    /// @param outcome - the result or the failure to report.
    /// @returns true when the frame was queued.
    pub async fn respond(&self, id: &Value, outcome: Result<Value>) -> bool {
        let frame = match outcome {
            Ok(result) => response(id, &result),
            Err(failure) => error_response(id, &failure),
        };
        self.sender
            .send(WriteCommand::Frame(encode(&frame)))
            .await
            .is_ok()
    }

    /// Push one notification if the consumer is keeping up.
    ///
    /// A pushed stream is never allowed to grow the daemon's memory: a consumer
    /// that has stopped draining loses the frame, which is the signal the
    /// subprocess backend uses to abandon the stream.
    /// @param method - the notification method.
    /// @param params - the notification payload.
    /// @returns true when the frame was queued.
    pub fn try_notify(&self, method: &str, params: &Value) -> bool {
        self.sender
            .try_send(WriteCommand::Frame(encode(&notification(method, params))))
            .is_ok()
    }

    /// Ask the writer task to flush, close the socket, and stop.
    pub async fn shutdown(&self) {
        let _ = self.sender.send(WriteCommand::Shutdown).await;
    }
}
