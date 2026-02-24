# Phase 6: Copilot 할당량 + UI 브랜딩

> 예상 시간: 15~20분

---

## 6.1 Copilot 할당량 표시

### 현재 구조
기존 CLI들의 할당량은 `server.js`의 `/api/quota` 에서 CLI별 함수로 조회중:
- Claude → `quota-claude.js` (API 토큰 기반, rate limit headers)
- Codex → `quota-codex.js`
- Gemini → 별도 없음

### Copilot 할당량 조회 방법

#### 방법 A: `session/new` 응답에서 모델별 `copilotUsage` 파싱 (추천)
```json
// session/new result에 이미 포함됨:
{
    "models": {
        "availableModels": [
            {
                "modelId": "claude-sonnet-4.6",
                "_meta": {
                    "copilotUsage": "1x",       // 비용 배율
                    "copilotEnablement": "enabled"  // 사용 가능 여부
                }
            },
            {
                "modelId": "gpt-4.1",
                "_meta": {
                    "copilotUsage": "0x",       // 무료
                    "copilotEnablement": "enabled"
                }
            }
        ]
    }
}
```

**구현**: 
1. `session/new` 결과의 `models.availableModels`를 캐싱
2. `/api/quota` 응답에 copilot 추가:
   ```js
   copilot: {
       account: { type: 'github', plan: 'copilot-pro' },
       models: [
           { id: 'gpt-4.1', cost: '0x' },
           { id: 'claude-sonnet-4.6', cost: '1x' },
           ...
       ],
   }
   ```
3. `settings.js`의 `renderCliStatus()`가 자동으로 표시

#### 방법 B: `gh` CLI 토큰 조회
```bash
# GitHub 인증 상태
gh auth token  # → gho_xxxxx (OAuth token)
gh auth status # → Logged in, Copilot Pro plan
```
서버에서 `execSync('gh auth status')` 파싱 → account.plan 표시

### 권장 구현
- **Phase 2에서 이미 확인된 데이터 활용** (session/new 응답)
- `session/new` 호출 시 `availableModels` 캐싱 → `/api/quota`에 노출
- 추가로 `gh auth status` 파싱하여 plan/email 표시 (선택사항)

### 파일 변경
- `[NEW] lib/quota-copilot.js` — 할당량 조회 모듈
- `[MODIFY] server.js` — `/api/quota`에 copilot 추가
- `[MODIFY] src/acp-client.js` — createSession에서 availableModels 캐싱

---

## 6.2 UI 브랜딩 변경: CLAW → cli-claw

### 변경 대상

| 위치 | 현재 | 변경 |
|------|------|------|
| L21 `div.logo` | 🦞 CLAW | 🦞 cli-claw |
| L7 `<title>` | 🦞 Claw Agent | 🦞 cli-claw |
| L45 `chat-header` | 🦞 Claw Agent ● ... | 🦞 cli-claw ● ... |
| L48 `typing-indicator .label` | 🦞 응답 중 | 🦞 응답 중 (변경 불필요) |

### CSS 조정
- `.logo` font-size가 현재 16px → `cli-claw` 4글자 더 길어서 14px로 조정 or 그대로 유지

### 파일 변경
- `[MODIFY] public/index.html` — 3곳 텍스트 변경
- `[MODIFY] public/css/layout.css` — (필요시) 로고 font-size

---

## 6.3 구현 순서

1. `index.html` 브랜딩 텍스트 3곳 변경 (2분)
2. `lib/quota-copilot.js` 생성 (10분)  
3. `server.js` quota 라우트 수정 (5분)
4. `acp-client.js` availableModels 캐싱 (3분)
5. 테스트 + 커밋

---

## 6.4 알려진 정보

> **session/new 응답에서 이미 확인된 Copilot 모델 목록:**
> - claude-sonnet-4.6 (1x), claude-sonnet-4.5 (1x), claude-haiku-4.5 (1x)  
> - gpt-5.3-codex (1x), gpt-5.2-codex (1x), gpt-5.1-codex (1x)
> - gpt-4.1 (0x 무료), gpt-5-mini (0x 무료)
> - gemini-3-pro-preview (1x)
>
> `loadSession: true` 확인됨 → resume 정상 지원
