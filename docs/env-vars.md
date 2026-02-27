# 환경변수 가이드

cli-jaw에서 사용하는 환경변수 목록.

---

## 서버 / 포트

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3457` | 서버 포트. CDP 포트는 `PORT + 5783`으로 자동 파생 |
| `CLI_JAW_HOME` | `~/.cli-jaw` | 설정, DB, 프로필 등 데이터 루트 경로 |

## 브라우저

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `CHROME_NO_SANDBOX` | *(미설정)* | `1`로 설정 시 `--no-sandbox` 플래그 추가. Docker/CI에서 Chromium sandbox가 실패할 때만 사용 |

> [!CAUTION]
> `CHROME_NO_SANDBOX=1`은 보안상 필요한 경우에만 설정하세요.
> 기본값은 sandbox ON이며, 컨테이너 환경에서도 자동으로 끄지 않습니다.

## 텔레그램

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `TELEGRAM_TOKEN` | *(미설정)* | 텔레그램 봇 토큰. `settings.json`의 `telegram.token`보다 우선 |
| `TELEGRAM_ALLOWED_CHAT_IDS` | *(미설정)* | 허용된 채팅 ID (쉼표 구분) |

## 디버깅

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DEBUG` | *(미설정)* | 설정 시 ACP 통신, 에이전트 스폰 등 상세 로그 출력 |
| `LOG_LEVEL` | `info` | 로그 레벨: `debug`, `info`, `warn`, `error` |
