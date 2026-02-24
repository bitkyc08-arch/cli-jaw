---
name: dev-backend
description: "Backend development guide for orchestrated sub-agents. API design, server logic, database integration, error handling, and security best practices. Injected when role=backend."
---

# Dev-Backend — 백엔드 개발 가이드

## API 설계 원칙

- **RESTful 규칙 준수**: `GET` 읽기, `POST` 생성, `PUT` 전체 수정, `PATCH` 부분 수정, `DELETE` 삭제
- **일관된 응답 형식**:
  ```json
  { "ok": true, "data": {...} }
  { "ok": false, "error": "설명" }
  ```
- **라우트 그룹핑**: 기능별로 파일 분리 (`/api/employees`, `/api/settings` 등)

## Express.js 패턴 (이 프로젝트 기준)

```javascript
// 기본 엔드포인트 패턴 (server.js 참고)
app.post('/api/feature', express.json(), async (req, res) => {
  try {
    const { param } = req.body;
    if (!param) return res.status(400).json({ ok: false, error: 'param required' });
    
    const result = await doSomething(param);
    res.json({ ok: true, data: result });
  } catch (e) {
    console.error('[feature]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

## 데이터베이스 (better-sqlite3)

이 프로젝트는 SQLite를 사용:
- `src/db.js`에서 prepared statement 패턴 참고
- 트랜잭션: `db.transaction(() => { ... })()`
- 마이그레이션: `db.exec('ALTER TABLE ...')` with existence check

## 에러 핸들링

- 모든 async 핸들러에 `try/catch` 필수
- 사용자에게 보여줄 에러와 내부 에러 구분
- `console.error('[module]', e.message)` 형식으로 로깅

## 보안 기본

- 입력값 검증 (타입, 범위, 길이)
- SQL injection: prepared statement 사용 (이미 better-sqlite3로 안전)
- 환경변수/시크릿: `settings.json` 또는 환경변수 사용, 하드코딩 금지
- CORS: 필요 시 명시적 설정

## 참고 스킬

더 깊은 가이드가 필요하면:
- `~/.cli-claw/skills_ref/postgres/` — SQL 쿼리 패턴
- `~/.cli-claw/skills_ref/security-best-practices/` — 보안 심화
- `~/.cli-claw/skills_ref/web-perf/` — 성능 최적화
