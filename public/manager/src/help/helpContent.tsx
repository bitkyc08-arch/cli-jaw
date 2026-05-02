import type { ReactNode } from 'react';
import type { DashboardSidebarMode } from '../types';

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
        </ul>
        <p className="help-tip">💡 인스턴스가 안 보이시면 터미널에서 <code>cli-jaw start</code>로 새 jaw를 띄워보세요 — 자동으로 목록에 떠요.</p>
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
        <p className="help-tip">💡 인스턴스가 없어도 일반 칸반 블럭은 계속 남아요. 그래서 쿼리·아이디어·작업 단위를 먼저 적고, 필요할 때만 실행 인스턴스를 붙이면 돼요.</p>
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
        <p className="help-tip">💡 새 작업은 여기서 만들고, 기존 heartbeat job은 같은 cron으로 옮겨 등록하시면 돼요. (마이그레이션 자동화는 추후 추가)</p>
    </>
);

const NotesHelp = (
    <>
        <p className="help-lead"><code>~/.cli-jaw-dashboard/notes/</code>의 마크다운 파일을 직접 편집하는 노트장이에요.</p>
        <ul className="help-bullets">
            <li>좌측 트리에서 파일 선택, 우측에서 <strong>Raw / Preview / WYSIWYG</strong> 모드로 편집하실 수 있어요.</li>
            <li><kbd>⌘/Ctrl + S</kbd>로 저장, <kbd>⌘/Ctrl + E</kbd>로 모드 순환 전환이에요.</li>
            <li>파일이 외부에서 바뀌면 충돌 알림이 떠요 — Reload / Overwrite / Keep local 중 선택하세요.</li>
        </ul>
        <p className="help-tip">💡 좌측 트리 상단 <strong>+ New</strong>로 첫 노트를 만들어 보세요. 폴더는 <code>folder/note.md</code> 처럼 한 번에 만드실 수 있어요.</p>
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
        <p className="help-tip">💡 인스턴스 동작을 바꾸시려면 여기가 아니라 <strong>Instances → 해당 인스턴스 → Settings 탭</strong>으로 가세요.</p>
    </>
);

export const HELP_CONTENT: Record<DashboardSidebarMode, HelpEntry> = {
    instances: { title: 'Instances', subtitle: '인스턴스 운영', body: InstancesHelp },
    board: { title: 'Board', subtitle: 'Cross-instance Kanban', body: BoardHelp },
    schedule: { title: 'Schedule', subtitle: '시간 기반 작업', body: ScheduleHelp },
    notes: { title: 'Notes', subtitle: '마크다운 노트', body: NotesHelp },
    settings: { title: 'Settings', subtitle: '대시보드 설정', body: SettingsHelp },
};
