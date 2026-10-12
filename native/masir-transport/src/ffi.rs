//! C ABI exported to the scriptc TypeScript binary (`ffi_format` 6).
//!
//! Every exported function is a panic boundary: a panic must never unwind across
//! the FFI edge, so each body runs inside `catch_unwind` and reports
//! [`IpcError::Panic`] instead.

use crate::platform::{Current, IpcError, OnRequest, Platform};
use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::slice;

/// Run `body`, mapping a panic to the `PANIC` error code.
fn guarded<F: FnOnce() -> i32>(body: F) -> i32 {
    catch_unwind(AssertUnwindSafe(body)).unwrap_or(IpcError::Panic.code())
}

/// `int32_t masir_serve(on_request cb, void *ctx)`
#[unsafe(no_mangle)]
pub extern "C" fn masir_serve(cb: Option<OnRequest>, ctx: *mut c_void) -> i32 {
    guarded(|| match cb {
        Some(cb) => Current.serve(cb, ctx).map(|()| 0).unwrap_or_else(|e| e.code()),
        None => IpcError::BadArgument.code(),
    })
}

/// `int32_t masir_reply(uint32_t conn, const uint8_t *resp, size_t len)`
#[unsafe(no_mangle)]
pub extern "C" fn masir_reply(conn: u32, response: *const u8, response_len: usize) -> i32 {
    guarded(|| {
        if response.is_null() && response_len != 0 {
            return IpcError::BadArgument.code();
        }
        let bytes = if response_len == 0 {
            &[][..]
        } else {
            // Safety: the caller guarantees `response` is readable for
            // `response_len` bytes for the duration of this call.
            unsafe { slice::from_raw_parts(response, response_len) }
        };
        Current
            .reply(conn, bytes)
            .map(|()| 0)
            .unwrap_or_else(|e| e.code())
    })
}

/// `int32_t masir_call(const uint8_t *req, size_t req_len, uint8_t *out, size_t out_len)`
#[unsafe(no_mangle)]
pub extern "C" fn masir_call(
    request: *const u8,
    request_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    guarded(|| {
        if (request.is_null() && request_len != 0) || (out.is_null() && out_len != 0) {
            return IpcError::BadArgument.code();
        }
        let req = if request_len == 0 {
            &[][..]
        } else {
            unsafe { slice::from_raw_parts(request, request_len) }
        };
        let out = if out_len == 0 {
            &mut [][..]
        } else {
            // Safety: `mutable-bytes` is a writable borrow of the exact view.
            unsafe { slice::from_raw_parts_mut(out, out_len) }
        };
        match Current.call(req, out) {
            Ok(written) => written as i32,
            Err(e) => e.code(),
        }
    })
}

/// `uint32_t masir_euid(void)`
#[unsafe(no_mangle)]
pub extern "C" fn masir_euid() -> u32 {
    catch_unwind(AssertUnwindSafe(|| Current.euid())).unwrap_or(0)
}
