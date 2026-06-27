/// Sanitize a prompt before PTY injection.
/// Returns Err with reason if the prompt cannot be safely injected.
pub fn sanitize_prompt(prompt: &str) -> Result<String, String> {
    if prompt.is_empty() {
        return Err("prompt is empty".to_string());
    }

    let mut sanitized = String::with_capacity(prompt.len());

    for ch in prompt.chars() {
        match ch {
            '\x00' => return Err("prompt contains NUL byte".to_string()),
            '\x03' => return Err("prompt contains Ctrl-C".to_string()),
            '\x04' => return Err("prompt contains Ctrl-D".to_string()),
            '\x1a' => return Err("prompt contains Ctrl-Z".to_string()),
            '\x1b' => {
                // Skip escape sequences — don't inject terminal controls
                log::warn!("stripping ESC byte from prompt");
            }
            _ => sanitized.push(ch),
        }
    }

    if sanitized.is_empty() {
        return Err("prompt is empty after sanitization".to_string());
    }

    Ok(sanitized)
}

/// Wrap prompt in bracketed paste mode for safe multiline injection.
/// Returns (paste_bytes, submit_bytes) — caller should send submit after a short delay.
pub fn bracketed_paste(prompt: &str) -> (Vec<u8>, Vec<u8>) {
    let mut paste = Vec::with_capacity(prompt.len() + 20);
    paste.extend_from_slice(b"\x1b[200~");
    paste.extend_from_slice(prompt.as_bytes());
    paste.extend_from_slice(b"\x1b[201~");
    (paste, b"\r".to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_rejected() {
        assert!(sanitize_prompt("").is_err());
    }

    #[test]
    fn nul_rejected() {
        assert!(sanitize_prompt("hello\x00world").is_err());
    }

    #[test]
    fn ctrl_c_rejected() {
        assert!(sanitize_prompt("hello\x03world").is_err());
    }

    #[test]
    fn normal_passes() {
        assert_eq!(sanitize_prompt("hello world").expect("ok"), "hello world");
    }

    #[test]
    fn multiline_passes() {
        let prompt = "line 1\nline 2\nline 3";
        assert_eq!(sanitize_prompt(prompt).expect("ok"), prompt);
    }

    #[test]
    fn esc_stripped() {
        let result = sanitize_prompt("hello\x1b[31mworld").expect("ok");
        assert_eq!(result, "hello[31mworld");
    }

    #[test]
    fn bracketed_paste_wraps() {
        let (paste, submit) = bracketed_paste("hello");
        assert!(paste.starts_with(b"\x1b[200~"));
        assert!(paste.ends_with(b"\x1b[201~"));
        assert_eq!(submit, b"\r");
    }
}
