use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::protocol;

/// Graceful exit: send /exit to PTY, wait for child, escalate if needed.
/// Used for SIGINT (Ctrl+C) — preserves session for resume.
pub fn graceful_exit(
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    child: &mut Box<dyn portable_pty::Child + Send>,
    pid: u32,
    run_id: &str,
) {
    protocol::emit_cleanup(run_id, "cleanup_started", false);

    // Send /exit to let Claude save session state
    if let Ok(mut w) = writer.lock() {
        let _ = w.write_all(b"/exit\r");
        let _ = w.flush();
    }

    // Wait for child to exit on its own (up to 5s)
    let grace = Duration::from_secs(5);
    let start = Instant::now();
    while start.elapsed() < grace {
        if let Ok(Some(_)) = child.try_wait() {
            protocol::emit_cleanup(run_id, "cleanup_done", false);
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // Child didn't exit — escalate
    kill_process_group(pid, run_id);
}

/// Hard kill: SIGTERM → grace → SIGKILL. Used for timeouts and errors.
pub fn kill_process_group(pid: u32, run_id: &str) {
    protocol::emit_cleanup(run_id, "cleanup_started", false);

    let Some(target_group) = process_group_id(pid) else {
        log::warn!("refusing to signal invalid child process group id: {pid}");
        protocol::emit_cleanup(run_id, "cleanup_done", true);
        return;
    };

    if kill(target_group, Signal::SIGTERM).is_ok() {
        log::debug!("sent SIGTERM to pgid -{pid}");
    }

    let grace = Duration::from_secs(3);
    let start = Instant::now();
    while start.elapsed() < grace {
        if kill(target_group, None).is_err() {
            protocol::emit_cleanup(run_id, "cleanup_done", false);
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    if kill(target_group, Signal::SIGKILL).is_ok() {
        log::debug!("sent SIGKILL to pgid -{pid}");
    }

    std::thread::sleep(Duration::from_millis(200));
    protocol::emit_cleanup(run_id, "cleanup_done", true);
}

fn process_group_id(pid: u32) -> Option<Pid> {
    let raw_pid = i32::try_from(pid).ok()?;
    if raw_pid == 0 {
        return None;
    }
    Some(Pid::from_raw(-raw_pid))
}

#[cfg(test)]
mod tests {
    use super::process_group_id;

    #[test]
    fn rejects_zero_process_group() {
        assert!(process_group_id(0).is_none());
    }

    #[test]
    fn negates_valid_process_group() {
        let target_group = process_group_id(1234).expect("valid pgid");
        assert_eq!(target_group.as_raw(), -1234);
    }
}
