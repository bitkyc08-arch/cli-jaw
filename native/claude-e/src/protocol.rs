use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_seq() -> u64 {
    SEQ_COUNTER.fetch_add(1, Ordering::Relaxed)
}

#[derive(Serialize)]
pub struct RuntimeEvent {
    pub r#type: &'static str,
    pub event: String,
    pub run_id: String,
    pub seq: u64,
    pub ts: String,
    #[serde(flatten)]
    pub extra: serde_json::Value,
}

impl RuntimeEvent {
    pub fn new(event: &str, run_id: &str, extra: serde_json::Value) -> Self {
        Self {
            r#type: "jaw_runtime",
            event: event.to_string(),
            run_id: run_id.to_string(),
            seq: next_seq(),
            ts: chrono::Utc::now().to_rfc3339(),
            extra,
        }
    }
}

pub fn emit_runtime_event(event: &str, run_id: &str, extra: serde_json::Value) {
    let evt = RuntimeEvent::new(event, run_id, extra);
    if let Ok(json) = serde_json::to_string(&evt) {
        println!("{json}");
    }
}

pub fn emit_runtime_started(run_id: &str, version: &str) {
    emit_runtime_event(
        "runtime_started",
        run_id,
        serde_json::json!({ "v": 1, "helperVersion": version }),
    );
}

pub fn emit_claude_spawned(run_id: &str, pid: u32) {
    emit_runtime_event("claude_spawned", run_id, serde_json::json!({ "pid": pid }));
}

pub fn emit_session_started(run_id: &str, session_id: &str, transcript_path: &str) {
    emit_runtime_event(
        "session_started",
        run_id,
        serde_json::json!({ "sessionId": session_id, "transcriptPath": transcript_path }),
    );
}

pub fn emit_prompt_injected(run_id: &str) {
    emit_runtime_event("prompt_injected", run_id, serde_json::json!({}));
}

pub fn emit_stop_received(run_id: &str, transcript_path: &str) {
    emit_runtime_event(
        "stop_received",
        run_id,
        serde_json::json!({ "transcriptPath": transcript_path }),
    );
}

pub fn emit_stop_failure(run_id: &str, error: &str) {
    emit_runtime_event(
        "stop_failure",
        run_id,
        serde_json::json!({ "error": error }),
    );
}

pub fn emit_cleanup(run_id: &str, event: &str, escalated: bool) {
    emit_runtime_event(event, run_id, serde_json::json!({ "escalated": escalated }));
}

pub fn emit_interrupted(run_id: &str, session_id: &str) {
    emit_runtime_event(
        "interrupted",
        run_id,
        serde_json::json!({ "sessionId": session_id, "resumable": true }),
    );
}

pub fn emit_error(run_id: &str, message: &str, code: i32) {
    emit_runtime_event(
        "error",
        run_id,
        serde_json::json!({ "message": message, "exitCode": code }),
    );
}
