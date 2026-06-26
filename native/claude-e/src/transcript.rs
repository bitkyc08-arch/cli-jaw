use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::normalize;

pub fn tail_transcript(
    transcript_path: &Path,
    stop: Arc<AtomicBool>,
    output_format: &str,
    initial_offset: u64,
) -> Result<Option<serde_json::Value>, String> {
    let mut file = wait_for_file(transcript_path, &stop, 20_000)?;
    let mut offset = clamped_initial_offset(&file, initial_offset);
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("failed to seek transcript to {offset}: {e}"))?;
    let mut last_assistant: Option<serde_json::Value> = None;

    loop {
        let reader = BufReader::new(&file);
        let mut any_line = false;

        for line in reader.lines() {
            match line {
                Ok(line) => {
                    let line_bytes = line.len() as u64 + 1; // +1 for newline

                    if line.trim().is_empty() {
                        offset += line_bytes;
                        any_line = true;
                        continue;
                    }

                    // Only advance offset if JSON parses — partial writes retry next poll
                    if serde_json::from_str::<serde_json::Value>(&line).is_err() {
                        log::debug!(
                            "transcript: incomplete JSON, will retry: {}...",
                            &line[..line.len().min(80)]
                        );
                        break;
                    }

                    any_line = true;
                    offset += line_bytes;

                    if let Some(normalized) = normalize::normalize_transcript_line(&line) {
                        emit_line(&normalized, output_format);

                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                            if v.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                                last_assistant = Some(v);
                            }
                        }
                    }
                }
                Err(e) => {
                    log::debug!("transcript read error: {e}");
                    break;
                }
            }
        }

        if stop.load(Ordering::Relaxed) {
            if any_line {
                // One more drain pass after stop signal
                std::thread::sleep(std::time::Duration::from_millis(300));
                if let Ok(mut f) = File::open(transcript_path) {
                    let _ = f.seek(SeekFrom::Start(offset));
                    let r = BufReader::new(f);
                    for line in r.lines().map_while(Result::ok) {
                        if let Some(normalized) = normalize::normalize_transcript_line(&line) {
                            emit_line(&normalized, output_format);
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                                if v.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                                    last_assistant = Some(v);
                                }
                            }
                        }
                    }
                }
            }
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(100));
        // Seek to current offset for next read pass
        let _ = file.seek(SeekFrom::Start(offset));
    }

    Ok(last_assistant)
}

pub fn current_file_len(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|metadata| metadata.len())
}

pub fn wait_for_prompt_activity_after_offset(
    transcript_path: &Path,
    initial_offset: u64,
    timeout_ms: u64,
    stop: &AtomicBool,
) -> Result<bool, String> {
    let mut file = wait_for_file(transcript_path, stop, timeout_ms)?;
    let mut offset = clamped_initial_offset(&file, initial_offset);
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("failed to seek transcript to {offset}: {e}"))?;

    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);

    loop {
        let reader = BufReader::new(&file);

        for line in reader.lines() {
            match line {
                Ok(line) => {
                    let line_bytes = line.len() as u64 + 1;
                    if line.trim().is_empty() {
                        offset += line_bytes;
                        continue;
                    }

                    let value = match serde_json::from_str::<serde_json::Value>(&line) {
                        Ok(value) => value,
                        Err(_) => break,
                    };

                    offset += line_bytes;
                    if is_prompt_acceptance_activity(&value) {
                        return Ok(true);
                    }
                }
                Err(e) => {
                    log::debug!("transcript verification read error: {e}");
                    break;
                }
            }
        }

        if stop.load(Ordering::Relaxed) {
            return Ok(false);
        }
        if start.elapsed() > timeout {
            return Ok(false);
        }

        std::thread::sleep(std::time::Duration::from_millis(100));
        let _ = file.seek(SeekFrom::Start(offset));
    }
}

fn is_prompt_acceptance_activity(value: &serde_json::Value) -> bool {
    matches!(
        value.get("type").and_then(|t| t.as_str()),
        Some("user" | "assistant")
    )
}

fn clamped_initial_offset(file: &File, requested_offset: u64) -> u64 {
    file.metadata()
        .map(|metadata| requested_offset.min(metadata.len()))
        .unwrap_or(0)
}

