---
created: 2026-08-12
status: done
tags: [cli-jaw, windows, openssh, conpty, issue-326]
---
# Windows OpenSSH 호출 가이드 (#326 fin)

## 결론

`ssh -tt`에서 관측되는 `ESC[?9001h/l`·`ESC[?1004h/l` 제어시퀀스는 **호스트 측
conhost/ConPTY**가 발행한다. cli-jaw 아님.

2026-08-12에 확인한 9개 호출 케이스의 관측 결과:

- jaw 미기동 plain `node -p`만으로도 동일 시퀀스 재현(양쪽 셸 공통).
- `ssh -T`에서는 전 케이스 소멸. `?1049`(alternate screen)는 어떤 케이스에서도 미출현.
- cli-jaw raw 캡처는 9개 케이스 전부 깨끗. 채팅 케이스(1-8)는 전부 clean exit(0),
  연결 실패 케이스(9)는 기대대로 exit 1.
- 프로세스 트리: `sshd → sshd → conhost --headless → pwsh`.

## 지원 호출 방식

| 호출 | 행동 | 권고 |
|---|---|---|
| `ssh -T host "jaw chat --simple --classic"` | 라인 모드, 시퀀스 없음 | **권고** |
| `ssh -T host "jaw chat --simple"` | 동일 | 권고 |
| `ssh -tt host ...` | ConPTY 노이즈(호스트 측) 노출되지만 jaw 동작·clean exit | 허용(노이즈는 호스트 귀속) |

클라이언트 측에서 `-tt`가 강제되는 환경이라면 노이즈를 ConPTY의 것으로 간주한다.
cli-jaw는 alternate screen(`?1049`)을 발행하지 않으며 `--classic`은 TTY/fullscreen
체크 전에 라인 모드로 해결된다.

## 회귀 게이트

`tests/integration/windows-ssh-classic.mts` — Windows 호스트(또는
`JAW_WINDOWS_SSH_HOST`)에서 control(`node -p`)과 jaw `-T`/`-tt` 케이스를 대조:
jaw `-T` 깨끗 + clean exit, `-tt`는 control과 노이즈 동등 + clean exit.
