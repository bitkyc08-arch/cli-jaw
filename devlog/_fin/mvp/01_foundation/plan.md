# MVP-1: Foundation

서버 스캐폴드 + DB + CLI 감지. 모든 후속 phase의 기반.

## 체크리스트

- [ ] `server.js` 기본 구조 (Express + WebSocket + SQLite)
- [ ] DB 스키마 생성:
  ```sql
  -- session singleton
  CREATE TABLE session (
      id TEXT PRIMARY KEY DEFAULT 'default',
      active_cli TEXT DEFAULT 'claude',
      session_id TEXT,
      model TEXT DEFAULT 'default',
      permissions TEXT DEFAULT 'auto',
      working_dir TEXT DEFAULT '~',
      effort TEXT DEFAULT 'medium',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO session (id) VALUES ('default');

  -- messages (단일 세션, chat_id 없음)
  CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      cli TEXT,
      model TEXT,
      cost_usd REAL,
      duration_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- memory (mock — 테이블만 생성, 로직은 Phase 후속)
  CREATE TABLE memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      source TEXT DEFAULT 'manual',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  ```
- [ ] CLI 감지 (`which claude`, `which codex`, `which gemini`)
- [ ] Settings 로드/저장 (`settings.json`)
- [ ] `/api/settings` GET/PUT
- [ ] `/api/session` GET (현재 상태)
- [ ] `/api/clear` POST (messages 삭제, memory 보존)
- [ ] `~/.cli-claw/prompts/` 디렉토리 자동 생성

## claw-lite에서 가져올 것

- `detectCli()`, `detectAllCli()`, `loadSettings()`, `saveSettings()`
- Express + WebSocket 기본 구조
- DB 초기화 패턴