fn emit_line(normalized: &str, output_format: &str) {
    match output_format {
        "stream-json" => println!("{normalized}"),
        "json" => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(normalized) {
                let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if t == "assistant" || t == "result" {
                    println!("{normalized}");
                }
            }
        }
        "text" => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(normalized) {
                if v.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                    extract_and_print_text(&v);
                }
            }
        }
        _ => println!("{normalized}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn current_file_len_reports_existing_file_size() {
        let mut file = tempfile::NamedTempFile::new().expect("temp file");
        write!(file, "first\nsecond\n").expect("write fixture");

        assert_eq!(current_file_len(file.path()), Some(13));
    }

    #[test]
    fn clamped_initial_offset_caps_at_file_size() {
        let mut file = tempfile::NamedTempFile::new().expect("temp file");
        write!(file, "line\n").expect("write fixture");

        assert_eq!(clamped_initial_offset(file.as_file(), 2), 2);
        assert_eq!(clamped_initial_offset(file.as_file(), 999), 5);
    }

    #[test]
    fn wait_for_prompt_activity_after_offset_detects_user_after_offset() {
        let mut file = tempfile::NamedTempFile::new().expect("temp file");
        writeln!(
            file,
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"OLD_RESPONSE"}}]}}}}"#
        )
        .expect("write old assistant");
        let initial_offset = current_file_len(file.path()).expect("old offset");
        writeln!(
            file,
            r#"{{"type":"user","message":{{"role":"user","content":"NEW_PROMPT"}}}}"#
        )
        .expect("write new user");

        assert!(
            wait_for_prompt_activity_after_offset(
                file.path(),
                initial_offset,
                500,
                &AtomicBool::new(false),
            )
            .expect("wait for prompt activity")
        );
    }

    #[test]
    fn wait_for_prompt_activity_after_offset_ignores_user_before_offset() {
        let mut file = tempfile::NamedTempFile::new().expect("temp file");
        writeln!(
            file,
            r#"{{"type":"user","message":{{"role":"user","content":"OLD_PROMPT"}}}}"#
        )
        .expect("write old user");
        let initial_offset = current_file_len(file.path()).expect("old offset");

        assert!(
            !wait_for_prompt_activity_after_offset(
                file.path(),
                initial_offset,
                150,
                &AtomicBool::new(false),
            )
            .expect("wait for prompt activity")
        );
    }

    #[test]
    fn wait_for_prompt_activity_after_offset_accepts_assistant_after_offset() {
        let mut file = tempfile::NamedTempFile::new().expect("temp file");
        writeln!(
            file,
            r#"{{"type":"user","message":{{"role":"user","content":"OLD_PROMPT"}}}}"#
        )
        .expect("write old user");
        let initial_offset = current_file_len(file.path()).expect("old offset");
        writeln!(
            file,
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"NEW_RESPONSE"}}]}}}}"#
        )
        .expect("write new assistant");

        assert!(
            wait_for_prompt_activity_after_offset(
                file.path(),
                initial_offset,
                500,
                &AtomicBool::new(false),
            )
            .expect("wait for prompt activity")
        );
    }

    #[test]
    fn tail_transcript_skips_assistant_before_initial_offset() {
        let mut file = tempfile::NamedTempFile::new().expect("temp file");
        writeln!(
            file,
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"OLD_RESPONSE"}}],"model":"old-model"}},"sessionId":"sid-old"}}"#
        )
        .expect("write old assistant");
        let initial_offset = current_file_len(file.path()).expect("old offset");
        writeln!(
            file,
            r#"{{"type":"user","message":{{"role":"user","content":"NEW_PROMPT"}},"sessionId":"sid-new"}}"#
        )
        .expect("write new user");
        writeln!(
            file,
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"NEW_RESPONSE"}}],"model":"new-model"}},"sessionId":"sid-new"}}"#
        )
        .expect("write new assistant");

        let last_assistant = tail_transcript(
            file.path(),
            Arc::new(AtomicBool::new(true)),
            "json",
            initial_offset,
        )
        .expect("tail transcript")
        .expect("new assistant");

        assert_eq!(
            last_assistant["message"]["content"][0]["text"],
            "NEW_RESPONSE"
        );
        assert_eq!(last_assistant["sessionId"], "sid-new");
    }

    #[test]
    fn tail_transcript_skips_synthetic_no_response_placeholder() {
        let mut file = tempfile::NamedTempFile::new().expect("temp file");
        writeln!(
            file,
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"No response requested."}}],"model":"<synthetic>"}},"sessionId":"sid-new"}}"#
        )
        .expect("write placeholder assistant");
        writeln!(
            file,
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"REAL_RESPONSE"}}],"model":"claude-opus-4-7"}},"sessionId":"sid-new"}}"#
        )
        .expect("write real assistant");

        let last_assistant =
            tail_transcript(file.path(), Arc::new(AtomicBool::new(true)), "json", 0)
                .expect("tail transcript")
                .expect("real assistant");

        assert_eq!(
            last_assistant["message"]["content"][0]["text"],
            "REAL_RESPONSE"
        );
    }
}

fn wait_for_file(path: &Path, stop: &AtomicBool, timeout_ms: u64) -> Result<File, String> {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);

    loop {
        if let Ok(f) = File::open(path) {
            return Ok(f);
        }
        if start.elapsed() > timeout {
            return Err(format!(
                "transcript not found after {timeout_ms}ms: {}",
                path.display()
            ));
        }
        if stop.load(Ordering::Relaxed) {
            return Err("stopped before transcript appeared".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn extract_and_print_text(value: &serde_json::Value) {
    if let Some(message) = value.get("message") {
        if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
            for block in content {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                        print!("{text}");
                    }
                }
            }
        }
    }
}
