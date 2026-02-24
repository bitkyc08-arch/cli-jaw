# Phase 6.2 (finness): 토글 버튼 통일 + 반응형 로직

> 완료: 2026-02-25T02:43

---

## 토글 버튼 통일

### position:absolute 고정
```css
.sidebar-left .sidebar-toggle { position: absolute; top: 10px; left: 10px; }
.sidebar-right .sidebar-toggle { position: absolute; top: 10px; right: 10px; }
```

- 접혀도 펼쳐도 **동일한 위치** (top:10px, 외곽 끝)
- 좌우 대칭: ◀ 좌측 끝, ▶ 우측 끝
- 크기 통일: 28×28px
- 양쪽 사이드바 `padding-top: 48px` (토글 아래 컨텐츠 배치)

## 반응형 토글 로직

### 문제
`@media (max-width: 900px)` 자동 접힘 시 클릭으로 펼칠 수 없는 버그

### 해결: sidebar.js 이중 모드
```
Wide (>900px): toggle → left-collapsed / right-collapsed
Narrow (≤900px): toggle → left-expanded / right-expanded
```

- CSS: `body:not(.left-expanded)` → 접힘 (기본)
- JS: `left-expanded` 클래스 추가 → CSS override → 펼침
- `window resize`: wide 진입 시 expanded 제거 + collapsed 복원, narrow 진입 시 collapsed 일시제거
- 화살표 아이콘: 실제 상태 반영 (`isLeftOpen()`/`isRightOpen()`)

### 버그 수정: collapsed/expanded 충돌
- **문제**: wide에서 저장된 `left-collapsed` 클래스가 narrow에서도 유지 → `left-expanded` 추가해도 collapsed CSS가 우선 → 좌측 사이드바 안 펼어짐
- **해결**: narrow 진입 시 `left-collapsed`/`right-collapsed` 일시 제거, wide 복귀 시 localStorage에서 복원
```js
// narrow 진입 시
document.body.classList.remove('left-collapsed', 'right-collapsed');
// wide 복귀 시
document.body.classList.toggle('left-collapsed', !!saved.left);
```

## 변경 파일

| 파일 | 라인 | 변경 |
|------|------|------|
| `sidebar.js` | 89L | **REWRITE** 이중 모드 + collapsed 일시제거 로직 |
| `layout.css` | 282L | 토글 absolute + padding-top 48px + 접힌 패딩 통일 |
