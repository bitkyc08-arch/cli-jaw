# (fin) Phase 3: Telegram 응답 버그 분석

## 증상

1. Telegram에 orchestration JSON 코드블럭만 옴 (또는 빈 응답)
2. 최종 요약 응답이 Telegram에 안 옴  
3. Web UI에는 정상 표시

## 원인

### 핵심: orchestrateAndCollect가 너무 일찍 resolve됨

```
타임라인:
  1. User → tgOrchestrate → orchestrateAndCollect → orchestrate()
  2. orchestrate() → spawnAgent (planning)
  3. Planning agent → subtask JSON 출력 + 종료
  4. spawnAgent L758: broadcast('agent_done', { text: strippedJSON })
     ↑ orchestrateAndCollect가 여기서 resolve! (첫 번째 agent_done)
  5. Telegram에 빈/JSON 텍스트 전송됨
  6. orchestrate()는 계속 진행 (sub-agent 스폰 → 결과 보고 → 최종 평가)
  7. L1075: broadcast('agent_done', { text: 최종요약 })
     ↑ orchestrateAndCollect 이미 resolve 완료 → Telegram 수신 불가
  8. Web UI는 WS 직접 연결이라 L1075의 agent_done 정상 수신
```

### 부차: stripSubtaskJSON 후 빈 텍스트

Planning agent 출력이 순수 JSON이면 strip 후 빈 문자열 → Telegram에 빈 응답

## 해결

### 방법: orchestrateAndCollect에서 "최종" agent_done만 수신

orchestrate()가 완료되면 마지막에 특별한 마커를 broadcast:

```javascript
// orchestrate() 끝에 추가
broadcast('orchestrate_done', { text: finalText });
```

orchestrateAndCollect에서는 `agent_done` 대신 `orchestrate_done`을 기다림:

```javascript
const handler = (type, data) => {
    if (type === 'agent_chunk' || ...) resetTimeout();
    if (type === 'agent_output') collected += data.text || '';
    // ❌ 기존: if (type === 'agent_done')
    // ✅ 변경: orchestrate 완료 이벤트만 수신
    if (type === 'orchestrate_done') {
        clearTimeout(timeout);
        removeBroadcastListener(handler);
        resolve(data.text || collected || '응답 없음');
    }
};
```

## 파일 변경

| 파일                                | 변경                                           |
| ----------------------------------- | ---------------------------------------------- |
| `server.js` orchestrate()           | 함수 끝에 `broadcast('orchestrate_done', ...)` |
| `server.js` orchestrateAndCollect() | `agent_done` → `orchestrate_done` 대기         |

## 체크리스트

- [ ] orchestrate() 끝에 orchestrate_done broadcast
- [ ] orchestrateAndCollect에서 orchestrate_done 대기
- [ ] 직접 응답(subtask 없음) 케이스도 처리
- [ ] 테스트: Telegram으로 orchestration 작업 요청
