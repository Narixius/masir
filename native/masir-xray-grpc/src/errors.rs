//! Error codes for the Xray gRPC FFI interface.
//!
//! Codes are negative and disjoint from `masir-transport`'s codes (-1 through -8).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum XrayError {
    /// Bad argument or invalid input pointer/length.
    BadArgument = -101,
    /// Output buffer provided by the caller is too small.
    BufferTooSmall = -102,
    /// Connection or transport error reaching the gRPC endpoint.
    Connect = -103,
    /// Call timed out.
    Timeout = -104,
    /// gRPC non-OK status returned by the server.
    GrpcStatus = -105,
    /// The requested service or method name was not found in the descriptor pool.
    UnknownMethod = -106,
    /// JSON parsing or serialization failed.
    BadJson = -107,
    /// A panic occurred during the call and was caught at the boundary.
    Panic = -108,
}

impl XrayError {
    pub const fn code(self) -> i32 {
        self as i32
    }
}
