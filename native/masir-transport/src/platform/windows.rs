//! Windows transport stub.
//!
//! TODO: implement named pipes (`CreateNamedPipeW` / `ConnectNamedPipe`) behind
//! the same C ABI and connection table. The [`Platform`] trait shape already
//! permits it; only this module needs to change.

use super::{IpcError, OnRequest, Platform};
use std::ffi::c_void;

pub struct Windows;

impl Platform for Windows {
    fn name(&self) -> &'static str {
        "windows"
    }

    fn serve(&self, _cb: OnRequest, _ctx: *mut c_void) -> Result<(), IpcError> {
        Err(IpcError::Io)
    }

    fn reply(&self, _conn: u32, _response: &[u8]) -> Result<(), IpcError> {
        Err(IpcError::UnknownConnection)
    }

    fn call(&self, _request: &[u8], _out: &mut [u8]) -> Result<usize, IpcError> {
        Err(IpcError::Io)
    }

    fn euid(&self) -> u32 {
        0
    }
}
