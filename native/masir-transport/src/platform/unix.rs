//! Shared Unix-domain-socket transport for macOS and Linux.
//!
//! One thread per connection: read exactly one newline-terminated request line
//! (64 KiB cap), hand it to the scriptc foreign callback, and keep the write
//! half in a connection table until `masir_reply` runs or a reaper times out.

use super::{IpcError, OnRequest};
use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex, Once};
use std::time::{Duration, Instant};

/// Maximum request/response line, excluding the trailing newline.
pub const MAX_LINE: usize = 64 * 1024;
/// How long the helper waits for a request line after accept.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the helper waits for TypeScript to call `masir_reply`.
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the client waits for a response.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);

pub const BAD_REQUEST: &[u8] = br#"{"ok":false,"error":"bad request"}"#;

struct Conn {
    /// `None` only transiently while a reaper/reply is taking it out.
    stream: Option<UnixStream>,
    /// When the reply deadline passes, the sweeper drops (and closes) this.
    deadline: Instant,
}

static SERVING: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static CONNS: LazyLock<Mutex<HashMap<u32, Conn>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static IGNORE_SIGPIPE: Once = Once::new();

/// Where a daemon running as root listens. Root cannot use a per-user path
/// (`TMPDIR`/`HOME` differ under sudo), so clients look here as well.
pub const SYSTEM_SOCKET: &str = "/var/run/masir.sock";

/// Per-user socket for a daemon running as a normal user: `$XDG_RUNTIME_DIR/masir.sock`,
/// else (macOS, where `$TMPDIR` is already per-user) `$TMPDIR/masir-<uid>.sock`,
/// else `/tmp/masir-<uid>/masir.sock` inside a private directory (see [`bind_listener`]).
fn user_socket_path() -> PathBuf {
    let uid = unsafe { libc::geteuid() };
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir).join("masir.sock");
    }
    if cfg!(target_os = "macos") {
        if let Some(dir) = std::env::var_os("TMPDIR").filter(|d| !d.is_empty()) {
            return PathBuf::from(dir).join(format!("masir-{uid}.sock"));
        }
    }
    PathBuf::from(format!("/tmp/masir-{uid}/masir.sock"))
}

/// Where this process's daemon listens: `MASIR_SOCKET`, else the system socket
/// when running as root, else the per-user socket.
pub fn socket_path() -> PathBuf {
    if let Some(path) = std::env::var_os("MASIR_SOCKET") {
        return PathBuf::from(path);
    }
    if unsafe { libc::geteuid() } == 0 {
        PathBuf::from(SYSTEM_SOCKET)
    } else {
        user_socket_path()
    }
}

/// Sockets a client tries, in order: the user's own daemon, then a root one.
pub fn client_socket_paths() -> Vec<PathBuf> {
    if let Some(path) = std::env::var_os("MASIR_SOCKET") {
        return vec![PathBuf::from(path)];
    }
    vec![user_socket_path(), PathBuf::from(SYSTEM_SOCKET)]
}

/// Ignore `SIGPIPE` process-wide. A Rust static library linked into a non-Rust
/// program never runs Rust's startup code, so the default disposition is still
/// "terminate" and a client that disconnects early could kill the helper.
pub fn ignore_sigpipe() {
    IGNORE_SIGPIPE.call_once(|| unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    });
}

pub fn serve(cb: OnRequest, ctx: *mut c_void) -> Result<(), IpcError> {
    if SERVING.swap(true, Ordering::SeqCst) {
        return Err(IpcError::AlreadyServing);
    }
    ignore_sigpipe();

    let path = socket_path();
    let listener = match bind_listener(&path) {
        Ok(listener) => listener,
        Err(_) => {
            SERVING.store(false, Ordering::SeqCst);
            return Err(IpcError::BindFailed);
        }
    };
    let _ = apply_socket_owner(&path);

    let ctx_addr = ctx as usize;
    std::thread::Builder::new()
        .name("masir-accept".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let _ = std::thread::Builder::new()
                    .name("masir-conn".into())
                    .stack_size(128 * 1024)
                    .spawn(move || handle_connection(stream, cb, ctx_addr));
            }
        })
        .map_err(|_| IpcError::BindFailed)?;

    // One sweeper for the whole process: drops connections whose reply deadline
    // passed. This keeps the daemon from starting a timer thread per request.
    std::thread::Builder::new()
        .name("masir-reaper".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_secs(1));
            let now = Instant::now();
            if let Ok(mut table) = CONNS.lock() {
                table.retain(|_, conn| conn.deadline > now);
            }
        })
        .map_err(|_| IpcError::BindFailed)?;
    Ok(())
}

pub fn reply(conn: u32, response: &[u8]) -> Result<(), IpcError> {
    let mut table = CONNS.lock().map_err(|_| IpcError::Panic)?;
    let Some(mut entry) = table.remove(&conn) else {
        return Err(IpcError::UnknownConnection);
    };
    drop(table);

    let Some(mut stream) = entry.stream.take() else {
        return Err(IpcError::UnknownConnection);
    };
    stream.write_all(response).map_err(|_| IpcError::Io)?;
    stream.write_all(b"\n").map_err(|_| IpcError::Io)?;
    stream.flush().map_err(|_| IpcError::Io)?;
    Ok(())
}

