// ── WebSocket Connection ──
import { state } from './state.js';
import { setStatus, updateQueueBadge, addSystemMsg, appendAgentText, finalizeAgent, addMessage } from './ui.js';

export function connect() {
    state.ws = new WebSocket(`ws://${location.host}`);
    state.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'agent_status') {
            if (msg.running !== undefined) {
                setStatus(msg.running ? 'running' : 'idle');
            } else {
                setStatus(msg.status);
            }
        } else if (msg.type === 'queue_update') {
            updateQueueBadge(msg.pending || 0);
        } else if (msg.type === 'worklog_created') {
            addSystemMsg(`📋 Worklog: ${msg.path}`);
        } else if (msg.type === 'round_start') {
            const agents = (msg.agentPhases || msg.subtasks || []);
            const names = agents.map(a => a.agent || a.name).join(', ');
            addSystemMsg(`🔄 라운드 ${msg.round} — ${agents.length}개 작업 [${names}]`);
        } else if (msg.type === 'round_done') {
            if (msg.action === 'complete') {
                addSystemMsg(`🏁 라운드 ${msg.round} 완료`);
            } else if (msg.action === 'next') {
                addSystemMsg(`➡️ 라운드 ${msg.round} → 다음 라운드`);
            } else {
                addSystemMsg(`↩️ 라운드 ${msg.round} → 재시도`);
            }
        } else if (msg.type === 'agent_tool') {
            addSystemMsg(`${msg.icon} ${msg.label}`, 'tool-activity');
        } else if (msg.type === 'agent_output') {
            appendAgentText(msg.text);
        } else if (msg.type === 'agent_fallback') {
            addSystemMsg(`⚡ ${msg.from} 실패 → ${msg.to}로 재시도`, 'tool-activity');
        } else if (msg.type === 'agent_done') {
            finalizeAgent(msg.text, msg.toolLog);
        } else if (msg.type === 'clear') {
            document.getElementById('chatMessages').innerHTML = '';
        } else if (msg.type === 'agent_added' || msg.type === 'agent_updated' || msg.type === 'agent_deleted') {
            import('./features/employees.js').then(m => m.loadEmployees());
        } else if (msg.type === 'new_message' && msg.source === 'telegram') {
            addMessage(msg.role === 'assistant' ? 'agent' : msg.role, msg.content);
        }
    };
    state.ws.onclose = () => setTimeout(connect, 2000);
}
