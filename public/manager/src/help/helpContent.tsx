import type { ReactNode } from 'react';
import { DEFAULT_MANAGER_SHORTCUT_KEYMAP, formatShortcut } from '../manager-shortcuts';
import type { DashboardSidebarMode } from '../types';

export type HelpTopicId = DashboardSidebarMode | 'shortcuts' | 'routing' | 'processLifecycle' | 'dangerousActions';

export type HelpEntry = {
    title: string;
    subtitle: string;
    body: ReactNode;
};

const InstancesHelp = (
    <>
        <p className="help-lead">실행 중인 jaw 인스턴스를 보고, 미리보기·로그·설정을 다루는 곳이에요.</p>
        <ul className="help-bullets">
            <li>좌측 네비게이터에서 인스턴스를 골라 우측 Workbench(Overview / Preview / Logs / Settings)에서 작업하실 수 있어요.</li>
            <li>우측 상단 상태 점이 초록이면 온라인, 회색이면 오프라인이에요.</li>
            <li>인스턴스에 직접 메시지를 보내실 땐 Preview 탭의 채팅 입력을 쓰세요.</li>
            <li>Preview 채팅에 나온 Notes vault 경로를 클릭하면 Notes workspace로 이동해 해당 파일을 열 수 있어요.</li>
        </ul>
        <div className="help-deep">
            <h4>빠른 판단 기준</h4>
            <table className="help-table">
                <tbody>
                    <tr><th>Preview</th><td>실제 인스턴스 화면을 보거나 메시지를 보낼 때</td></tr>
                    <tr><th>Logs</th><td>응답이 멈췄거나 dispatch 실패 원인을 확인할 때</td></tr>
                    <tr><th>Settings</th><td>해당 인스턴스의 CLI, 모델, 권한을 조정할 때</td></tr>
                </tbody>
            </table>
        </div>
        <p className="help-tip">인스턴스가 안 보이시면 터미널에서 <code>cli-jaw start</code>로 새 jaw를 띄워보세요. 자동으로 목록에 떠요.</p>
    </>
);

const BoardHelp = (
    <>
        <p className="help-lead">사람이 먼저 일반 칸반 블럭을 만들고, 실행 인스턴스 블럭을 그 안에 붙이는 계층형 보드예요.</p>
        <ul className="help-bullets">
            <li>레인 5개는 <strong>Backlog / Ready / In Progress / Review / Done</strong> 순서예요. Backlog는 아직 commit 전 옵션, Ready는 바로 pull 가능한 작업이에요.</li>
            <li><strong>Overall</strong>은 5열 전체 보드이고, 사이드바에서 각 레인을 누르면 해당 레인만 보는 detail 화면으로 전환돼요.</li>
            <li><strong>Done</strong>은 Overall에서 최근 4개만 full card로 보여주고, 나머지는 <strong>+ N more</strong>를 눌러 Done detail 화면에서 2줄 row로 확인해요.</li>
            <li>각 레인 하단의 <strong>+ Add task</strong>로 일반 칸반 블럭을 만들고, 그 블럭 제목에 쿼리나 작업 메모를 적으시면 돼요.</li>
            <li>좌측 <strong>Running</strong> 섹션에는 현재 실행 중인 인스턴스만 인스턴스 블럭으로 보여요.</li>
            <li>인스턴스 블럭을 일반 칸반 블럭 안의 드롭 영역으로 끌어 넣으면 내부 자식 블럭으로 병합돼요. 인스턴스 실행에는 영향 없어요.</li>
            <li>일반 칸반 블럭은 직접 드래그해서 다른 레인으로 옮길 수 있고, <strong>Move</strong> / <strong>Delete</strong>도 유지돼요.</li>
        </ul>
        <div className="help-deep">
            <h4>상태를 나눠 쓰는 법</h4>
            <table className="help-table">
                <tbody>
                    <tr><th>Ready</th><td>바로 구현하거나 검증할 수 있는 작업</td></tr>
                    <tr><th>Review</th><td>직원 감사, Pro 검증, 수동 smoke가 필요한 작업</td></tr>
                    <tr><th>Done</th><td>커밋, 푸시, 이슈 close까지 끝난 작업</td></tr>
                </tbody>
            </table>
        </div>
        <p className="help-tip">인스턴스가 없어도 일반 칸반 블럭은 계속 남아요. 쿼리·아이디어·작업 단위를 먼저 적고, 필요할 때만 실행 인스턴스를 붙이면 돼요.</p>
    </>
);

