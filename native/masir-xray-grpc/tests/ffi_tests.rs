use masir_xray_grpc::ffi::{xray_grpc_call, xray_grpc_last_error};
use masir_xray_grpc::errors::XrayError;

#[test]
fn test_null_pointers() {
    let mut out = [0u8; 100];
    let code = xray_grpc_call(
        std::ptr::null(),
        10,
        b"/test"[..].as_ptr(),
        5,
        b"{}"[..].as_ptr(),
        2,
        out.as_mut_ptr(),
        out.len(),
    );
    assert_eq!(code, XrayError::BadArgument.code());

    let mut err_buf = [0u8; 256];
    let err_len = xray_grpc_last_error(err_buf.as_mut_ptr(), err_buf.len());
    assert!(err_len > 0);
    let msg = std::str::from_utf8(&err_buf[..err_len as usize]).unwrap();
    assert!(msg.contains("null pointer"));
}

#[test]
fn test_unknown_method() {
    let mut out = [0u8; 100];
    let addr = b"127.0.0.1:10085";
    let method = b"/nonexistent.Service/NonexistentMethod";
    let req = b"{}";

    let code = xray_grpc_call(
        addr.as_ptr(),
        addr.len(),
        method.as_ptr(),
        method.len(),
        req.as_ptr(),
        req.len(),
        out.as_mut_ptr(),
        out.len(),
    );
    assert_eq!(code, XrayError::UnknownMethod.code());

    let mut err_buf = [0u8; 256];
    let err_len = xray_grpc_last_error(err_buf.as_mut_ptr(), err_buf.len());
    assert!(err_len > 0);
    let msg = std::str::from_utf8(&err_buf[..err_len as usize]).unwrap();
    assert!(msg.contains("not found in descriptor pool"));
}

#[test]
fn test_bad_json() {
    let mut out = [0u8; 100];
    let addr = b"127.0.0.1:10085";
    let method = b"/xray.app.stats.command.StatsService/GetSysStats";
    let req = b"{ invalid json ";

    let code = xray_grpc_call(
        addr.as_ptr(),
        addr.len(),
        method.as_ptr(),
        method.len(),
        req.as_ptr(),
        req.len(),
        out.as_mut_ptr(),
        out.len(),
    );
    assert_eq!(code, XrayError::BadJson.code());
}

#[test]
fn test_add_inbound_json_parsing() {
    let mut out = [0u8; 100];
    let addr = b"127.0.0.1:10085";
    let method = b"/xray.app.proxyman.command.HandlerService/AddInbound";
    let req = br#"{
        "inbound": {
            "tag": "socks",
            "receiverSettings": {
                "type": "xray.app.proxyman.ReceiverConfig",
                "value": {
                    "listen": { "domain": "127.0.0.1" },
                    "portList": { "range": [{ "From": 8181, "To": 8181 }] }
                }
            },
            "proxySettings": {
                "type": "xray.proxy.socks.ServerConfig",
                "value": {
                    "authType": "NO_AUTH",
                    "udpEnabled": true
                }
            }
        }
    }"#;

    let code = xray_grpc_call(
        addr.as_ptr(),
        addr.len(),
        method.as_ptr(),
        method.len(),
        req.as_ptr(),
        req.len(),
        out.as_mut_ptr(),
        out.len(),
    );
    let mut err_buf = [0u8; 512];
    let err_len = xray_grpc_last_error(err_buf.as_mut_ptr(), err_buf.len());
    let err_msg = std::str::from_utf8(&err_buf[..err_len as usize]).unwrap_or("");
    println!("FFI result: code={}, err={}", code, err_msg);
    assert_eq!(code, XrayError::Connect.code());
}

