# dist/ 빌드 호환성 수정

> Date: 2026-02-25
> Scope: 빌드/배포 인프라

## 배경

TS 마이그레이션 완료 후 `npm run build` (tsc) → `dist/` 생성 → `node dist/bin/cli-claw.js serve`로
배포 실행하는 구조를 확정. 하지만 소스에서 `__dirname` 기준 상대경로를 쓰던 코드가
`dist/` 실행 시 경로가 안 맞는 문제 발생.

## 문제 1: package.json 경로

`src/core/config.ts`에서 `createRequire('../../package.json')` 사용.
- 소스: `src/core/` → `../../` = 프로젝트 루트 ✅
- dist: `dist/src/core/` → `../../` = `dist/` ❌

**해결**: `findPackageJson()` 함수로 디렉토리 상위 탐색, `package.json` 있는 곳을 동적으로 찾음.

## 문제 2: public/, .env, locales 경로

`server.ts`에서 `__dirname`으로 `public/`, `.env`, `public/locales/` 접근.
- 소스: `__dirname` = 프로젝트 루트 ✅
- dist: `__dirname` = `dist/` ❌ (`public/`은 프로젝트 루트에 있음)

**해결**: `findProjectRoot()` 함수 추가. `package.json`까지 상위 탐색하여 `projectRoot` 결정.
`__dirname` → `projectRoot` 총 7곳 교체:
- `.env` 로더
- `public/` mkdir
- `runMigration()`
- `express.static()`
- i18n languages API
- i18n locale file API
- `loadLocales()` 부트스트랩

## 문제 3: serve.ts의 server.js 경로

`serve.ts`가 `spawn(node, server.js)` 시 `projectRoot = __dirname + ../..` 사용.
- dist: `dist/bin/commands/../..` = `dist/` → `dist/server.js` 존재 ✅ (tsc가 생성)

이 경우는 자연스럽게 호환됨.

## 커밋

| 해시 | 설명 |
|------|------|
| `1b2472f` | config.ts: package.json 동적 탐색 |
| `b39a635` | server.ts: projectRoot로 static 경로 해석 |

## 검증

```
$ npm run build && node dist/bin/cli-claw.js serve --port 3458
  🦞 cli-claw serve — port 3458
  🦞 Claw Agent — http://localhost:3458
  ✅ @Clawcli_bot polling active
```

dist 빌드에서 서버 정상 기동, public/ 정적 파일 서빙, 텔레그램 봇 연결 확인.

## 교훈

tsc `outDir: dist` 빌드 시 `__dirname` 기반 상대경로는 **모두** 깨질 수 있다.
`package.json` 위치를 앵커로 프로젝트 루트를 동적 탐색하는 패턴이 안전하다.