const ScheduleHelp = (
    <>
        <p className="help-lead">매니저가 1분마다 틱을 돌면서 대시보드에 등록된 자동화 작업을 일괄 dispatch 해주는 곳이에요.</p>
        <ul className="help-bullets">
            <li><strong>Today / Upcoming / Recurring / Blocked</strong> 그룹으로 정리되고, <code>cron</code>·<code>runAt</code>·target port를 함께 저장해요.</li>
            <li>Run 버튼으로 즉시 dispatch, 대상 인스턴스가 바쁘면 자동 큐잉이에요. last/next 컬럼으로 실행 이력이 보여요.</li>
            <li>예전엔 인스턴스마다 자기 <code>heartbeat.json</code>을 setInterval로 돌리던 구조였는데, 지금은 <strong>매니저가 단일 ticker</strong>로 돌려요. heartbeat.json은 legacy로만 표시되고 자동 실행은 안 돼요.</li>
        </ul>
        <div className="help-deep">
            <h4>실패를 볼 때</h4>
            <table className="help-table">
                <tbody>
                    <tr><th>queued</th><td>대상 인스턴스가 바빠서 대기 중</td></tr>
                    <tr><th>blocked</th><td>비활성화했거나 실행 조건이 아직 맞지 않음</td></tr>
                    <tr><th>last/next</th><td>최근 실행 결과와 다음 실행 예측을 확인하는 기준</td></tr>
                </tbody>
            </table>
        </div>
        <p className="help-tip">새 작업은 여기서 만들고, 기존 heartbeat job은 같은 cron으로 옮겨 등록하시면 돼요. 마이그레이션 자동화는 추후 추가됩니다.</p>
    </>
);

const NotesHelp = (
    <>
        <p className="help-lead"><code>~/.cli-jaw-dashboard/notes/</code>의 마크다운 파일을 직접 편집하는 노트장이에요.</p>
        <ul className="help-bullets">
            <li>좌측 트리에서 파일 선택, 우측에서 <strong>Raw / Preview / WYSIWYG</strong> 모드로 편집하실 수 있어요.</li>
            <li>Instances Preview 채팅에서 vault 경로(예: <code>~/.cli-jaw-dashboard/notes/foo.md</code> 또는 <code>daily/foo.md</code>)를 <strong>클릭</strong>하면 Notes 탭으로 이동하고 해당 파일이 열려요. 자동 전환은 없고 클릭할 때만 이동합니다.</li>
            <li>vault 밖 경로(예: 프로젝트 <code>.ts</code> 파일)는 기존처럼 Finder로 열려요.</li>
            <li><kbd>⌘/Ctrl + S</kbd>로 저장, <kbd>⌘/Ctrl + E</kbd>로 모드 순환 전환이에요.</li>
            <li>파일이 외부에서 바뀌면 충돌 알림이 떠요 — Reload / Overwrite / Keep local 중 선택하세요.</li>
        </ul>
        <p className="help-tip">💡 좌측 트리 상단 <strong>+ New</strong>로 첫 노트를 만들어 보세요. 폴더는 <code>folder/note.md</code> 처럼 한 번에 만드실 수 있어요.</p>
    </>
);

const RemindersHelp = (
    <>
        <p className="help-lead">Jaw Reminders 스냅샷을 대시보드에서 읽고 확인하는 미러 화면이에요.</p>
        <ul className="help-bullets">
            <li><strong>All / Focused / Scheduled / High / Done</strong> 보기로 현재 reminder 상태를 훑어볼 수 있어요.</li>
            <li>Refresh는 외부 Jaw Reminders 스냅샷을 다시 읽어서 대시보드용 row로 반영해요.</li>
            <li>원본 reminder 저장소가 없거나 형식이 맞지 않아도 대시보드는 기존 미러 데이터를 유지하고 상태 메시지만 보여줘요.</li>
        </ul>
        <div className="help-deep">
            <h4>Matrix 보기</h4>
            <table className="help-table">
                <tbody>
                    <tr><th>Top Priority</th><td>지금 먼저 처리할 3개를 따로 고정</td></tr>
                    <tr><th>Important</th><td>중요하지만 급하지 않은 장기 작업</td></tr>
                    <tr><th>Waiting</th><td>다른 사람, 직원, 외부 검증을 기다리는 작업</td></tr>
                </tbody>
            </table>
        </div>
        <p className="help-tip">Reminders는 실험 기능이라 개발 모드 또는 실험 플래그가 켜진 빌드에서만 보여요.</p>
    </>
);