pub fn call(request: &[u8], out: &mut [u8]) -> Result<usize, IpcError> {
    ignore_sigpipe();

    // A stale socket file fails to connect, so just move on to the next candidate.
    let mut stream = client_socket_paths()
        .iter()
        .find_map(|path| UnixStream::connect(path).ok())
        .ok_or(IpcError::Io)?;
    let _ = stream.set_read_timeout(Some(CLIENT_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CLIENT_TIMEOUT));

    stream.write_all(request).map_err(|_| IpcError::Io)?;
    stream.write_all(b"\n").map_err(|_| IpcError::Io)?;
    stream.flush().map_err(|_| IpcError::Io)?;

    let mut reader = BufReader::new((&stream).take((MAX_LINE + 1) as u64));
    let mut buffer = Vec::new();
    match reader.read_until(b'\n', &mut buffer) {
        Ok(0) => return Err(IpcError::Io),
        Ok(_) => {}
        Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
            return Err(IpcError::Timeout);
        }
        Err(_) => return Err(IpcError::Io),
    }
    drop(reader);

    if buffer.last() == Some(&b'\n') {
        buffer.pop();
    }
    if buffer.last() == Some(&b'\r') {
        buffer.pop();
    }
    if buffer.len() > MAX_LINE || buffer.len() > out.len() {
        return Err(IpcError::BufferTooSmall);
    }
    out[..buffer.len()].copy_from_slice(&buffer);
    Ok(buffer.len())
}

pub fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

/// Bind the listener, creating a private (0700) parent directory if needed.
///
/// An existing parent must resolve to a directory owned by us or root, so
/// another local user cannot pre-create `/tmp/masir-<uid>` (or a symlink to
/// their own directory) and have us bind inside it. Symlinks are followed
/// because `/tmp` itself is one on macOS; it is the *target's* owner that counts.
pub fn bind_listener(path: &Path) -> std::io::Result<UnixListener> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(parent)?;
        verify_parent(parent)?;
    }
    let _ = std::fs::remove_file(path);
    UnixListener::bind(path)
}

fn verify_parent(parent: &Path) -> std::io::Result<()> {
    let meta = std::fs::metadata(parent)?;
    let euid = unsafe { libc::geteuid() };
    if meta.is_dir() && (meta.uid() == euid || meta.uid() == 0) {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("refusing socket directory {}: not a directory owned by us or root", parent.display()),
        ))
    }
}

/// The user a root daemon serves: `MASIR_ALLOWED_UID` (set by the installed
/// service), else `SUDO_UID` (set by `sudo`).
fn allowed_uid() -> Option<u32> {
    ["MASIR_ALLOWED_UID", "SUDO_UID"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .find_map(|value| value.parse::<u32>().ok())
        .filter(|uid| *uid != 0)
}

/// Owner-only (0600). A root daemon hands the socket to the user it serves so
/// they can use the CLI without `sudo`; without a known user it stays root-only.
pub fn apply_socket_owner(path: &Path) -> std::io::Result<()> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    if unsafe { libc::geteuid() } == 0 {
        if let Some(uid) = allowed_uid() {
            std::os::unix::fs::chown(path, Some(uid), None)?;
        }
    }
    Ok(())
}

fn handle_connection(stream: UnixStream, cb: OnRequest, ctx_addr: usize) {
    // The thread body is a panic boundary: a panic here must not unwind into
    // the connection or the process.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let peer_uid = peer_uid(&stream).unwrap_or(0);
        let _ = stream.set_read_timeout(Some(REQUEST_TIMEOUT));
        let _ = stream.set_write_timeout(Some(REQUEST_TIMEOUT));

        let mut reader = BufReader::new((&stream).take((MAX_LINE + 1) as u64));
        let mut buffer = Vec::new();
        match reader.read_until(b'\n', &mut buffer) {
            // Client closed (or sent nothing and went away): close silently.
            Ok(0) => return,
            Ok(_) => {}
            // Idle timeout or I/O error: close by timeout, no response line.
            Err(_) => return,
        }
        drop(reader);

        // Strip the terminator first so a line of exactly MAX_LINE content
        // bytes (MAX_LINE + 1 with the newline) is not misjudged as oversize.
        let terminated = buffer.last() == Some(&b'\n');
        if terminated {
            buffer.pop();
            if buffer.last() == Some(&b'\r') {
                buffer.pop();
            }
        }
        if buffer.len() > MAX_LINE || std::str::from_utf8(&buffer).is_err() {
            return write_and_close(stream, BAD_REQUEST);
        }

        let conn = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        {
            let Ok(mut table) = CONNS.lock() else { return };
            table.insert(
                conn,
                Conn {
                    stream: Some(stream),
                    deadline: Instant::now() + REPLY_TIMEOUT,
                },
            );
        }

        // Fire and forget: the scriptc trampoline posts to the event loop and
        // returns immediately. The buffer is borrowed only for this call.
        unsafe { cb(conn, peer_uid, buffer.as_ptr(), buffer.len(), ctx_addr as *mut c_void) };
    }));
}

fn write_and_close(mut stream: UnixStream, bytes: &[u8]) {
    let _ = stream.write_all(bytes);
    let _ = stream.write_all(b"\n");
    let _ = stream.flush();
    // `stream` drops here, closing the connection.
}

#[cfg(target_os = "macos")]
pub fn peer_uid(stream: &UnixStream) -> std::io::Result<u32> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    let rc = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    if rc == 0 {
        Ok(uid)
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
pub fn peer_uid(stream: &UnixStream) -> std::io::Result<u32> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut c_void,
            &mut len,
        )
    };
    if rc == 0 {
        Ok(cred.uid)
    } else {
        Err(std::io::Error::last_os_error())
    }
}
