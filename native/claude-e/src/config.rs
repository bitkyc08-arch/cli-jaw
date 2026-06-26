use std::path::PathBuf;
use uuid::Uuid;

pub struct RunConfig {
    pub run_id: String,
    pub session_id: String,
    pub claude_bin: String,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub timeout_ms: u64,
    pub output_format: String,
    pub resume_session: Option<String>,
    pub auto_accept_trust: bool,
    pub extra_args: Vec<String>,
}

impl RunConfig {
    pub fn new(
        claude_bin: String,
        cwd: Option<PathBuf>,
        cols: u16,
        rows: u16,
        timeout_ms: u64,
        output_format: String,
        resume: Option<String>,
        auto_accept_trust: bool,
        extra_args: Vec<String>,
    ) -> Self {
        let session_id = if resume.is_some() {
            String::new()
        } else {
            Uuid::new_v4().to_string()
        };

        Self {
            run_id: format!("run_{}", &Uuid::new_v4().to_string()[..8]),
            session_id,
            claude_bin,
            cwd: cwd
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
            cols,
            rows,
            timeout_ms,
            output_format,
            resume_session: resume,
            auto_accept_trust,
            extra_args,
        }
    }

    pub fn is_resume(&self) -> bool {
        self.resume_session.is_some()
    }
}
