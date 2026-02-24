---
name: notion
description: Notion API for creating and managing pages, databases, and blocks.
homepage: https://developers.notion.com
metadata:
  {
    "openclaw":
      { "emoji": "📝", "requires": { "env": ["NOTION_API_KEY"] }, "primaryEnv": "NOTION_API_KEY" },
  }
---

# notion

Use the Notion API to create/read/update pages, data sources (databases), and blocks.

## Setup

1. Create an integration at https://notion.so/my-integrations
2. Copy the API key (starts with `ntn_` or `secret_`)
3. Store it:

```bash
mkdir -p ~/.config/notion
echo "ntn_your_key_here" > ~/.config/notion/api_key
```

4. Share target pages/databases with your integration (click "..." → "Connect to" → your integration name)

## API Basics

All requests need:

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
curl -X GET "https://api.notion.com/v1/..." \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json"
```

> **Note:** The `Notion-Version` header is required. This skill uses `2025-09-03` (latest). In this version, databases are called "data sources" in the API.

## Common Operations

**Search for pages and data sources:**

```bash
curl -X POST "https://api.notion.com/v1/search" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{"query": "page title"}'
```

**Get page:**

```bash
curl "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03"
```

**Get page content (blocks):**

```bash
curl "https://api.notion.com/v1/blocks/{page_id}/children" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03"
```

**Create page in a data source:**

```bash
curl -X POST "https://api.notion.com/v1/pages" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"database_id": "xxx"},
    "properties": {
      "Name": {"title": [{"text": {"content": "New Item"}}]},
      "Status": {"select": {"name": "Todo"}}
    }
  }'
```

**Query a data source (database):**

```bash
curl -X POST "https://api.notion.com/v1/data_sources/{data_source_id}/query" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {"property": "Status", "select": {"equals": "Active"}},
    "sorts": [{"property": "Date", "direction": "descending"}]
  }'
```

**Create a data source (database):**

```bash
curl -X POST "https://api.notion.com/v1/data_sources" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"page_id": "xxx"},
    "title": [{"text": {"content": "My Database"}}],
    "properties": {
      "Name": {"title": {}},
      "Status": {"select": {"options": [{"name": "Todo"}, {"name": "Done"}]}},
      "Date": {"date": {}}
    }
  }'
```

**Update page properties:**

```bash
curl -X PATCH "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"Status": {"select": {"name": "Done"}}}}'
```

**Add blocks to page:**

```bash
curl -X PATCH "https://api.notion.com/v1/blocks/{page_id}/children" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{
    "children": [
      {"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": "Hello"}}]}}
    ]
  }'
```

## Property Types

Common property formats for database items:

- **Title:** `{"title": [{"text": {"content": "..."}}]}`
- **Rich text:** `{"rich_text": [{"text": {"content": "..."}}]}`
- **Select:** `{"select": {"name": "Option"}}`
- **Multi-select:** `{"multi_select": [{"name": "A"}, {"name": "B"}]}`
- **Date:** `{"date": {"start": "2024-01-15", "end": "2024-01-16"}}`
- **Checkbox:** `{"checkbox": true}`
- **Number:** `{"number": 42}`
- **URL:** `{"url": "https://..."}`
- **Email:** `{"email": "a@b.com"}`
- **Relation:** `{"relation": [{"id": "page_id"}]}`

## Key Differences in 2025-09-03

- **Databases → Data Sources:** Use `/data_sources/` endpoints for queries and retrieval
- **Two IDs:** Each database now has both a `database_id` and a `data_source_id`
  - Use `database_id` when creating pages (`parent: {"database_id": "..."}`)
  - Use `data_source_id` when querying (`POST /v1/data_sources/{id}/query`)
- **Search results:** Databases return as `"object": "data_source"` with their `data_source_id`
- **Parent in responses:** Pages show `parent.data_source_id` alongside `parent.database_id`
- **Finding the data_source_id:** Search for the database, or call `GET /v1/data_sources/{data_source_id}`

## Current Environment

### API Key
- **Location:** `~/.config/notion/access_token` (also copied to `~/.config/notion/api_key`)
- **Format:** `ntn_` prefix
- **Load:** `NOTION_KEY=$(cat ~/.config/notion/api_key)`
- **OAuth config:** `~/.config/notion/oauth.env` (client_id, client_secret, redirect_uri)
- **OAuth docs:** `~/Documents/BlogProject/NOTION_OAUTH_SETUP.md`

### Workspace Structure (쭈니님의 워크스페이스)

```
🚀 Lidge AI (루트) [3113680a-8101-81b8-9cd5-e378212151ce]
├── 🔬 개인 작업함 [3113680a-8101-8104-b512-db1bfa7631c0]
│   └── 📦 개인 실험 아카이브
│
└── 📅 2026년 3월 출범 [7458b1b1-ffd0-44ed-a38d-818bd6c03f58]
    ├── 📊 대시보드 [3113680a-8101-8174-b500-dff399ac9046]
    ├── 🎯 제품 포트폴리오
    │   ├── 🏥 병원 댓글관리 홍보 자동화 (sujong1 기반)
    │   ├── 🎓 학원 댓글관리 홍보 자동화 (sujong1 기반)
    │   └── 🧮 회계·세무 RAG 상담봇
    ├── 🐾 Cliclaw [3113680a-8101-81c1-bc60-d54ddb678a2d]
    │   ├── 📋 개요
    │   ├── ✅ 구현 계획 체크리스트
    │   ├── 📜 전체 개발 히스토리 (MVP → Finness 12)
    │   └── 🔧 개발노트 (223, 224, 225, MVP)
    ├── 📋 예비창업패키지
    ├── 🏛️ 공공기관 수주 확장
    ├── ✍️ 콘텐츠
    ├── ⚙️ 운영
    │   ├── 📝 자동화 운영 점검 노트
    │   └── 🎯 창업지원프로그램
    ├── 🤝 회의록
    └── 🗄️ 아카이브
