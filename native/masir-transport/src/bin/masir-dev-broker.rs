//! Dev-only transport broker.
//!
//! Binds the public socket exactly like the real helper, but forwards each
//! request to a TypeScript handler process (Node) over a second socket. The
//! broker is long-lived: restarting the handler on every TypeScript change does
//! not drop the public socket or the transport itself.
//!
//! ```text
//! masir request ──▶ [broker: MASIR_SOCKET] ──▶ [handler: MASIR_DEV_HANDLER] ──▶ handle()
//!                              (persistent)                     (tsx watch, reloadable)
//! ```

use masir_transport::platform::unix;
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);
const HANDLER_TIMEOUT: Duration = Duration::from_secs(30);

fn main() {
    unix::ignore_sigpipe();

    let public = unix::socket_path();
    let handler = env::var_os("MASIR_DEV_HANDLER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/masir-dev-handler.sock"));

    let listener = match unix::bind_listener(&public) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("masir-dev-broker: bind {}: {error}", public.display());
            std::process::exit(1);
        }
    };
    let _ = unix::apply_socket_owner(&public);

    eprintln!(
        "masir-dev-broker: public={} handler={}",
        public.display(),
        handler.display()
    );

    for stream in listener.incoming() {
        let Ok(client) = stream else { continue };
        let handler = handler.clone();
        let _ = std::thread::spawn(move || handle_client(client, &handler));
    }
}

fn handle_client(mut client: UnixStream, handler: &Path) {
    let _ = client.set_read_timeout(Some(CLIENT_TIMEOUT));
    let _ = client.set_write_timeout(Some(CLIENT_TIMEOUT));
    let peer_uid = unix::peer_uid(&client).unwrap_or(0);

    let Some(request) = read_line(&client) else {
        // EOF/timeout/oversize: mirror the real helper's bad-request reply.
        return;
    };
    if request.len() > unix::MAX_LINE || std::str::from_utf8(&request).is_err() {
        let _ = client.write_all(unix::BAD_REQUEST);
        let _ = client.write_all(b"\n");
        return;
    }

    let Ok(mut upstream) = UnixStream::connect(handler) else {
        return reply(&mut client, r#"{"ok":false,"error":"handler unavailable"}"#);
    };
    let _ = upstream.set_read_timeout(Some(HANDLER_TIMEOUT));
    let _ = upstream.set_write_timeout(Some(CLIENT_TIMEOUT));

    // Header line: peer uid, broker euid, broker pid. Then the request line.
    let header = format!(
        "{peer_uid} {} {}\n",
        unsafe { libc::geteuid() },
        std::process::id()
    );
    if upstream.write_all(header.as_bytes()).is_err()
        || upstream.write_all(&request).is_err()
        || upstream.write_all(b"\n").is_err()
        || upstream.flush().is_err()
    {
        return reply(&mut client, r#"{"ok":false,"error":"handler write failed"}"#);
    }

    match read_line(&upstream) {
        Some(response) => reply(&mut client, &String::from_utf8_lossy(&response)),
        None => reply(&mut client, r#"{"ok":false,"error":"handler unavailable"}"#),
    }
}

/// Read one newline-terminated line (cap `MAX_LINE`), stripping the terminator.
/// Returns `None` on EOF, timeout, I/O error, or an oversize line.
fn read_line(stream: &UnixStream) -> Option<Vec<u8>> {
    let mut reader = BufReader::new(stream.take((unix::MAX_LINE + 1) as u64));
    let mut buffer = Vec::new();
    match reader.read_until(b'\n', &mut buffer) {
        Ok(0) => None,
        Ok(_) => {
            if buffer.last() == Some(&b'\n') {
                buffer.pop();
                if buffer.last() == Some(&b'\r') {
                    buffer.pop();
                }
            }
            Some(buffer)
        }
        Err(_) => None,
    }
}

fn reply(client: &mut UnixStream, body: &str) {
    let _ = client.write_all(body.as_bytes());
    let _ = client.write_all(b"\n");
    let _ = client.flush();
}
