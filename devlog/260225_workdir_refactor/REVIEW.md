# Review — Phase 3.1 + Phase 4 Execution Validation

**Date**: 2026-02-26  
**Scope**: 실제 코드 기준 검증 (Phase 3.1, Phase 4, 전반 기능)

---

## Findings (Severity Order)

### HIGH-1: `workingDir` 변경 후 산출물 재생성이 자동으로 일어나지 않음
- 근거: `server.ts`의 `applySettingsPatch()`는 설정 저장만 하고, `regenerateB()` / `ensureSkillsSymlinks()` / `syncToAll()`를 호출하지 않음.
- 영향: UI/API에서 `workingDir`만 바꾸면 새 경로에 `AGENTS.md`, `.mcp.json`, `.agents/skills`가 준비되지 않아 런타임 불일치 발생.

### HIGH-2: "권한 Auto 고정"이 기존 사용자(`safe`)에 대해 강제되지 않음
- 근거: 프런트 UI는 Auto 배지만 표시하지만, `permissions: safe`를 가진 기존 설정은 그대로 유지됨.
- 영향: 사용자는 UI상 Auto로 오해할 수 있고, 실제 실행은 safe 제약으로 동작 가능.

### MEDIUM-1: `launchd` 미지원 플래그가 install 경로로 떨어질 수 있음
- 근거: `parseArgs(..., strict:false)` + 기본 분기(`default`) 조합으로 `--dry-run` 같은 미지원 플래그가 에러 없이 setup 경로로 진입.
- 영향: 사용자가 비파괴 옵션으로 기대한 입력이 실제 설치 동작을 유발할 수 있음.

### LOW-1: `launchctl load/unload` 실행 시 plist 경로 quoting 미적용
- 근거: `launchctl unload ${PLIST_PATH}`, `launchctl load -w ${PLIST_PATH}` 형태.
- 영향: 경로에 공백/특수문자 포함 시 실패 가능.

---

## Verified Good

- Phase 1~2: 계획된 핵심 변경은 코드에 반영됨 (`JAW_HOME` 동적화, `--home` 처리, fallback 정리).
- Phase 3 (`clone`):
  - source 유효성 체크(존재 + `settings.json`)가 반영됨.
  - 테스트가 fixture 기반으로 개선되어 환경 의존성이 줄어듦.
- Phase 4 (`launchd`):
  - instance hash label, xmlEsc, `--home/--port` pass-through는 코드 반영됨.
  - `browser.ts` / `memory.ts` 서버 URL 하드코딩 제거됨.

---

## Verification Evidence

1. `npm test` 결과: `pass 299 / fail 0 / skipped 1`
2. 런타임 검증:
   - `workingDir` PUT 이후 새 경로 `AGENTS.md` 미생성 재현
   - 기존 `permissions: safe` 설정은 일반 settings PUT 이후에도 `safe` 유지 재현
3. 정적 검증:
   - `browser.ts`, `memory.ts`의 포트 고정 경로 제거 확인
   - `launchd.ts` 기본 분기/명령 문자열 처리 확인

---

## Conclusion

Phase 3.1은 **UI 반영 완료 + 런타임 후속 미완료** 상태입니다.  
Phase 4는 **코어 반영 완료 + hardening(플래그/경로 처리) 미완료** 상태입니다.  
전반적으로 큰 구조는 안정적이며, 남은 작업은 Phase 3.1 follow-up + Phase 4 마감 항목에 집중하면 됩니다.
