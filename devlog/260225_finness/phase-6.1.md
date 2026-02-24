# Phase 6.1 (finness): 레이아웃 리팩터 + 이모지 정리

> 완료: 2026-02-25T02:32

---

## 사이드바 토글 구조
- ◀/▶ 각 사이드바 첫번째 자식으로 배치 (로고 위)
- 접힌 상태: 토글만 표시 (`:first-child` 외 `display:none`)
- 반응형: `@media (max-width: 900px)` 양쪽 자동 접힘

## 이모지 정리
- 탭 버튼: `🤖 Agents` → `Agents`, `📦 Skills` → `Skills`, `🔧 Settings` → `Settings`
- 서브에이전트 카드: `🤖` → CSS accent dot (8px)
- ROLE_PRESETS: `🎨⚙️📊📝✏️` 전부 제거 → 텍스트만
- 모델 커스텀: `✏️ 직접 입력...` → `직접 입력...`

## 하단 버튼 통일
- `/clear` 포함 전부 `sidebar-hb-btn` 클래스 통일
- `.sidebar-bottom` 컨테이너: `gap: 6px` 균일 간격
- `btn-clear`, `btn-save`: `--font-display` 폰트 적용

## 변경 파일

| 파일 | 변경 |
|------|------|
| `index.html` | 탭 이모지 제거, 토글 사이드바 내 배치 |
| `layout.css` | `.sidebar-bottom`, font 통일, 반응형 |
| `employees.js` | 🤖 → CSS dot, ✏️ 제거 |
| `constants.js` | ROLE_PRESETS 이모지 제거 |
