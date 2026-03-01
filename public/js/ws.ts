// ── WebSocket Connection ──
import { state } from './state.js';
import { setStatus, updateQueueBadge, addSystemMsg, appendAgentText, finalizeAgent, addMessage } from './ui.js';
import { t, getLang } from './features/i18n.js';
import type { OrcStateName } from './state.js';

interface WsMessage {
    type: string;
    running?: boolean;
    status?: string;
    agentId?: string;
    phase?: string;
    phaseLabel?: string;
    pending?: number;
    path?: string;
    round?: number;
    agentPhases?: { agent?: string; name?: string }[];
    subtasks?: { agent?: string; name?: string }[];
    action?: string;
    icon?: string;
    label?: string;
    text?: string;
    toolLog?: { icon: string; label: string }[];
    from?: string;
    to?: string;
    source?: string;
    role?: string;
    content?: string;
    cli?: string;
    delay?: number;
    state?: string;
    title?: string;
}

// Agent phase state (populated by agent_status events from orchestrator)
const agentPhaseState: Record<string, { phase: string; phaseLabel: string }> = {};

export function connect(): void {
    state.ws = new WebSocket(`ws://${location.host}?lang=${getLang()}`);
    state.ws.onmessage = (e: MessageEvent) => {
        const msg: WsMessage = JSON.parse(e.data as string);
        if (msg.type === 'agent_status') {
            if (msg.running !== undefined) {
                setStatus(msg.running ? 'running' : 'idle');
            } else {
                setStatus(msg.status || 'idle');
            }
            // Track per-agent phase for badge rendering
            if (msg.agentId && msg.phase) {
                agentPhaseState[msg.agentId] = { phase: msg.phase, phaseLabel: msg.phaseLabel || '' };
                import('./features/employees.js').then(m => m.loadEmployees());
            }
        } else if (msg.type === 'queue_update') {
            updateQueueBadge(msg.pending || 0);
        } else if (msg.type === 'worklog_created') {
            addSystemMsg(`📋 Worklog: ${msg.path || ''}`);
        } else if (msg.type === 'round_start') {
            const agents = (msg.agentPhases || msg.subtasks || []);
            const names = agents.map(a => a.agent || a.name || '').join(', ');
            addSystemMsg(t('ws.roundStart', { round: msg.round || 0, count: agents.length, names }));
        } else if (msg.type === 'round_done') {
            if (msg.action === 'complete') {
                addSystemMsg(t('ws.roundDone', { round: msg.round || 0 }));
            } else if (msg.action === 'next') {
                addSystemMsg(t('ws.roundNext', { round: msg.round || 0 }));
            } else {
                addSystemMsg(t('ws.roundRetry', { round: msg.round || 0 }));
            }
        } else if (msg.type === 'agent_tool') {
            addSystemMsg(`${msg.icon || ''} ${msg.label || ''}`, 'tool-activity');
        } else if (msg.type === 'agent_output') {
            appendAgentText(msg.text || '');
        } else if (msg.type === 'agent_retry') {
            addSystemMsg(t('ws.retry', { cli: msg.cli || '', delay: msg.delay || 10 }), 'tool-activity');
        } else if (msg.type === 'agent_fallback') {
            addSystemMsg(t('ws.fallback', { from: msg.from || '', to: msg.to || '' }), 'tool-activity');
        } else if (msg.type === 'agent_done') {
            finalizeAgent(msg.text || '', msg.toolLog);
        } else if (msg.type === 'orchestrate_done') {
            finalizeAgent(msg.text || '');
        } else if (msg.type === 'clear') {
            const el = document.getElementById('chatMessages');
            if (el) el.innerHTML = '';
        } else if (msg.type === 'agent_added' || msg.type === 'agent_updated' || msg.type === 'agent_deleted') {
            import('./features/employees.js').then(m => m.loadEmployees());
        } else if (msg.type === 'orc_state') {
            const allowed = new Set<OrcStateName>(['IDLE', 'P', 'A', 'B', 'C', 'D']);
            const rawState = typeof msg.state === 'string' ? msg.state : 'IDLE';
            const nextState = allowed.has(rawState as OrcStateName) ? (rawState as OrcStateName) : 'IDLE';
            state.orcState = nextState;

            if (nextState === 'IDLE' || nextState === 'D') {
                document.body.removeAttribute('data-orc-state');
                document.body.style.removeProperty('--orc-glow');
            } else {
                document.body.setAttribute('data-orc-state', nextState);
                const glowVar = `--orc-glow-${nextState}`;
                const glow = getComputedStyle(document.documentElement).getPropertyValue(glowVar).trim();
                document.body.style.setProperty('--orc-glow', glow);
            }

            document.body.classList.add('orc-pulse');
            setTimeout(() => document.body.classList.remove('orc-pulse'), 700);

            const badge = document.getElementById('orcStateBadge');
            if (badge) {
                const labels: Record<OrcStateName, string> = {
                    IDLE: '',
                    P: 'PLAN',
                    A: 'AUDIT',
                    B: 'BUILD',
                    C: 'CHECK',
                    D: 'DONE',
                };
                badge.textContent = labels[nextState];
                badge.style.display = nextState === 'IDLE' ? 'none' : 'inline-block';
            }

            // ─── Roadmap Bar ───
            const PHASES = ['P', 'A', 'B', 'C'] as const;
            const roadmap = document.getElementById('pabcRoadmap');
            const shark = document.getElementById('sharkRunner');
            const brand = document.getElementById('pabcBrand');

            if (roadmap && shark) {
                if (nextState === 'IDLE') {
                    roadmap.classList.remove('visible', 'shimmer-out');
                    shark.classList.remove('running');
                } else if (nextState === 'D') {
                    // All dots done + shimmer out
                    PHASES.forEach(p => {
                        const dot = document.getElementById(`dot-${p}`);
                        if (dot) { dot.className = 'pabc-dot done'; dot.setAttribute('data-phase', p); }
                    });
                    for (let i = 0; i < 4; i++) {
                        const c = document.getElementById(`pabc-conn-${i}`);
                        if (c) c.className = 'pabc-connector done';
                    }
                    shark.classList.remove('running');
                    roadmap.classList.add('shimmer-out');
                    setTimeout(() => roadmap.classList.remove('visible', 'shimmer-out'), 1000);
                } else {
                    roadmap.classList.remove('shimmer-out');
                    roadmap.classList.add('visible');
                    shark.classList.add('running');

                    // Update dots & connectors
                    const idx = PHASES.indexOf(nextState as typeof PHASES[number]);
                    PHASES.forEach((p, pi) => {
                        const dot = document.getElementById(`dot-${p}`);
                        if (dot) {
                            dot.className = `pabc-dot ${pi < idx ? 'done' : pi === idx ? 'active' : 'future'}`;
                            dot.setAttribute('data-phase', p);
                        }
                    });
                    for (let i = 0; i < 4; i++) {
                        const c = document.getElementById(`pabc-conn-${i}`);
                        if (c) c.className = `pabc-connector ${i < idx ? 'done' : ''}`;
                    }

                    // Move shark along connector
                    requestAnimationFrame(() => {
                        const barRect = roadmap.getBoundingClientRect();
                        const activeDot = document.getElementById(`dot-${nextState}`);
                        if (!activeDot) return;
                        const conn = document.getElementById(`pabc-conn-${idx}`);
                        if (conn && nextState !== 'C') {
                            const connRect = conn.getBoundingClientRect();
                            shark.style.left = ((connRect.left - barRect.left) + (connRect.width * 0.4) - 18) + 'px';
                        } else {
                            const dotRect = activeDot.getBoundingClientRect();
                            shark.style.left = ((dotRect.left - barRect.left) + (dotRect.width / 2) - 18) + 'px';
                        }
                    });
                }

                // Update brand text with worklog title
                if (brand && msg.title) {
                    brand.textContent = msg.title;
                }
            }
        } else if (msg.type === 'new_message' && msg.source === 'telegram') {
            addMessage(msg.role === 'assistant' ? 'agent' : (msg.role || 'user'), msg.content || '');
        }
    };
    state.ws.onopen = () => {
        console.log('[ws] connected');
        // Restore state: reload messages to stay in sync after reconnect
        import('./ui.js').then(m => {
            const el = document.getElementById('chatMessages');
            if (el) el.innerHTML = '';
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

export function getAgentPhase(agentId: string): { phase: string; phaseLabel: string } | null {
    return agentPhaseState[agentId] || null;
}