const SettingsHelp = (
    <>
        <p className="help-lead">대시보드 외형과 동작 옵션을 조정하는 곳이에요.</p>
        <ul className="help-bullets">
            <li>사이드바 폭, 워드랩, 테마 같은 표시 옵션을 바꾸실 수 있어요.</li>
            <li>인스턴스 자체 설정이 아니라 <strong>이 대시보드 UI의 환경설정</strong>이에요.</li>
            <li>변경 사항은 즉시 저장돼요.</li>
        </ul>
        <div className="help-deep">
            <h4>설정 범위</h4>
            <table className="help-table">
                <tbody>
                    <tr><th>Display</th><td>목록, 언어, 단축키 같은 dashboard UI 선호도</td></tr>
                    <tr><th>Activity</th><td>최근 작업 제목이 어떤 인스턴스에서 준비됐는지 확인</td></tr>
                    <tr><th>Instance settings</th><td>개별 인스턴스 동작은 Instances workspace에서 수정</td></tr>
                </tbody>
            </table>
        </div>
        <p className="help-tip">인스턴스 동작을 바꾸시려면 여기가 아니라 <strong>Instances → 해당 인스턴스 → Settings 탭</strong>으로 가세요.</p>
    </>
);

const ShortcutsHelp = (
    <>
        <p className="help-lead">반복 작업을 줄이는 Manager 전역 단축키예요.</p>
        <ul className="help-bullets">
            <li><kbd>?</kbd>는 이 도움말을 열어요. 입력창, 노트 에디터, WYSIWYG 편집 중에는 글자 입력을 방해하지 않아요.</li>
            <li><kbd>{formatShortcut(DEFAULT_MANAGER_SHORTCUT_KEYMAP.focusInstances)}</kbd>는 Instances workspace로 이동해요.</li>
            <li><kbd>{formatShortcut(DEFAULT_MANAGER_SHORTCUT_KEYMAP.focusActiveSession)}</kbd>는 선택된 인스턴스의 Preview 탭으로 이동해요.</li>
            <li><kbd>{formatShortcut(DEFAULT_MANAGER_SHORTCUT_KEYMAP.focusNotes)}</kbd>는 Notes workspace로 이동해요.</li>
            <li><kbd>{formatShortcut(DEFAULT_MANAGER_SHORTCUT_KEYMAP.previousInstance)}</kbd> / <kbd>{formatShortcut(DEFAULT_MANAGER_SHORTCUT_KEYMAP.nextInstance)}</kbd>는 현재 필터된 인스턴스 목록에서 이전/다음 행을 선택해요.</li>
            <li><kbd>Alt+1</kbd> … <kbd>Alt+9</kbd>는 렌더된 사이드바 행으로 점프하고, Alt를 200ms 누르면 행 오른쪽에 점프 힌트가 떠요.</li>
            <li><kbd>⌘/Ctrl + S</kbd>는 Notes와 Settings처럼 저장 가능한 화면에서 현재 편집 내용을 저장해요.</li>
            <li><kbd>⌘/Ctrl + E</kbd>는 Notes 편집 모드를 순환해요.</li>
            <li>Manager 단축키는 Dashboard settings에서 켜고 끄거나 keymap을 바꿀 수 있어요.</li>
            <li>Preview 탭을 보는 동안 새 activity는 읽음으로 처리되고, 다른 탭에 있을 때는 Activity Dock에 쌓여요.</li>
        </ul>
        <div className="help-deep">
            <h4>충돌이 날 때</h4>
            <table className="help-table">
                <tbody>
                    <tr><th>입력 중</th><td>글자 입력을 우선하고 전역 shortcut은 실행하지 않음</td></tr>
                    <tr><th>브라우저 충돌</th><td>Dashboard settings에서 keymap을 바꾸는 것이 안전함</td></tr>
                    <tr><th>도움말</th><td><kbd>?</kbd>는 현재 workspace 도움말과 shortcut 도움말의 진입점</td></tr>
                </tbody>
            </table>
        </div>
        <p className="help-tip">단축키는 브라우저 기본 단축키와 에디터 입력을 우선합니다.</p>
    </>
);

