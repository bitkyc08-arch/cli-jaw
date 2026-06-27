use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::panic;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::terminal;

pub struct PtyChild {
    pub child: Box<dyn portable_pty::Child + Send>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub last_change_us: Arc<AtomicU64>,
    pub stop: Arc<AtomicBool>,
    screen: Arc<Mutex<String>>,
    drain_handle: Option<thread::JoinHandle<()>>,
}

impl PtyChild {
    pub fn spawn(
        claude_bin: &str,
        args: &[String],
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
        stop: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("PTY open failed: {e}"))?;

        let mut cmd = CommandBuilder::new(claude_bin);
        cmd.args(args);
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Claude spawn failed: {e}"))?;

        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
            pair.master
                .take_writer()
                .map_err(|e| format!("PTY writer failed: {e}"))?,
        ));

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("PTY reader failed: {e}"))?;

        let last_change_us = Arc::new(AtomicU64::new(now_us()));
        let drain_last_change = Arc::clone(&last_change_us);
        let drain_stop = Arc::clone(&stop);
        let drain_writer = Arc::clone(&writer);
        let screen = Arc::new(Mutex::new(String::new()));
        let drain_screen = Arc::clone(&screen);

        let panic_stop = Arc::clone(&stop);
        let drain_handle = thread::spawn(move || {
            let result = panic::catch_unwind(panic::AssertUnwindSafe(|| {
                let mut buf = [0u8; 8192];
                let mut parser = vt100::Parser::new(rows, cols, 0);
                let mut prev_hash: u64 = 0;
                let mut total_bytes: u64 = 0;

                while !drain_stop.load(Ordering::Relaxed) {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = &buf[..n];
                            total_bytes += n as u64;
                            parser.process(chunk);

                            let responses = terminal::answer_terminal_query(chunk, cols, rows);
                            if !responses.is_empty() {
                                if let Ok(mut w) = drain_writer.lock() {
                                    for resp in responses {
                                        let _ = w.write_all(&resp);
                                    }
                                    let _ = w.flush();
                                }
                            }

                            // Reset parser periodically to bound memory (every 10MB)
                            if total_bytes > 10_000_000 {
                                parser = vt100::Parser::new(rows, cols, 0);
                                total_bytes = 0;
                                prev_hash = 0;
                            }

                            let screen = parser.screen();
                            let content = screen.contents();
                            let hash = simple_hash(&content);
                            if hash != prev_hash {
                                prev_hash = hash;
                                if let Ok(mut latest) = drain_screen.lock() {
                                    *latest = content;
                                }
                                drain_last_change.store(now_us(), Ordering::Relaxed);
                            }
                        }
                        Err(e) => {
                            log::debug!("PTY read error: {e}");
                            break;
                        }
                    }
                }
            }));
            if result.is_err() {
                log::error!("drain thread panicked — signaling stop");
                panic_stop.store(true, Ordering::Relaxed);
            }
        });

        Ok(Self {
            child,
            writer,
            last_change_us,
            stop,
            screen,
            drain_handle: Some(drain_handle),
        })
    }

    pub fn wait_quiescence(&self, quiesce_ms: u64) {
        loop {
            let last = self.last_change_us.load(Ordering::Relaxed);
            let elapsed = now_us().saturating_sub(last);
            if elapsed >= quiesce_ms * 1000 {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(50));
            if self.stop.load(Ordering::Relaxed) {
                break;
            }
        }
    }

    pub fn join_drain(&mut self) {
        if let Some(handle) = self.drain_handle.take() {
            let _ = handle.join();
        }
    }

    pub fn try_auto_accept_workspace_trust(&self) -> bool {
        let screen = self.screen_snapshot();
        if !looks_like_workspace_trust_prompt(&screen) {
            return false;
        }
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(b"1\r");
            let _ = w.flush();
            return true;
        }
        false
    }

    pub fn screen_snapshot(&self) -> String {
        self.screen.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

fn simple_hash(s: &str) -> u64 {
    let mut hash: u64 = 5381;
    for b in s.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(u64::from(b));
    }
    hash
}

fn looks_like_workspace_trust_prompt(screen: &str) -> bool {
    let lower = screen.to_lowercase();
    lower.contains("trust")
        && (lower.contains("workspace")
            || lower.contains("folder")
            || lower.contains("directory")
            || lower.contains("files"))
}

#[cfg(test)]
mod tests {
    use super::looks_like_workspace_trust_prompt;

    #[test]
    fn detects_workspace_trust_prompt() {
        assert!(looks_like_workspace_trust_prompt(
            "Do you trust the files in this folder?"
        ));
        assert!(looks_like_workspace_trust_prompt(
            "Trust this workspace before continuing"
        ));
    }

    #[test]
    fn ignores_regular_prompt() {
        assert!(!looks_like_workspace_trust_prompt("Welcome to Claude Code"));
    }
}
