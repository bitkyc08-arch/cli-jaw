# Phase 5.9.1 (finness): 타이포그래피 + 브랜딩 + Agent Name

> 완료: 2026-02-25T02:04

---

## A. 3단 타이포그래피

| 티어 | 폰트 | 용도 |
|------|------|------|
| **Display** | `Chakra Petch` | 로고, 섹션 타이틀, 탭, 사이드바 버튼, 배지, 헤더, 설정 h4 |
| **Body** | `Outfit` | 레이블, 본문, 일반 UI |
| **Code** | `SF Mono` | 입력창, 코드블록 |

적용 셀렉터: `.logo`(26px), `.section-title`, `.tab-btn`, `.sidebar-hb-btn`, `.status-badge`, `.chat-header`, `.settings-group h4`

## B. 🦞 이모지 제거

프론트엔드 전체에서 🦞 이모지 제거. 로고/헤더/타이틀은 `CLI-CLAW` 텍스트만 (불변).

## C. Agent Name 커스텀

좌측 사이드바 하단에 "Agent Name" 입력 필드:
- `localStorage('agentName')` 기반, 기본값 `"CLI-CLAW"`
- 변경 시 **메시지 라벨만** 반영 (로고·헤더·타이틀은 불변)
- `/clear` 버튼 바로 위 배치
- Phase 99에서 프롬프트 이름 지정 연동 예정

---

## 파일 변경

| 파일 | 변경 | 라인 |
|------|------|------|
| `variables.css` | `--font-display` 변수 추가 | 74L |
| `index.html` | Chakra Petch CDN + 🦞 제거 + Agent Name UI + /clear 위치 변경 | 436L |
| `layout.css` | `.logo` 26px, display font 6개 셀렉터 | 183L |
| `chat.css` | `.chat-header` display font | 401L |
| `sidebar.css` | `.settings-group h4` display font | 224L |
| `js/features/appname.js` | **NEW** 에이전트 이름 모듈 (메시지 라벨 전용) | 43L |
| `js/ui.js` | `getAppName()` import + 동적 라벨 | 143L |
| `js/main.js` | `initAppName()` import + bootstrap | 235L |
