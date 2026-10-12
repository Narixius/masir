//! Running processes for the app picker (`masir rules add --app`): pid,
//! parent pid, name and executable path, as JSON. Uses `sysinfo` rather than
//! shelling out to `ps`; processes whose executable can't be read (other
//! users' or protected ones) come back without `exe`.
//!
//!   masir_list_processes(out) -> bytes written | -2 (error) | -3 (buffer too small: retry bigger)

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::slice;

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

const ERROR: i32 = -2;
const BUFFER_TOO_SMALL: i32 = -3;

#[derive(Serialize)]
struct ProcessInfo {
    pid: u32,
    // Omitted rather than `null`: the TypeScript side types these as optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    ppid: Option<u32>,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exe: Option<String>,
}

fn list_processes() -> Vec<ProcessInfo> {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet));
    system
        .processes()
        .values()
        .map(|process| ProcessInfo {
            pid: process.pid().as_u32(),
            ppid: process.parent().map(|pid| pid.as_u32()),
            name: process.name().to_string_lossy().into_owned(),
            exe: process.exe().map(|path| path.to_string_lossy().into_owned()).filter(|path| !path.is_empty()),
        })
        .collect()
}

#[unsafe(no_mangle)]
pub extern "C" fn masir_list_processes(out: *mut u8, out_len: usize) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Ok(json) = serde_json::to_string(&list_processes()) else {
            return ERROR;
        };
        if out.is_null() || json.len() > out_len {
            return BUFFER_TOO_SMALL;
        }
        let dest = unsafe { slice::from_raw_parts_mut(out, out_len) };
        dest[..json.len()].copy_from_slice(json.as_bytes());
        json.len() as i32
    }))
    .unwrap_or(ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_this_process_with_its_executable() {
        let me = std::process::id();
        let processes = list_processes();
        let this = processes.iter().find(|p| p.pid == me).expect("own process listed");
        assert!(this.exe.is_some(), "own executable path readable");
        assert!(this.ppid.is_some());
    }
}
