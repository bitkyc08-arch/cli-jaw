// ── WebSocket Connection ──
import { state } from './state.js';
import { setStatus, updateQueueBadge, addSystemMsg, appendAgentText, finalizeAgent, addMessage } from './ui.js';
import { t, getLang } from './features/i18n.js';

// Agent phase state (populated by agent_status events from orchestrator)
const agentPhaseState = {};

export function connect() {
    state.ws = new WebSocket(`ws://${location.host}?lang=${getLang()}`);
    state.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'agent_status') {
            if (msg.running !== undefined) {
                setStatus(msg.running ? 'running' : 'idle');
            } else {
                setStatus(msg.status);
            }
            // Track per-agent phase for badge rendering
            if (msg.agentId && msg.phase) {
                agentPhaseState[msg.agentId] = { phase: msg.phase, phaseLabel: msg.phaseLabel || '' };
                import('./features/employees.js').then(m => m.loadEmployees());
            }
        } else if (msg.type === 'queue_update') {
            updateQueueBadge(msg.pending || 0);
        } else if (msg.type === 'worklog_created') {
            addSystemMsg(`📋 Worklog: ${msg.path}`);
        } else if (msg.type === 'round_start') {
            const agents = (msg.agentPhases || msg.subtasks || []);
            const names = agents.map(a => a.agent || a.name).join(', ');
            addSystemMsg(t('ws.roundStart', { round: msg.round, count: agents.length, names }));
        } else if (msg.type === 'round_done') {
            if (msg.action === 'complete') {
                addSystemMsg(t('ws.roundDone', { round: msg.round }));
            } else if (msg.action === 'next') {
                addSystemMsg(t('ws.roundNext', { round: msg.round }));
            } else {
                addSystemMsg(t('ws.roundRetry', { round: msg.round }));
            }
        } else if (msg.type === 'agent_tool') {
            addSystemMsg(`${msg.icon} ${msg.label}`, 'tool-activity');
        } else if (msg.type === 'agent_output') {
            appendAgentText(msg.text);
        } else if (msg.type === 'agent_fallback') {
            addSystemMsg(t('ws.fallback', { from: msg.from, to: msg.to }), 'tool-activity');
        } else if (msg.type === 'agent_done') {
            finalizeAgent(msg.text, msg.toolLog);
        } else if (msg.type === 'orchestrate_done') {
            finalizeAgent(msg.text);
        } else if (msg.type === 'clear') {
            document.getElementById('chatMessages').innerHTML = '';
        } else if (msg.type === 'agent_added' || msg.type === 'agent_updated' || msg.type === 'agent_deleted') {
            import('./features/employees.js').then(m => m.loadEmployees());
        } else if (msg.type === 'new_message' && msg.source === 'telegram') {
            addMessage(msg.role === 'assistant' ? 'agent' : msg.role, msg.content);
        }
    };
    state.ws.onopen = () => {
        console.log('[ws] connected');
        // Restore state: reload messages to stay in sync after reconnect
        import('./ui.js').then(m => {
            document.getElementById('chatMessages').innerHTML = '';
            m.loadMessages();
            m.setStatus('idle');
        });
    };
    state.ws.onclose = () => {
        console.log('[ws] disconnected, reconnecting in 2s...');
        setStatus('idle');
        setTimeout(connect, 2000);
    };
}

export function getAgentPhase(agentId) {
    return agentPhaseState[agentId] || null;
}
