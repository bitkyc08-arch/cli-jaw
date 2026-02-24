# MVP-6: Telegram Bot

Bot API → 같은 Gateway → 같은 세션. Web UI와 동시 접속 가능.

## 체크리스트

- [ ] 패키지 선택: `grammy` (모던, TypeScript 지원)
- [ ] Telegram Bot 생성 (BotFather) + 토큰 설정
- [ ] Bot 메시지 수신 → Gateway 메시지 처리 파이프라인 연결
- [ ] Gateway 응답 → Bot reply (같은 chat_id에)
- [ ] Long-running 작업 시 "⏳ 처리 중..." 중간 응답
- [ ] 인증: 허용된 chat_id만 (설정에서 관리)
- [ ] Telegram에서 보낸 메시지 → Web UI에도 표시 (동일 세션)

## 메시지 흐름

```
Telegram → grammy → POST /api/message (내부 호출) → spawn → 결과
                                                        ↓
                                              WebSocket broadcast
                                              + Bot.reply()
```

## 설정

```json
{
  "telegram": {
    "enabled": false,
    "token": "",
    "allowedChatIds": []
  }
}
```
