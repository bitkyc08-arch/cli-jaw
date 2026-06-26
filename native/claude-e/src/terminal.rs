/// Respond to terminal capability queries that Claude Code's Ink UI emits.
/// Uses byte-level matching to avoid UTF-8 boundary issues on chunk splits.
pub fn answer_terminal_query(data: &[u8], cols: u16, rows: u16) -> Vec<Vec<u8>> {
    let mut responses = Vec::new();

    // DA1: ESC [ c  or  ESC [ 0 c
    if contains_bytes(data, b"\x1b[c") || contains_bytes(data, b"\x1b[0c") {
        responses.push(b"\x1b[?62;22c".to_vec());
    }

    // DA2: ESC [ > c  or  ESC [ > 0 c
    if contains_bytes(data, b"\x1b[>c") || contains_bytes(data, b"\x1b[>0c") {
        responses.push(b"\x1b[>1;1;0c".to_vec());
    }

    // DSR: ESC [ 6 n
    if contains_bytes(data, b"\x1b[6n") {
        responses.push(b"\x1b[1;1R".to_vec());
    }

    // XTVERSION: ESC [ > q
    if contains_bytes(data, b"\x1b[>q") {
        responses.push(b"\x1bP>|jaw-claude-i 0.1.0\x1b\\".to_vec());
    }

    // Window size: ESC [ 18 t
    if contains_bytes(data, b"\x1b[18t") {
        responses.push(format!("\x1b[8;{rows};{cols}t").into_bytes());
    }

    responses
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn da1_response() {
        let r = answer_terminal_query(b"\x1b[c", 120, 40);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0], b"\x1b[?62;22c");
    }

    #[test]
    fn window_size_response() {
        let r = answer_terminal_query(b"\x1b[18t", 120, 40);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0], b"\x1b[8;40;120t");
    }

    #[test]
    fn no_match() {
        let r = answer_terminal_query(b"hello world", 120, 40);
        assert!(r.is_empty());
    }

    #[test]
    fn multiple_queries_in_one_chunk() {
        let r = answer_terminal_query(b"\x1b[c\x1b[6n", 120, 40);
        assert_eq!(r.len(), 2);
    }
}