const RoutingHelp = (
    <>
        <p className="help-lead">jaw는 Boss가 직접 처리할지, Employee에게 보낼지 상황에 따라 나눠요.</p>
        <ul className="help-bullets">
            <li><strong>Boss</strong>는 현재 대화의 주 작업자예요. 단일 파일 수정, 상태 확인, GitHub 정리는 보통 Boss가 직접 처리해요.</li>
            <li><strong>Employee</strong>는 <code>cli-jaw dispatch</code>로 보내는 독립 작업자예요. Backend, Frontend, Docs 같은 역할별 검증에 씁니다.</li>
            <li><strong>PABCD</strong>에서는 A phase가 plan audit, B phase가 read-only verification 중심이에요. 구현은 Boss가 직접 합니다.</li>
            <li><strong>$computer-use</strong> 요청은 desktop-control 규칙을 따라 real desktop 또는 browser automation 경로로 라우팅돼요.</li>
        </ul>
        <p className="help-tip">직원이 다른 repo로 착각하지 않도록 dispatch task에는 현재 repo 절대경로를 함께 넣는 게 원칙이에요.</p>
    </>
);

const ProcessLifecycleHelp = (
    <>
        <p className="help-lead">Process 상태는 인스턴스 실행과 Manager가 관리하는 preview/runtime 상태를 구분해서 봐야 해요.</p>
        <ul className="help-bullets">
            <li><strong>online</strong>은 인스턴스 health check가 통과한 상태예요.</li>
            <li><strong>offline / timeout / error</strong>는 프로세스가 없거나, 응답이 늦거나, health check가 실패한 상태예요.</li>
            <li><strong>managed</strong>는 Manager가 띄우거나 복구 대상으로 추적하는 서버예요.</li>
            <li>탭 전환 후 Preview가 다시 붙을 수 있지만, 인스턴스의 실제 실행 여부는 health/status 쪽을 기준으로 보세요.</li>
        </ul>
        <p className="help-tip">Process UI가 비어 보이면 먼저 Refresh로 registry와 health 상태를 다시 읽어보세요.</p>
    </>
);

const DangerousActionsHelp = (
    <>
        <p className="help-lead">실행 상태를 바꾸는 버튼은 현재 선택한 인스턴스나 Manager-managed 프로세스에 영향을 줘요.</p>
        <ul className="help-bullets">
            <li><strong>Stop</strong>은 대상 인스턴스를 중지해요. service-owned 인스턴스는 persistent service 제거까지 포함될 수 있어요.</li>
            <li><strong>Restart</strong>는 새 실행으로 바뀌므로 uptime과 elapsed time 판단 기준이 다시 시작돼요.</li>
            <li><strong>Stop all managed</strong>는 Manager가 추적 중인 서버들을 한 번에 중지해요. 외부에서 직접 띄운 프로세스는 대상으로 삼지 않아요.</li>
            <li><strong>Adopt/recover</strong>는 남아 있는 managed process 기록을 다시 연결하려는 복구 작업이에요.</li>
        </ul>
        <p className="help-tip">위험 작업은 가능한 한 확인창을 거치며, 진행 후 상태가 애매하면 Refresh로 실제 health를 확인하세요.</p>
    </>
);

export const DASHBOARD_HELP_TOPIC_IDS: HelpTopicId[] = [
    'instances',
    'board',
    'schedule',
    'reminders',
    'notes',
    'settings',
    'shortcuts',
    'routing',
    'processLifecycle',
    'dangerousActions',
];

export const HELP_CONTENT: Record<HelpTopicId, HelpEntry> = {
    instances: { title: 'Instances', subtitle: '인스턴스 운영', body: InstancesHelp },
    board: { title: 'Board', subtitle: 'Cross-instance Kanban', body: BoardHelp },
    schedule: { title: 'Schedule', subtitle: '시간 기반 작업', body: ScheduleHelp },
    reminders: { title: 'Reminders', subtitle: 'Jaw Reminders mirror', body: RemindersHelp },
    notes: { title: 'Notes', subtitle: '마크다운 노트', body: NotesHelp },
    settings: { title: 'Settings', subtitle: '대시보드 설정', body: SettingsHelp },
    shortcuts: { title: 'Shortcuts', subtitle: '전역 키보드 도움말', body: ShortcutsHelp },
    routing: { title: 'Routing', subtitle: 'Boss / Employee 작업 흐름', body: RoutingHelp },
    processLifecycle: { title: 'Process lifecycle', subtitle: '인스턴스와 managed process 상태', body: ProcessLifecycleHelp },
    dangerousActions: { title: 'Dangerous actions', subtitle: '중지·재시작·복구 작업 영향', body: DangerousActionsHelp },
};
