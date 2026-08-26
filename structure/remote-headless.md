---
created: 2026-08-26
status: done
tags: [cli-jaw, remote, ssh, headless, supervisor, issue-479]
---
# 원격·무인 상주 가이드 (#479)

SSH로 붙는 원격 호스트, 그중에서도 systemd가 없는 컨테이너에 `jaw`를 상주시키는
방법. 로컬 개발 머신에는 해당하지 않는다 — `jaw service` 한 줄이면 끝난다.

## 결론부터: 왜 조용히 실패했나

```
$ ssh box 'nohup jaw serve --port 3457 --no-open > serve.log 2>&1 &'
$ cat serve.log
nohup: failed to run command 'jaw': No such file or directory
```

로그인해서 치면 잘 되는데 위처럼 하면 안 된다. **PATH 문제인데 PATH라는 말이
어디에도 안 나오는 것**이 이 실패의 성질이다. `nohup`이 `jaw`를 찾지 못해 먼저
죽으므로 서버 코드는 한 줄도 실행되지 않고, pid 파일만 보고 상태를 판단하는
스크립트는 "서비스가 떠 있다"고 오판한다.

## 원인: 비대화형 셸은 그 파일들을 읽지 않는다

`npm i -g`가 설치하는 `~/.local/bin`은 셸 시작 파일에서 PATH에 추가된다. 그런데
`ssh host 'command'`는 **비로그인·비대화형** 셸이라 그 파일들 중 어느 것도 읽지
않는다.

| 셸 | 설치 스크립트가 기록하는 곳 | `ssh host 'cmd'`가 읽나 |
|---|---|---|
| bash | `.bashrc`, `.bash_profile` | ✗ — `.bash_profile`은 로그인 전용이고, 데비안 기본 `.bashrc`는 첫 줄에서 비대화형이면 `return` |
| zsh | `.zshrc`, `.zprofile` | ✗ — 비대화형 zsh는 `.zshenv`만 읽는다 |
| 그 외 | `.profile` | ✗ — 로그인 전용 |

즉 대화형 셸에서 `jaw`가 되는 것과 원격 원샷 명령에서 되는 것은 **별개의 사실**이다.

### 자가 진단

```bash
jaw doctor            # "Non-interactive PATH (ssh)" 항목을 본다
```

직접 확인하려면 비대화형 셸의 기본 PATH를 그대로 재현한다:

```bash
env -i PATH="$(getconf PATH)" sh -c 'command -v jaw'   # 아무것도 안 나오면 재현된 것
```

## 해결: 셋 중 하나

### 1. 절대 경로 (항상 통함, 설정 불필요)

```bash
ssh box '/home/box/.local/bin/jaw --version'
```

### 2. 원격 명령에서 PATH를 직접 준다

```bash
ssh box 'export PATH="$HOME/.local/bin:$PATH"; jaw service restart'
```

### 3. `~/.zshenv` (zsh 한정, 영구적)

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshenv
```

bash에는 대응물이 없다. `BASH_ENV`가 비대화형 셸용이지만 기본값이 없어 `ssh`가
설정해 주지 않으므로, bash 호스트에서는 1번이나 2번을 쓴다.

> `/usr/local/bin` 심볼릭 링크는 권하지 않는다. sudo가 필요하고, npm 전역 경로가
> 바뀌면 링크가 끊기며, 다중 Node 버전 환경에서 잘못된 바이너리를 가리키기 쉽다.

## 상주시키기

### systemd가 있으면

```bash
jaw service                 # 유닛 생성 + enable --now
jaw service status
```

생성된 유닛은 `Environment="PATH=..."`를 직접 박으므로 위 PATH 문제와 무관하다.

### systemd가 없으면 (컨테이너, PID1=tini)

```bash
jaw service --backend supervisor --port 3457
```

`<JAW_HOME>/jaw-supervisor.sh`를 생성한다. **이것은 autostart 등록이 아니다** —
그런 호스트에는 등록할 대상이 없다. 부팅을 소유한 무언가에 직접 연결해야 한다:

```bash
# 컨테이너 entrypoint / CMD
/home/box/.cli-jaw/jaw-supervisor.sh

# cron
@reboot /home/box/.cli-jaw/jaw-supervisor.sh &

# ssh로 지금 당장
ssh box 'setsid nohup /home/box/.cli-jaw/jaw-supervisor.sh >> /home/box/.cli-jaw/logs/jaw-serve.log 2>&1 < /dev/null &'
```

루프는 60초마다 `jaw service status --port N`으로 생존을 확인하고 죽었을 때만
재기동한다. `pgrep jaw` 같은 이름 매칭을 쓰지 않는 이유는 **PID 재사용** 때문이다 —
pid 파일의 PID를 무관한 프로세스가 물려받으면 이름 매칭은 영원히 "살아 있음"으로
읽고, 그게 #479가 겪은 오판과 같은 종류의 침묵이다. `service status`는 pid 파일을
OS의 프로세스 시작 시각과 대조하므로 재사용된 PID를 죽은 것으로 판정한다.

### 수동 기동 (일회성)

```bash
ssh box 'setsid nohup /home/box/.local/lib/nodejs/node-v24.19.0-linux-x64/bin/node \
  /home/box/.local/bin/jaw --home /home/box/.cli-jaw serve --port 3457 --no-open \
  >> /home/box/.cli-jaw/logs/jaw-serve.log 2>&1 < /dev/null &'
```

각 요소가 하는 일:

| 요소 | 이유 |
|---|---|
| 절대 경로 | 비대화형 PATH에서 이름 해석이 안 된다 (이 문서의 주제) |
| `setsid` | SSH 세션이 끊겨도 프로세스가 살아남는다. util-linux라서 macOS·일부 최소 이미지에는 없다 — 없으면 생략하고 `nohup`만 쓴다 |
| `nohup` | SIGHUP을 무시한다 |
| `< /dev/null` | 곧 사라질 터미널에 stdin이 물려 블록되는 것을 막는다 |
| `>> …log` | 조용히 죽었을 때 읽을 것이 남는다 |
| `&` | 백그라운드 |

## 상주 확인은 pid 파일만으로 부족하다

```bash
ssh box 'export PATH=$HOME/.local/bin:$PATH; jaw --home ~/.cli-jaw service status'
```

`jaw serve`는 `<JAW_HOME>/jaw.pid.json`에 PID와 **OS 프로세스 시작 시각**을 함께
기록하고, `service status`/`stop`/`restart`는 그 둘을 대조해 stale·foreign·검증불가
레코드를 거부한다. pid 파일의 존재만 보는 자작 스크립트는 이 검증을 건너뛰므로
죽은 서버를 살아 있다고 보고한다.

배포 후에는 **실행 중인 프로세스가 새 `dist/`를 로드했는지**까지 본다. `npm i -g`는
파일만 교체하고 서비스는 옛 코드를 계속 돌린다 — 절차는 루트 `AGENTS.md`의
"배포 확인은 npm 버전만으로 부족하다" 절에 있다.

## 관련 문서

- `structure/windows-ssh.md` — Windows OpenSSH의 ConPTY 제어 시퀀스 (#326)
- `structure/infra.md` — 릴리스 파이프라인과 부분 실패 복구
- 루트 `AGENTS.md` — Build & Deploy Contract

