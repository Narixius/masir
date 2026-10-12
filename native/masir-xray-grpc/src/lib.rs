//! Native Xray gRPC client FFI layer.
//!
//! Provides JSON-in / JSON-out RPC execution to an Xray-core gRPC server over HTTP/2.

pub mod codec;
pub mod errors;
pub mod ffi;
pub mod service;

pub use errors::XrayError;
pub use ffi::*;