```

### Key Page IDs (Quick Reference)
- **Lidge AI (root):** `3113680a-8101-81b8-9cd5-e378212151ce`
- **2026년 3월 출범:** `7458b1b1-ffd0-44ed-a38d-818bd6c03f58`
- **Cliclaw:** `3113680a-8101-81c1-bc60-d54ddb678a2d`
- **대시보드:** `3113680a-8101-8174-b500-dff399ac9046`
- **개인 작업함:** `3113680a-8101-8104-b512-db1bfa7631c0`

### Heartbeat Integration
- heartbeat job `notion_hourly_upgrade` (120min 주기)가 `Lidge AI/개인 작업함` 범위에서 소규모 개선 자동 수행
- heartbeat 설정: `~/.cli-claw/heartbeat.json`

## Visual Design Rules (미감 가이드)

페이지를 꾸밀 때 아래 규칙을 반드시 따른다:

### 1. 멘션 링크 (이중링크) 필수

페이지 이름을 텍스트로 적지 말고, 반드시 `mention` 타입을 사용한다.
멘션 링크는 클릭 시 해당 페이지로 이동하고, 백링크(역참조)도 자동 생성된다.

```json
// ✅ 올바른 방법 — mention
{"type": "mention", "mention": {"type": "page", "page": {"id": "페이지-UUID"}}}

// ❌ 잘못된 방법 — 일반 텍스트
{"type": "text", "text": {"content": "페이지 이름"}}
```

### 2. 이모지 중복 금지

멘션 링크는 페이지 아이콘을 자동으로 표시하므로, 텍스트에 이모지를 별도로 넣지 않는다.

```json
// ✅ 올바른 — 멘션이 알아서 "🐾 Cliclaw" 표시
[mention("Cliclaw"), text(" — 오픈소스 AI 터미널")]

// ❌ 잘못된 — 이모지 중복 (🐾🐾 Cliclaw)
[text("🐾 "), mention("Cliclaw"), text(" — 오픈소스 AI 터미널")]
```

### 3. callout 안에 멘션 링크 사용

callout 블록의 `rich_text` 배열 안에서도 mention 타입을 사용할 수 있다.
네비게이션 허브나 Quick Links를 만들 때 callout + mention 조합을 활용한다.

```json
{"object": "block", "type": "callout", "callout": {
    "rich_text": [
        {"type": "mention", "mention": {"type": "page", "page": {"id": "대시보드-UUID"}}},
        {"type": "text", "text": {"content": " · "}},
        {"type": "mention", "mention": {"type": "page", "page": {"id": "운영-UUID"}}}
    ],
    "icon": {"type": "emoji", "emoji": "🏠"},
    "color": "gray_background"
}}
```

### 4. child_page 블록 보호

페이지 블록을 삭제/재작성할 때, `child_page` 타입 블록은 절대 삭제하지 않는다.
삭제하면 하위 페이지가 아카이브 처리되어 사라진다.

```python
# 블록 삭제 시 child_page 제외
for block in children:
    if block["type"] != "child_page":
        delete_block(block["id"])
```

### 5. 페이지 구조 패턴

```
callout (소개/슬로건) + color_background
divider
heading_2 (섹션명)
callout (멘션 링크 모음) + gray_background  ← 네비게이션
divider
heading_2 (Quick Links)
bulleted_list_item (멘션 → 설명)            ← 바로가기
divider
...
```

### 6. 아이콘 & 커버

- 모든 페이지에 의미 있는 이모지 아이콘 설정
- 주요 페이지에는 Unsplash 커버 이미지 (w=1500 권장)
- `update_page(page_id, icon="🐾", cover_url="https://images.unsplash.com/...")`

### 7. 멘션 링크 사용 시 주의사항

- 대상 페이지가 archived 상태면 mention이 일반 텍스트로 변환됨
- Integration이 해당 페이지에 접근 권한이 있어야 mention 동작
- API rate limit: ~3 req/s — `time.sleep(0.35)` 권장

## Notes

- Page/database IDs are UUIDs (with or without dashes)
- The API cannot set database view filters — that's UI-only
- Rate limit: ~3 requests/second average
- Use `is_inline: true` when creating data sources to embed them in pages
