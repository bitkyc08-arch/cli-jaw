mod args;
mod child;
mod cleanup;
mod config;
mod hook;
mod normalize;
mod protocol;
mod sanitize;
mod terminal;
mod transcript;

use clap::Parser;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use args::{Cli, Command};
use config::RunConfig;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const PROMPT_ACCEPTANCE_TIMEOUT_MS: u64 = 8_000;

fn main() {
    env_logger::init();
    let cli = Cli::parse();

    match cli.command {
        Command::Run {
            jsonl: _,
            output_format,
            timeout_ms,
            claude_bin,
            cwd,
            cols,
            rows,
            resume,
            auto_accept_workspace_trust,
            extra_args,
        } => {
            let config = RunConfig::new(
                claude_bin,
                cwd,
                cols,
                rows,
                timeout_ms,
                output_format,
                resume,
                auto_accept_workspace_trust,
                extra_args,
            );
            let exit_code = run(&config);
            std::process::exit(exit_code);
        }
    }
}

fn run(config: &RunConfig) -> i32 {
    protocol::emit_runtime_started(&config.run_id, VERSION);

    // Read prompt from stdin
    let prompt = match read_prompt() {
        Ok(p) => p,
        Err(e) => {
            protocol::emit_error(&config.run_id, &e, 16);
            return 16;
        }
    };

    // Sanitize prompt
    let prompt = match sanitize::sanitize_prompt(&prompt) {
        Ok(p) => p,
        Err(e) => {
            protocol::emit_error(&config.run_id, &format!("prompt rejected: {e}"), 16);
            return 16;
        }
    };

    // Create hook directory with atomic sentinel relay
    let hook_dir = match hook::HookDir::create() {
        Ok(hd) => hd,
        Err(e) => {
            protocol::emit_error(&config.run_id, &e, 13);
            return 13;
        }
    };

    // Build claude args
    let claude_args = build_claude_args(config, &hook_dir);

    // Set up signal handling
    let stop = Arc::new(AtomicBool::new(false));
    let stop_signal = Arc::clone(&stop);
    if let Err(e) =
        signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&stop_signal))
    {
        log::warn!("SIGTERM handler registration failed: {e}");
    }
    if let Err(e) =
        signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&stop_signal))
    {
        log::warn!("SIGINT handler registration failed: {e}");
    }

    // Spawn Claude in PTY
    let mut pty_child = match child::PtyChild::spawn(
        &config.claude_bin,
        &claude_args,
        &config.cwd,
        config.cols,
        config.rows,
        Arc::clone(&stop),
    ) {
        Ok(c) => c,
        Err(e) => {
            protocol::emit_error(&config.run_id, &e, 4);
            return 4;
        }
    };

    let child_pid = pty_child.child.process_id().unwrap_or(0);
    protocol::emit_claude_spawned(&config.run_id, child_pid);

    // Wait for SessionStart hook (also check for early child exit / resume failure)
    {
        let sentinel = hook_dir.sentinel_path("session-start");
        let start_wait = std::time::Instant::now();
        let timeout = std::time::Duration::from_millis(20_000);
        let mut trust_accept_attempted = false;
        loop {
            if sentinel.exists() {
                break;
            }
            if config.auto_accept_trust
                && !trust_accept_attempted
                && pty_child.try_auto_accept_workspace_trust()
            {
                trust_accept_attempted = true;
            }
            if let Ok(Some(status)) = pty_child.child.try_wait() {
                let code = if status.success() { 0 } else { 1 };
                protocol::emit_error(
                    &config.run_id,
                    &format!("Claude exited before SessionStart (exit {})", code),
                    5,
                );
                return 5;
            }
            if start_wait.elapsed() > timeout {
                let screen = compact_screen_snapshot(&pty_child.screen_snapshot());
                let message = if screen.is_empty() {
                    "SessionStart timeout after 20s".to_string()
                } else {
                    format!("SessionStart timeout after 20s; screen: {screen}")
                };
                protocol::emit_error(&config.run_id, &message, 5);
                cleanup::kill_process_group(child_pid, &config.run_id);
                return 5;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    // Extract session info from SessionStart payload
    let session_payload = hook_dir.read_payload("session-start").unwrap_or_default();
    let transcript_path = hook::extract_transcript_path(&session_payload).unwrap_or_default();
    let session_id =
        hook::extract_session_id(&session_payload).unwrap_or_else(|| config.session_id.clone());

    protocol::emit_session_started(&config.run_id, &session_id, &transcript_path);
    let transcript_path_buf = PathBuf::from(&transcript_path);
    let transcript_start_offset = if transcript_path.is_empty() {
        0
    } else {
        transcript::current_file_len(&transcript_path_buf).unwrap_or(0)
    };

    // Wait for PTY quiescence before injecting prompt
    pty_child.wait_quiescence(500);

    // Inject prompt via bracketed paste, then submit after a short delay
    let (paste_bytes, submit_bytes) = sanitize::bracketed_paste(&prompt);
    {
        let Ok(mut w) = pty_child.writer.lock() else {
            protocol::emit_error(
                &config.run_id,
                "PTY writer lock poisoned before prompt write",
                4,
            );
            cleanup::kill_process_group(child_pid, &config.run_id);
            return 4;
        };
        if let Err(e) = w.write_all(&paste_bytes) {
            protocol::emit_error(&config.run_id, &format!("prompt write failed: {e}"), 4);
            cleanup::kill_process_group(child_pid, &config.run_id);
            return 4;
        }
        let _ = w.flush();
    }
    // Brief delay so TUI processes the paste before receiving Enter
    std::thread::sleep(std::time::Duration::from_millis(150));
    {
        let Ok(mut w) = pty_child.writer.lock() else {
            protocol::emit_error(
                &config.run_id,
                "PTY writer lock poisoned before submit write",
                4,
            );
            cleanup::kill_process_group(child_pid, &config.run_id);
            return 4;
        };
        if let Err(e) = w.write_all(&submit_bytes) {
            protocol::emit_error(&config.run_id, &format!("submit write failed: {e}"), 4);
            cleanup::kill_process_group(child_pid, &config.run_id);
            return 4;
        }
        let _ = w.flush();
    }
    protocol::emit_prompt_injected(&config.run_id);

    if transcript_path.is_empty() {
        protocol::emit_error(
            &config.run_id,
            "prompt injection cannot be verified: SessionStart did not provide a transcript path",
            7,
        );
        cleanup::kill_process_group(child_pid, &config.run_id);
        pty_child.join_drain();
        return 7;
    }

    match transcript::wait_for_prompt_activity_after_offset(
        &transcript_path_buf,
        transcript_start_offset,
        PROMPT_ACCEPTANCE_TIMEOUT_MS,
        stop.as_ref(),
    ) {
        Ok(true) => {}
        Ok(false) => {
            protocol::emit_error(
                &config.run_id,
                &format!(
                    "prompt injection did not reach Claude transcript after {PROMPT_ACCEPTANCE_TIMEOUT_MS}ms"
                ),
                7,
            );
            cleanup::kill_process_group(child_pid, &config.run_id);
            pty_child.join_drain();
            return 7;
        }
        Err(e) => {
            protocol::emit_error(
                &config.run_id,
                &format!("prompt injection transcript verification failed: {e}"),
                7,
            );
            cleanup::kill_process_group(child_pid, &config.run_id);
            pty_child.join_drain();
            return 7;
        }
    }

    // Start transcript tailing in a thread
    let transcript_stop = Arc::clone(&stop);
    let output_format = config.output_format.clone();
    let transcript_handle = std::thread::spawn(move || {
        transcript::tail_transcript(
            &transcript_path_buf,
            transcript_stop,
            &output_format,
            transcript_start_offset,
        )
    });

    // Wait for Stop/StopFailure or child exit
    let exit_code = wait_for_completion(config, &hook_dir, &mut pty_child, child_pid, &session_id);

    // Signal transcript thread to finalize
    stop.store(true, Ordering::Relaxed);

    // Wait for transcript thread
    if let Ok(Ok(Some(last_assistant))) = transcript_handle.join() {
        if let Some(result_json) = normalize::synthesize_result(&last_assistant) {
            if config.output_format == "stream-json" || config.output_format == "json" {
                println!("{result_json}");
            }
        }
    }

    // Cleanup
    pty_child.join_drain();

    // Brief delay before TempDir drop — ensures hook relay scripts finish writing
    std::thread::sleep(std::time::Duration::from_millis(200));
    drop(hook_dir);

    exit_code
}

fn wait_for_completion(
    config: &RunConfig,
    hook_dir: &hook::HookDir,
    pty_child: &mut child::PtyChild,
    child_pid: u32,
    session_id: &str,
) -> i32 {
    let timeout = std::time::Duration::from_millis(config.timeout_ms);
    let start = std::time::Instant::now();

    loop {
        // Check signals (SIGINT/SIGTERM → graceful exit, preserving session)
        if pty_child.stop.load(Ordering::Relaxed) {
            protocol::emit_interrupted(&config.run_id, session_id);
            cleanup::graceful_exit(
                &pty_child.writer,
                &mut pty_child.child,
                child_pid,
                &config.run_id,
            );
            return 2;
        }

        // Check Stop sentinel (normal completion)
        if hook_dir.sentinel_path("stop").exists() {
            let payload = hook_dir.read_payload("stop").unwrap_or_default();
            let tp = hook::extract_transcript_path(&payload).unwrap_or_default();
            protocol::emit_stop_received(&config.run_id, &tp);

            wait_transcript_stable(&hook_dir.sentinel_path("stop"), 1000);

            cleanup::graceful_exit(
                &pty_child.writer,
                &mut pty_child.child,
                child_pid,
                &config.run_id,
            );
            return 0;
        }

        // Check StopFailure sentinel
        if hook_dir.sentinel_path("stop-failure").exists() {
            let payload = hook_dir.read_payload("stop-failure").unwrap_or_default();
            let error = payload
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("unknown StopFailure");
            protocol::emit_stop_failure(&config.run_id, error);
            cleanup::graceful_exit(
                &pty_child.writer,
                &mut pty_child.child,
                child_pid,
                &config.run_id,
            );
            return 11;
        }

        // Check child exit — grace period to let sentinels finalize
        if let Ok(Some(status)) = pty_child.child.try_wait() {
            log::debug!("child exited with status: {:?}", status);
            std::thread::sleep(std::time::Duration::from_millis(300));

            // Re-check sentinels after child exit (Stop hook may have fired concurrently)
            if hook_dir.sentinel_path("stop").exists() {
                let payload = hook_dir.read_payload("stop").unwrap_or_default();
                let tp = hook::extract_transcript_path(&payload).unwrap_or_default();
                protocol::emit_stop_received(&config.run_id, &tp);
                return 0;
            }
            if hook_dir.sentinel_path("stop-failure").exists() {
                let payload = hook_dir.read_payload("stop-failure").unwrap_or_default();
                let error = payload
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown StopFailure");
                protocol::emit_stop_failure(&config.run_id, error);
                return 11;
            }

            return if status.success() { 0 } else { 1 };
        }

        // Timeout
        if start.elapsed() > timeout {
            protocol::emit_error(&config.run_id, "timeout waiting for completion", 6);
            cleanup::kill_process_group(child_pid, &config.run_id);
            return 6;
        }

        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn wait_transcript_stable(sentinel_path: &std::path::Path, stable_ms: u64) {
    // Wait until sentinel file mtime is stable for stable_ms
    let start = std::time::Instant::now();
    let max_wait = std::time::Duration::from_millis(stable_ms * 3);

    while start.elapsed() < max_wait {
        if let Ok(meta) = std::fs::metadata(sentinel_path) {
            if let Ok(modified) = meta.modified() {
                let age = modified.elapsed().unwrap_or_default();
                if age >= std::time::Duration::from_millis(stable_ms) {
                    return;
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn compact_screen_snapshot(screen: &str) -> String {
    let compact = screen
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
    compact.chars().take(800).collect()
}

const MAX_PROMPT_BYTES: usize = 10 * 1024 * 1024; // 10MB

fn read_prompt() -> Result<String, String> {
    let mut prompt = String::new();
    std::io::stdin()
        .take((MAX_PROMPT_BYTES + 1) as u64)
        .read_to_string(&mut prompt)
        .map_err(|e| format!("stdin read failed: {e}"))?;

    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(format!(
            "prompt too large ({} bytes, max {})",
            prompt.len(),
            MAX_PROMPT_BYTES
        ));
    }

    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return Err("prompt stdin is empty".to_string());
    }

    Ok(trimmed.to_string())
}

fn build_claude_args(config: &RunConfig, hook_dir: &hook::HookDir) -> Vec<String> {
    let mut args = Vec::new();

    if config.is_resume() {
        if let Some(ref session_id) = config.resume_session {
            args.push("--resume".to_string());
            args.push(session_id.clone());
        }
    } else {
        args.push("--session-id".to_string());
        args.push(config.session_id.clone());
    }

    args.push("--settings".to_string());
    args.push(hook_dir.build_settings_json());

    // Forward extra args
    args.extend(config.extra_args.iter().cloned());

    args
}
