# Phase 5.9.1 (finness): 3단 타이포그래피 리파인

> 완료: 2026-02-25T01:52

---

## 변경 전

Outfit 1개 폰트가 로고·제목·버튼·본문 전부 담당 → UI 크롬이 "제너릭" 느낌

## 변경 후 — 3단 타이포그래피

| 티어 | 폰트 | 용도 | 특징 |
|------|------|------|------|
| **Display** | `Chakra Petch` | 로고, 섹션 타이틀, 탭, 사이드바 버튼, 배지, 채팅 헤더, 설정 h4 | 약간 angular — CLI/테크 느낌, 🦞 브랜드 적합 |
| **Body** | `Outfit` | 레이블, 본문, 일반 UI | 클린 산세리프 |
| **Code** | `SF Mono` | 입력창, 코드블록, 마크다운 코드 | 모노스페이스 |

> dev-frontend 원칙: *"Pair a distinctive display font with a refined body font"*

---

## 파일 변경

| 파일 | 변경 |
|------|------|
| `variables.css` | `--font-display` 변수 추가 |
| `index.html` | Google Fonts에 `Chakra+Petch` 추가 |
| `layout.css` | `.logo`, `.section-title`, `.tab-btn`, `.sidebar-hb-btn`, `.status-badge`에 적용 |
| `chat.css` | `.chat-header`에 적용 |
| `sidebar.css` | `.settings-group h4`에 적용 |

---

## `--font-display` 적용 요소 목록

```
.logo                 → 🦞 CLI-CLAW 브랜드
.chat-header          → 🦞 CLI-CLAW ● claude
.section-title        → Status, Memory, Stats, CLI STATUS
.tab-btn              → 🤖 Agents, 📦 Skills, 🔧 Settings
.sidebar-hb-btn       → 💓 Heartbeat (0), 🧠 Memory (0)
.status-badge         → ⚡ idle, ⏳ running
.settings-group h4    → 🟣 Claude, 🟢 Codex, 🔵 Gemini...
```
