use serde_json::Value;

const NO_RESPONSE_PLACEHOLDER: &str = "No response requested.";

/// Filter and normalize interactive transcript JSONL lines into Claude SDK-compatible events.
/// Returns Some(normalized_json_string) if the line should be emitted, None if it should be discarded.
pub fn normalize_transcript_line(line: &str) -> Option<String> {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            log::debug!(
                "transcript JSON parse failed: {e} — line: {}...",
                &line[..line.len().min(100)]
            );
            return None;
        }
    };
    let record_type = value.get("type")?.as_str()?;

    match record_type {
        // Discard internal records
        "queue-operation" | "attachment" | "last-prompt" => None,

        // Normalize assistant message
        "assistant" => normalize_assistant(&value),

        // Normalize user message
        "user" => normalize_user(&value),

        // Pass through any other recognized stream-json event types
        "system" | "result" | "stream_event" | "rate_limit_event" => Some(line.to_string()),

        // Unknown: discard with debug log
        other => {
            log::debug!("discarding unknown transcript record type: {other}");
            None
        }
    }
}

fn normalize_assistant(value: &Value) -> Option<String> {
    let message = value.get("message")?;
    if is_no_response_placeholder(message) {
        return None;
    }

    let mut output = serde_json::json!({
        "type": "assistant",
        "message": message,
    });

    if let Some(sid) = value.get("sessionId").or_else(|| value.get("session_id")) {
        output["session_id"] = sid.clone();
    }

    serde_json::to_string(&output).ok()
}

fn is_no_response_placeholder(message: &Value) -> bool {
    if message.get("model").and_then(|m| m.as_str()) != Some("<synthetic>") {
        return false;
    }

    let Some(content) = message.get("content").and_then(|c| c.as_array()) else {
        return false;
    };

    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(|t| t.as_str()) != Some("text") {
            return false;
        }
        text.push_str(block.get("text").and_then(|t| t.as_str()).unwrap_or(""));
    }

    text.trim() == NO_RESPONSE_PLACEHOLDER
}

fn normalize_user(value: &Value) -> Option<String> {
    let message = value.get("message")?;
    if is_local_command_user(message) {
        return None;
    }

    let mut output = serde_json::json!({
        "type": "user",
        "message": message,
    });

    if let Some(sid) = value.get("sessionId").or_else(|| value.get("session_id")) {
        output["session_id"] = sid.clone();
    }

    serde_json::to_string(&output).ok()
}

fn is_local_command_user(message: &Value) -> bool {
    let Some(content) = message.get("content").and_then(|c| c.as_str()) else {
        return false;
    };

    content.contains("<local-command-caveat>")
        || content.contains("<command-name>/exit</command-name>")
        || content.contains("<local-command-stdout>")
}

/// Synthesize a result event from the final assistant message.
pub fn synthesize_result(last_assistant: &Value) -> Option<String> {
    let message = last_assistant.get("message")?;
    let usage = message
        .get("usage")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let model = message.get("model").cloned().unwrap_or(Value::Null);
    let session_id = last_assistant
        .get("sessionId")
        .or_else(|| last_assistant.get("session_id"))
        .cloned()
        .unwrap_or(Value::Null);

    let result = serde_json::json!({
        "type": "result",
        "result": "success",
        "session_id": session_id,
        "model": model,
        "usage": usage,
    });

    serde_json::to_string(&result).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discard_queue_operation() {
        let line = r#"{"type":"queue-operation","operation":"enqueue"}"#;
        assert!(normalize_transcript_line(line).is_none());
    }

    #[test]
    fn discard_attachment() {
        let line = r#"{"type":"attachment","attachment":{"type":"deferred_tools_delta"}}"#;
        assert!(normalize_transcript_line(line).is_none());
    }

    #[test]
    fn normalize_assistant_message() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"model":"claude-sonnet-4-6"},"sessionId":"abc-123"}"#;
        let result = normalize_transcript_line(line).expect("should emit");
        let parsed: Value = serde_json::from_str(&result).expect("valid json");
        assert_eq!(parsed["type"], "assistant");
        assert_eq!(parsed["session_id"], "abc-123");
    }

    #[test]
    fn discard_synthetic_no_response_placeholder() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"No response requested."}],"model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}},"sessionId":"abc-123"}"#;
        assert!(normalize_transcript_line(line).is_none());
    }

    #[test]
    fn keep_real_no_response_text() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"No response requested."}],"model":"claude-opus-4-7"},"sessionId":"abc-123"}"#;
        assert!(normalize_transcript_line(line).is_some());
    }

    #[test]
    fn normalize_user_message() {
        let line =
            r#"{"type":"user","message":{"role":"user","content":"hello"},"sessionId":"abc-123"}"#;
        let result = normalize_transcript_line(line).expect("should emit");
        let parsed: Value = serde_json::from_str(&result).expect("valid json");
        assert_eq!(parsed["type"], "user");
    }

    #[test]
    fn discard_local_command_user_records() {
        let line = r#"{"type":"user","message":{"role":"user","content":"<command-name>/exit</command-name>\n<command-message>exit</command-message>"},"sessionId":"abc-123"}"#;
        assert!(normalize_transcript_line(line).is_none());
    }

    #[test]
    fn passthrough_system() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc"}"#;
        let result = normalize_transcript_line(line).expect("should emit");
        assert_eq!(result, line);
    }

    #[test]
    fn passthrough_rate_limit_event() {
        let line = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"}}"#;
        let result = normalize_transcript_line(line).expect("should emit");
        assert_eq!(result, line);
    }

    #[test]
    fn synthesize_result_event() {
        let assistant = serde_json::json!({
            "type": "assistant",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "hello"}], "model": "claude-sonnet-4-6", "usage": {"input_tokens": 100, "output_tokens": 50}},
            "sessionId": "abc-123"
        });
        let result = synthesize_result(&assistant).expect("should synthesize");
        let parsed: Value = serde_json::from_str(&result).expect("valid json");
        assert_eq!(parsed["type"], "result");
        assert_eq!(parsed["session_id"], "abc-123");
    }
}
