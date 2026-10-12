use crate::errors::XrayError;
use crate::service::execute_unary_call;
use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::slice;

thread_local! {
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

fn set_last_error(err: &str) {
    LAST_ERROR.with(|cell| {
        *cell.borrow_mut() = err.to_string();
    });
}

fn guarded<F: FnOnce() -> i32>(body: F) -> i32 {
    catch_unwind(AssertUnwindSafe(body)).unwrap_or_else(|_| {
        set_last_error("panic occurred in native xray_grpc call");
        XrayError::Panic.code()
    })
}

/// Unary gRPC call.
///
/// # Safety
/// - `addr` must point to `addr_len` readable bytes (or null if len == 0).
/// - `method` must point to `method_len` readable bytes.
/// - `req_json` must point to `req_json_len` readable bytes.
/// - `out` must point to `out_len` writable bytes.
#[unsafe(no_mangle)]
pub extern "C" fn xray_grpc_call(
    addr: *const u8,
    addr_len: usize,
    method: *const u8,
    method_len: usize,
    req_json: *const u8,
    req_json_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    guarded(|| {
        if (addr.is_null() && addr_len != 0)
            || (method.is_null() && method_len != 0)
            || (req_json.is_null() && req_json_len != 0)
            || (out.is_null() && out_len != 0)
        {
            set_last_error("null pointer passed with non-zero length");
            return XrayError::BadArgument.code();
        }

        let addr_str = if addr_len == 0 {
            ""
        } else {
            // Safety: checked non-null and valid for addr_len bytes
            let s = unsafe { slice::from_raw_parts(addr, addr_len) };
            match std::str::from_utf8(s) {
                Ok(v) => v,
                Err(e) => {
                    set_last_error(&format!("addr is not valid utf-8: {e}"));
                    return XrayError::BadArgument.code();
                }
            }
        };

        let method_str = if method_len == 0 {
            ""
        } else {
            // Safety: checked non-null and valid for method_len bytes
            let s = unsafe { slice::from_raw_parts(method, method_len) };
            match std::str::from_utf8(s) {
                Ok(v) => v,
                Err(e) => {
                    set_last_error(&format!("method is not valid utf-8: {e}"));
                    return XrayError::BadArgument.code();
                }
            }
        };

        let req_json_str = if req_json_len == 0 {
            ""
        } else {
            // Safety: checked non-null and valid for req_json_len bytes
            let s = unsafe { slice::from_raw_parts(req_json, req_json_len) };
            match std::str::from_utf8(s) {
                Ok(v) => v,
                Err(e) => {
                    set_last_error(&format!("req_json is not valid utf-8: {e}"));
                    return XrayError::BadArgument.code();
                }
            }
        };

        let out_slice = if out_len == 0 {
            &mut [][..]
        } else {
            // Safety: checked non-null and valid for out_len writable bytes
            unsafe { slice::from_raw_parts_mut(out, out_len) }
        };

        match execute_unary_call(addr_str, method_str, req_json_str) {
            Ok(json_res) => {
                let bytes = json_res.as_bytes();
                if bytes.len() > out_slice.len() {
                    set_last_error(&format!("buffer too small: required {}", bytes.len()));
                    return XrayError::BufferTooSmall.code();
                }
                out_slice[..bytes.len()].copy_from_slice(bytes);
                bytes.len() as i32
            }
            Err((err, msg)) => {
                set_last_error(&msg);
                err.code()
            }
        }
    })
}

/// Copies the last error message for the calling thread into `out`.
///
/// # Safety
/// `out` must point to `out_len` writable bytes.
#[unsafe(no_mangle)]
pub extern "C" fn xray_grpc_last_error(out: *mut u8, out_len: usize) -> i32 {
    guarded(|| {
        if out.is_null() && out_len != 0 {
            return XrayError::BadArgument.code();
        }
        let out_slice = if out_len == 0 {
            &mut [][..]
        } else {
            // Safety: checked non-null and valid for out_len writable bytes
            unsafe { slice::from_raw_parts_mut(out, out_len) }
        };

        LAST_ERROR.with(|cell| {
            let err = cell.borrow();
            let bytes = err.as_bytes();
            if bytes.len() > out_slice.len() {
                return XrayError::BufferTooSmall.code();
            }
            out_slice[..bytes.len()].copy_from_slice(bytes);
            bytes.len() as i32
        })
    })
}
