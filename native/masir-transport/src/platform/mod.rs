//! Platform abstraction for the helper transport.
//!
//! The FFI layer ([`crate::ffi`]) is OS-agnostic and drives [`Current`]; each OS
//! module implements [`Platform`]. macOS and Linux share the Unix-domain-socket
//! transport in [`unix`]; Windows is a named-pipe stub.

use std::ffi::c_void;

/// Native callback invoked for each request line.
/// `(conn, peer_uid, req_ptr, req_len, ctx)`.
pub type OnRequest = unsafe extern "C" fn(u32, u32, *const u8, usize, *mut c_void);

/// Transport error codes. Mirrored in `src/main.ts::errorName`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum IpcError {
    /// Bad argument or malformed request.
    BadArgument = -1,
    /// Connect or I/O failure.
    Io = -2,
    /// Output buffer too small for the response.
    BufferTooSmall = -3,
    /// A panic crossed a native call; it was caught.
    Panic = -4,
    /// Client call timed out.
    Timeout = -5,
    /// `masir_reply` for a connection that is gone or already answered.
    UnknownConnection = -6,
    /// `masir_serve` called twice.
    AlreadyServing = -7,
    /// Bind/listen failed.
    BindFailed = -8,
}

impl IpcError {
    pub const fn code(self) -> i32 {
        self as i32
    }
}

pub trait Platform: Send + Sync + 'static {
    fn name(&self) -> &'static str;

    /// Bind + listen + spawn the accept loop. A second call returns
    /// [`IpcError::AlreadyServing`].
    fn serve(&self, cb: OnRequest, ctx: *mut c_void) -> Result<(), IpcError>;

    /// Write one response line and close the connection.
    fn reply(&self, conn: u32, response: &[u8]) -> Result<(), IpcError>;

    /// Blocking one-shot client call. Returns the number of response bytes
    /// written to `out` (excluding the trailing newline), or an error.
    fn call(&self, request: &[u8], out: &mut [u8]) -> Result<usize, IpcError>;

    /// Effective uid of the current process.
    fn euid(&self) -> u32;
}

#[cfg(unix)]
pub mod unix;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::MacOs as Current;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::Linux as Current;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::Windows as Current;