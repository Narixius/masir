//! Native transport shim for the masir privileged helper.
//!
//! The exported C ABI lives in [`ffi`]; the OS-specific transport lives behind
//! the [`platform`] trait. There is no request logic here — TypeScript owns it.

pub mod ffi;
pub mod platform;