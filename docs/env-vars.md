# 환경변수 가이드

cli-jaw에서 사용하는 주요 환경변수. **전체 목록·사용처**는 `structure/infra.md` §환경변수가 source of truth다. 이 문서는 자주 쓰는 변수와 운영 팁을 **curated**로 정리하며, infra에 없는 항목(`CHROME_NO_SANDBOX`, `JAW_HUB_CALLBACK_URL`, `CLI_JAW_PRE_PROMPT_HOOKS`, `DEBUG`)은 코드 경로 기준 보조 설명이다.

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
| `JAW_HUB_CALLBACK_URL` | *(미설정)* | Telegram Hub member outbound callback override (loopback http only) |

## Manager dashboard

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DASHBOARD_PORT` | `24576` | Manager server 포트 |
| `JAW_DASHBOARD_OPEN` | *(미설정)* | `1`이면 `jaw dashboard serve` 후 브라우저 오픈 |

## 프롬프트 / 훅

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `CLI_JAW_PRE_PROMPT_HOOKS` | *(enabled)* | `0`이면 pre-prompt context hooks 비활성화 |

## 인증 / 보안

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `JAW_AUTH_TOKEN` | *(미설정)* | loopback 외 REST API bearer token |
| `JAW_BOSS_TOKEN` | *(미설정)* | boss-only employee dispatch token |
| `JAW_EMPLOYEE_MODE` | *(미설정)* | employee 내부 dispatch 차단 |
| `HOST` | *(미설정)* | `jaw serve` child에 전달되는 bind host |
| `JAW_OPEN_BROWSER` | *(미설정)* | `1`이면 serve 후 브라우저 오픈 |
| `JAW_LAN_MODE` | *(미설정)* | LAN host/origin bypass |
| `JAW_REMOTE_ACCESS_MODE` | *(미설정)* | `--remote` 시 `direct` 주입 |
| `JAW_TRUST_PROXY` | *(미설정)* | Express trust proxy |
| `JAW_TRUST_FORWARDED` | *(미설정)* | forwarded host/proto 신뢰 |

## Discord

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DISCORD_TOKEN` | *(미설정)* | Discord bot token (`settings.json` override) |
| `DISCORD_GUILD_ID` | *(미설정)* | 허용 guild ID |
| `DISCORD_CHANNEL_IDS` | *(미설정)* | 허용 channel ID (쉼표 구분) |

## Dashboard scan / OfficeCLI

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DASHBOARD_SCAN_FROM` | *(미설정)* | manager instance scan 시작 포트 |
| `DASHBOARD_SCAN_COUNT` | *(미설정)* | scan 포트 개수 |
| `OFFICECLI_REPO` | *(미설정)* | `scripts/install-officecli.sh` 소스 repo override (`lidge-jun/OfficeCLI` 기본) |
| `JAW_SAFE` | *(미설정)* | postinstall safe mode (`npm_config_jaw_safe` 동일) |

## 디버깅

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DEBUG` | *(미설정)* | 설정 시 ACP 통신, 에이전트 스폰 등 상세 로그 출력 |
| `LOG_LEVEL` | `info` | 로그 레벨: `debug`, `info`, `warn`, `error` |
