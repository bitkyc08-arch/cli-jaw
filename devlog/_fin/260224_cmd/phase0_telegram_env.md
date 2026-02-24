# (fin) Phase 0: 텔레그램 환경변수 전환

> 날짜: 2026-02-24  
> 범위: `settings.json`, `src/telegram.js`, `.env`, `.env.example`

---

## 배경

`settings.json`에 텔레그램 봇 토큰이 하드코딩되어 있었음. Git 리포에 시크릿이 노출되는 구조였으므로 `.env` 기반으로 전환.

## 변경 내역

### 1. 토큰 제거 (`settings.json`)
- 프로젝트 `settings.json` + 런타임 `~/.cli-claw/settings.json` 양쪽에서 토큰 값을 `""` 로 비움
- `telegram.enabled` → `false` (기본 비활성)

### 2. `.env` 생성
- `.gitignore`에 이미 `.env` 포함 확인 완료
- 실제 토큰을 `.env`에 `TELEGRAM_TOKEN=...` 형태로 이관

### 3. env 로딩 강화 (`src/telegram.js`)
- 기존: `TELEGRAM_TOKEN` env → settings overwrite만 존재
- 추가: `TELEGRAM_ALLOWED_CHAT_IDS` env 지원 (쉼표 구분 → 정수 배열 파싱)

```diff
+    const envChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
+    if (envChatIds) {
+        settings.telegram.allowedChatIds = envChatIds
+            .split(',')
+            .map(id => parseInt(id.trim(), 10))
+            .filter(id => !isNaN(id));
+    }
```

### 4. `.env.example` 정리
- 주석 해제, 설명 명확화

## 사용법

```bash
# .env 파일 (이미 생성됨, .gitignore 포함):
TELEGRAM_TOKEN=your_bot_token
TELEGRAM_ALLOWED_CHAT_IDS=123456,789012

# 자동 로드 (Node 22+ --env-file):
cli-claw serve        # serve.js가 .env 존재 시 자동 --env-file 주입
npm run dev           # package.json scripts에 --env-file=.env 포함
```

### 변경 파일 요약

| 파일                        | 변경                                      |
| --------------------------- | ----------------------------------------- |
| `settings.json`             | token `""`, enabled `false`               |
| `~/.cli-claw/settings.json` | 동일                                      |
| `src/telegram.js`           | `TELEGRAM_ALLOWED_CHAT_IDS` env 파싱 추가 |
| `.env`                      | 실제 토큰 이관 (gitignored)               |
| `.env.example`              | 정리                                      |
| `package.json`              | `--env-file=.env` 추가                    |
| `bin/commands/serve.js`     | `.env` 존재 시 `--env-file` 자동 주입     |
