import { broadcast } from '../core/bus.js';

export function isJawRuntimeEvent(raw: unknown): boolean {
    return typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>)['type'] === 'jaw_runtime';
}

export function handleJawRuntimeEvent(event: Record<string, unknown>, _agentLabel: string): void {
    const eventName = String(event['event'] || '');
    const runId = String(event['run_id'] || '');
    const seq = Number(event['seq'] || 0);

    // Internal runtime traces — 'internal' keeps them off WS clients and the
    // SSE dual-emit path.
    switch (eventName) {
        case 'runtime_started':
            broadcast('agent:claude-e:runtime_started', { runId, seq, version: event['helperVersion'] }, 'internal');
            break;
        case 'claude_spawned':
            broadcast('agent:claude-e:spawned', { runId, pid: event['pid'] }, 'internal');
            break;
        case 'session_started':
            broadcast('agent:claude-e:session', { runId, sessionId: event['sessionId'], transcriptPath: event['transcriptPath'] }, 'internal');
            break;
        case 'prompt_injected':
            broadcast('agent:claude-e:prompt_injected', { runId }, 'internal');
            break;
        case 'stop_received':
            broadcast('agent:claude-e:stop', { runId, transcriptPath: event['transcriptPath'] }, 'internal');
            break;
        case 'stop_failure':
            broadcast('agent:claude-e:stop_failure', { runId, error: event['error'] }, 'internal');
            break;
        case 'interrupted':
            broadcast('agent:claude-e:interrupted', { runId, sessionId: event['sessionId'], resumable: event['resumable'] }, 'internal');
            break;
        case 'cleanup_started':
        case 'cleanup_done':
            broadcast('agent:claude-e:cleanup', { runId, event: eventName, escalated: event['escalated'] }, 'internal');
            break;
        case 'error':
            broadcast('agent:claude-e:error', { runId, message: event['message'], exitCode: event['exitCode'] }, 'internal');
            break;
        default:
            break;
    }
}
