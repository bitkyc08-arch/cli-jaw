# 오케스트레이션 벤치마크 테스트

> 각 테스트를 cli-claw 채팅에 입력해서 triage/pipeline 동작 확인
> 기대 동작: `D` = direct (triage skip), `O` = orchestrate (full pipeline)

---

## Tier 1: Direct Response (triage → direct, agent 1회)

```
1. 안녕
2. 지금 몇시야?
3. 고마워
4. ㅇㅇ
5. 오늘 뭐했어?
6. CLI-claw가 뭐야?
7. JavaScript와 TypeScript의 차이점이 뭐야?
8. REST API가 뭔지 설명해줘
9. 그래서 결론이 뭐야
10. 좋아 다음에 하자
```

**확인**: 서버 로그에 `[claw:triage] direct response` 출력, worklog 생성 안 됨

---

## Tier 2: Agent-level Triage (regex 통과 → planning agent가 direct_answer)

```
11. API 설계할 때 주의점이 뭐야?
12. 코드 리뷰 어떻게 하는 게 좋아?
13. Git branching 전략 추천해줘
14. 서버리스 아키텍처의 장단점은?
15. React vs Vue 비교해줘
```

**확인**: planning agent spawn되지만 `direct_answer` JSON 반환, subtask 없음

---

## Tier 3: Simple Orchestration (1~2 subtask, 단일 파일)

```
16. /tmp/bench/hello.js 파일에 "Hello World" 출력하는 Express 서버 만들어줘
17. /tmp/bench/calc.py에 간단한 사칙연산 계산기 만들어줘
18. /tmp/bench/todo.html에 로컬 TODO 앱 만들어줘 (localStorage 저장)
19. /tmp/bench/timer.js에 포모도로 타이머 CLI 만들어줘
20. /tmp/bench/quiz.py에 퀴즈 게임 만들어줘 (5문제, 점수 계산)
```

**확인**: orchestrate pipeline 실행, **순차 실행** 로그, 파일 생성 확인

---

## Tier 4: Complex Orchestration (멀티 파일, 멀티 에이전트)

```
21. /tmp/bench/tetris/ 폴더에 브라우저 테트리스 게임 만들어줘 (HTML + CSS + JS 분리, 점수판 포함)
22. /tmp/bench/chat/ 폴더에 WebSocket 기반 실시간 채팅 앱 만들어줘 (서버 + 클라이언트 + CSS)
23. /tmp/bench/blog/ 폴더에 마크다운 블로그 엔진 만들어줘 (Express 서버 + 템플릿 + CSS)
24. /tmp/bench/dashboard/ 폴더에 시스템 모니터링 대시보드 만들어줘 (CPU/RAM 차트, WebSocket 실시간)
25. /tmp/bench/api/ 폴더에 REST API 서버 만들어줘 (CRUD, SQLite, 에러 핸들링, 테스트 포함)
```

**확인**: 멀티 에이전트 **순차 실행** (agent 1 done → agent 2 start), 파일 충돌 없음, worklog 기록

---

## Tier 5: Stress Test (복잡 + 의존성 높은 작업)

```
26. /tmp/bench/snake/ 폴더에 터미널 Snake 게임 만들어줘. Node.js로. 방향키 입력, 점수, 게임오버, 하이스코어 저장, 색상 출력까지.
27. /tmp/bench/kanban/ 폴더에 칸반보드 웹앱 만들어줘. 드래그앤드롭, 컬럼 추가/삭제, 카드 CRUD, localStorage 영구 저장, 반응형 디자인.
28. /tmp/bench/compiler/ 폴더에 간단한 수식 컴파일러 만들어줘. 렉서 → 파서 → AST → 인터프리터 4단계. 사칙연산 + 괄호 + 변수 할당 지원. 테스트 10개 이상.
29. src/orchestrator.js를 리팩토링해서 triage 로직을 별도 모듈(src/triage.js)로 분리하고, 테스트 파일(test/triage.test.js)도 작성해줘
30. README.md 업데이트하고, str_func.md 라인 카운트 갱신하고, phase6.md에 벤치마크 결과 섹션 추가하고, devlog 테이블도 갱신해줘
```

**확인**: 전체 파이프라인 + 순차 실행 + 이전 에이전트 참조 (priorSummary) + Quality Gate

---

## 실행 방법

```bash
# 서버 시작
node bin/cli-claw.js serve

# 벤치마크 작업 디렉토리 준비
mkdir -p /tmp/bench

# 웹 UI에서 테스트 (localhost:3457)
# 또는 CLI에서:
node bin/cli-claw.js chat
```

## 확인 포인트

| 체크 | 항목                                                                   |
| ---- | ---------------------------------------------------------------------- |
| ☐    | Tier 1: `[claw:triage] direct response` 로그                           |
| ☐    | Tier 2: planning agent → `direct_answer` 반환                          |
| ☐    | Tier 3: pipeline 실행, 파일 생성 확인                                  |
| ☐    | Tier 4: 순차 실행 로그 (`agent 1 done → agent 2 start`) + priorSummary |
| ☐    | Tier 4: 파일 충돌 없음 (같은 파일 동시 수정 X)                         |
| ☐    | Tier 5: worklog에 모든 에이전트 결과 기록                              |
| ☐    | Tier 5: Quality Gate verdict 정상                                      |
