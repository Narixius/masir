use super::{IpcError, OnRequest, Platform, unix};
use std::ffi::c_void;

pub struct Linux;

impl Platform for Linux {
    fn name(&self) -> &'static str {
        "linux"
    }

    fn serve(&self, cb: OnRequest, ctx: *mut c_void) -> Result<(), IpcError> {
        unix::serve(cb, ctx)
    }

    fn reply(&self, conn: u32, response: &[u8]) -> Result<(), IpcError> {
        unix::reply(conn, response)
    }

    fn call(&self, request: &[u8], out: &mut [u8]) -> Result<usize, IpcError> {
        unix::call(request, out)
    }

    fn euid(&self) -> u32 {
        unix::euid()
    }
}
