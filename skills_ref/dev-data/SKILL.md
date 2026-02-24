---
name: dev-data
description: "Data engineering and analysis guide for orchestrated sub-agents. Data pipelines, ETL, SQL queries, CSV/JSON processing, and ML integration. Injected when role=data."
---

# Dev-Data — 데이터 개발 가이드

## 데이터 처리 원칙

- **파이프라인 사고**: 입력 → 변환 → 출력. 각 단계를 독립 함수로 분리.
- **스키마 우선**: 데이터 구조를 먼저 정의한 후 처리 로직 작성.
- **방어적 파싱**: 모든 외부 데이터는 null/undefined/빈값/타입 불일치 가정.

## 데이터 소스

### SQLite (이 프로젝트)
```javascript
import Database from 'better-sqlite3';
const db = new Database(DB_PATH);

// 읽기 전용 쿼리
const rows = db.prepare('SELECT * FROM employees WHERE role = ?').all(role);

// 집계
const stats = db.prepare('SELECT role, COUNT(*) as cnt FROM employees GROUP BY role').all();
```

### CSV/JSON 처리
```javascript
import fs from 'fs';

// JSON
const data = JSON.parse(fs.readFileSync(path, 'utf8'));

// CSV (간단한 경우)
const lines = fs.readFileSync(path, 'utf8').split('\n');
const headers = lines[0].split(',');
const rows = lines.slice(1).map(l => {
  const vals = l.split(',');
  return Object.fromEntries(headers.map((h, i) => [h.trim(), vals[i]?.trim()]));
});
```

## ETL 패턴

```javascript
// Extract → Transform → Load
async function pipeline(source, target) {
  const raw = await extract(source);      // 읽기
  const clean = transform(raw);           // 정제/변환
  await load(clean, target);              // 저장
}

function transform(rows) {
  return rows
    .filter(r => r.value != null)         // null 제거
    .map(r => ({
      ...r,
      value: Number(r.value),             // 타입 변환
      date: new Date(r.date).toISOString() // 날짜 정규화
    }));
}
```

## 분석/시각화

- 결과는 Markdown 테이블 또는 JSON으로 보고
- 큰 데이터셋은 요약 통계(count, mean, min, max) 먼저 제공
- 차트가 필요하면 HTML + Chart.js 또는 Mermaid 다이어그램 사용

## 참고 스킬

더 깊은 가이드가 필요하면:
- `~/.cli-claw/skills_ref/postgres/` — PostgreSQL 쿼리, 스키마 탐색
- `~/.cli-claw/skills_ref/data-structure-chooser/` — 적절한 자료구조 선택
- `~/.cli-claw/skills_ref/xlsx/` — Excel 파일 처리
