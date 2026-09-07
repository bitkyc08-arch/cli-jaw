/**
 * TUI WebSocket message handler.
 */
import type WebSocket from 'ws';
import {
    startAssistantItem, appendAssistantTurnText,
    finalizeAssistant, finalizeStreamingAssistants, assistantTextSinceLastUser, replaceNativeAssistantFinal,
    appendStatusItem, appendToolItem, clearEphemeralStatus, appendThinkingTurnText, appendThinkingItem,
    upsertLiveToolItem, commitToolItemOnce, commitThinkingItemOnce, commitRemainingLiveToolItems,
    resetTurnToolDedup,
    isThinkingToolEvent,
} from '../../../src/cli/tui/transcript.js';
import type { TranscriptItem } from '../../../src/cli/tui/transcript.js';
import { captureFileSet, diffFileSets, getDiffStat, getUnifiedDiff, getIdeCli, openDiffInIde } from '../../../src/ide/diff.js';
import { createStreamSink } from '../../../src/cli/tui/stream.js';
import { renderMarkdown } from '../../../src/cli/tui/markdown.js';
import { renderMarkdownJawcode, isInitialized } from '../../../src/cli/tui/jawcode-render.js';
import { renderToolLine } from '../../../src/cli/tui/jawcode-bridge.js';
import { colorizeDiff } from '../../../src/cli/tui/diffview.js';
import { normalizeTuiWsEvent } from '../../../src/cli/tui/events.js';
import { c, type TuiContext } from './types.js';
import { openPromptBlock, rebuildFooter } from './renderer.js';
import { dismissOverlay, openBgtaskOverlay } from './overlays.js';
import { startSpinner, stopSpinner } from '../../../src/cli/tui/spinner.js';
import { refreshInfo } from './api.js';
import { handleActivityRuntime, activityForCompatibility, settleActivityCompatibility, markActivityGap, admitsCompatibility } from './activity-handler.js';
import { handleActivityFallbackOutput } from './activity-fallback.js';
import { safeActivityTerminalText } from '../../../src/cli/tui/activity-terminal-text.js';
import { activityKey } from '../../../src/shared/activity-state.js';
import { invalidateActivityContext } from './activity-replay.js';
import { refreshActivityIdentity } from './api.js';

function isFullscreen(ctx: TuiContext): boolean {
    return ctx.displayMode === 'fullscreen';
}


function appendFullscreenStatus(ctx: TuiContext, text: string): void {
    appendStatusItem(ctx.store.transcript, text.replace(/\s+/g, ' ').trim());
    ctx.requestFrame?.();
}

function startFooterTimer(ctx: TuiContext): void {
    if (ctx.footerTimer) return;
    ctx.footerTimer = setInterval(() => {
        if (ctx.streamState === 'idle') {
            stopFooterTimer(ctx);
            return;
        }
        rebuildFooter(ctx);
        if (isFullscreen(ctx)) ctx.requestFrame?.();
    }, 120);
}

function ensureTurnClock(ctx: TuiContext, state: 'responding' | 'tool'): void {
    if (!ctx.streaming) {
        ctx.streaming = true;
        ctx.turnStartedAt = Date.now();
    }
    ctx.streamState = state;
    rebuildFooter(ctx);
    startFooterTimer(ctx);
}

function stopFooterTimer(ctx: TuiContext): void {
    if (!ctx.footerTimer) return;
    clearInterval(ctx.footerTimer);
    ctx.footerTimer = null;
}

// The two compatibility terminal sources can report the same native run. Keep this
// display receipt bounded and separate from provider/session/lifecycle ownership.
const nativeTerminalReceipts = new WeakMap<TuiContext, {
    runs: string[]; items: TranscriptItem[]; length: number; tail: TranscriptItem | undefined;
}>();

export function handleWsMessage(ctx: TuiContext, data: WebSocket.Data): void {
    const raw = data.toString();
    const ov = ctx.store.overlay;
    const transcript = ctx.store.transcript;
    try {
        const wire = JSON.parse(raw);
        if (wire && typeof wire === 'object'
            && ['agent_chunk', 'agent_output', 'agent_tool', 'agent_status', 'agent_done', 'orchestrate_done'].includes(wire.type)
            && !admitsCompatibility(ctx, wire)) return;
        // Interactive raw retains its existing frame printer. Piped raw is owned
        // by raw-pipe-mode and never enters the presentation normalizer.
        if (ctx.isRaw && (wire?.type === 'agent_runtime' || wire?.type === 'agent_runtime_gap')) {
            console.log(`  ${c.dim}${raw}${c.reset}`);
            return;
        }
        const nativeFinality = wire?.runtimeFinality === 'present' || wire?.runtimeFinality === 'absent';
        const nativeOrchestrateDone = !ctx.isRaw && nativeFinality && wire?.type === 'orchestrate_done';
        const event = normalizeTuiWsEvent(nativeOrchestrateDone ? { ...wire, type: 'agent_done' } : wire);
        const mirroredActivity = event.kind === 'assistant-output' || event.kind === 'agent-tool' || event.kind === 'agent-status'
            ? activityForCompatibility(ctx, wire) : undefined;
        const projection = event.kind === 'assistant-output' || event.kind === 'agent-tool' || event.kind === 'agent-status' || event.kind === 'agent-done';
        const knownRun = projection && !ctx.isRaw && typeof wire?.traceRunId === 'string' ? transcript.items.find(item =>
            item.type === 'activity' && item.model.identity.runId === wire.traceRunId) : undefined;
        if (knownRun?.type === 'activity' && (knownRun.retired || !activityForCompatibility(ctx, wire))) return;
        if (mirroredActivity && (mirroredActivity.terminalStatus || !mirroredActivity.degraded)) return;
        // Old fallback mirrors have no ownership of the current run's global
        // clock or tool lane. Scoped answer/thinking previews remain admissible.
        if (mirroredActivity && ctx.activeActivityKey && ctx.activeActivityKey !== mirroredActivity.key
            && (event.kind === 'agent-status' || (event.kind === 'agent-tool' && !isThinkingToolEvent(event)))) return;
        if (mirroredActivity && event.kind === 'agent-tool' && !isThinkingToolEvent(event)) {
            event.label = safeActivityTerminalText(event.label);
            event.detail = safeActivityTerminalText(event.detail);
            event.icon = safeActivityTerminalText(event.icon);
        }
        switch (event.kind) {
            case 'runtime':
                if (handleActivityRuntime(ctx, event.event) && event.event.kind !== 'turn-end'
                    && ctx.activeActivityKey === activityKey(event.event)) {
                    clearEphemeralStatus(transcript);
                    ensureTurnClock(ctx, event.event.kind === 'tool' ? 'tool' : 'responding');
                }
                break;
            case 'runtime-gap':
                markActivityGap(ctx, event);
                break;
            case 'runtime-invalid':
                markActivityGap(ctx, { sessionId: event.raw['sessionId'], scope: event.raw['scope'], runId: event.raw['runId'] });
                break;
            case 'assistant-output':
                if (mirroredActivity) {
                    handleActivityFallbackOutput(ctx, mirroredActivity, event.text, {
                        thinking: event.thinking, ...(event.agentId ? { agentId: event.agentId } : {}),
                    });
                    if (ctx.activeActivityKey === mirroredActivity.key) ensureTurnClock(ctx, 'responding');
                    break;
                }
                if (ov.helpOpen || ov.paletteOpen || ov.bgtaskOpen) dismissOverlay(ctx);
                if (ctx.isRaw) {
                    console.log(`  ${c.dim}${raw}${c.reset}`);
                    break;
                }
                clearEphemeralStatus(transcript);
                const isThinkingDelta = event.thinking;
                if (!ctx.streaming) {
                    ctx.streaming = true;
                    ctx.streamState = 'responding';
                    ctx.turnStartedAt = Date.now();
                    rebuildFooter(ctx); // safe point: before the first chunk is written
                    startFooterTimer(ctx);
                    if (!isThinkingDelta) startAssistantItem(transcript, event.agentId);
                } else if (ctx.streamState === 'tool') {
                    ctx.streamState = 'responding';
                    rebuildFooter(ctx);
                }
                if (isThinkingDelta) {
                    appendThinkingTurnText(transcript, event.text, event.agentId);
                    if (isFullscreen(ctx)) ctx.requestFrame?.();
                    break;
                }
                // Thinking can start the turn clock without starting an answer.
                // Initialize its line sink independently, once, on the first answer chunk.
                if (!isFullscreen(ctx) && !ctx.streamSink) {
                    process.stdout.write('\n');
                    ctx.streamSink = createStreamSink({
                        write: (s) => process.stdout.write(s),
                        width: Math.max(20, (process.stdout.columns || 80) - 4),
                        gutter: '  ',
                    });
                }
                appendAssistantTurnText(transcript, event.text, event.agentId);
                if (ctx.streamSink) {
                    ctx.streamSink.push(event.text);
                } else if (isFullscreen(ctx)) {
                    ctx.requestFrame?.();
                }
                break;

            case 'agent-done': {
                const nativeFinal = nativeFinality && !ctx.isRaw;
                const runId = typeof event.raw['traceRunId'] === 'string' ? event.raw['traceRunId'] : '';
                const receipt = nativeTerminalReceipts.get(ctx);
                const activity = activityForCompatibility(ctx, event.raw);
                if (activity?.compatibilityDone) break;
                const semanticFinal = settleActivityCompatibility(ctx, event.raw);
                const active = transcript.items.find(row => row.type === 'activity' && row.key === ctx.activeActivityKey);
                const activeRunId = active?.type === 'activity' && !active.terminalStatus
                    ? active.model.identity.runId : ctx.activityActiveRunId;
                if (runId && ctx.streaming && activeRunId && activeRunId !== runId) break;
                // A delayed terminal can finish its own history without closing
                // a newer run's composer, clocks or IDE lifecycle.
                if (semanticFinal && activity && ctx.activeActivityKey && ctx.activeActivityKey !== activity.key) {
                    activity.compatibilityDone = true;
                    break;
                }
                if (nativeOrchestrateDone) delete ctx.orchPhase;
                if (nativeFinal && receipt && (runId ? receipt.runs.includes(runId)
                    : !ctx.streaming && receipt.items === transcript.items && receipt.length === transcript.items.length
                        && receipt.tail === transcript.items.at(-1))) break;
                const hadNativePreview = nativeFinal && assistantTextSinceLastUser(transcript).length > 0;
                // Final tool-log commits can settle a streaming assistant. Remove its
                // provisional content BEFORE those commits, then append the final below.
                if (nativeFinal) replaceNativeAssistantFinal(transcript, '');
                stopSpinner();
                clearEphemeralStatus(transcript);
                const activityFallback = activity?.recordingGap || activity?.displayGap;
                for (const rawTool of semanticFinal && !activityFallback ? [] : event.toolLog) {
                    const tool = semanticFinal ? { ...rawTool, icon: safeActivityTerminalText(rawTool.icon),
                        label: safeActivityTerminalText(rawTool.label), detail: safeActivityTerminalText(rawTool.detail) } : rawTool;
                    if (isThinkingToolEvent(tool)) {
                        commitThinkingItemOnce(transcript, tool, { updateCommitted: true });
                    } else {
                        commitToolItemOnce(transcript, tool, { updateCommitted: true });
                    }
                }
                if (!semanticFinal || activityFallback) commitRemainingLiveToolItems(transcript, event.raw['error'] ? 'error' : 'done');
                resetTurnToolDedup(transcript);
                if (ctx.isRaw) {
                    console.log(`  ${c.dim}${raw}${c.reset}`);
                } else if (semanticFinal) {
                    ctx.streamSink = null;
                } else if (nativeFinal) {
                    ctx.streamSink = null; // never flush a provisional buffer as final
                    replaceNativeAssistantFinal(transcript, event.text, event.agentId);
                    if (!isFullscreen(ctx)) {
                        if (!event.text && hadNativePreview) {
                            process.stdout.write(event.raw['runtimeFinality'] === 'absent'
                                ? '\n[Previous output was provisional; no final answer was returned.]\n'
                                : '\n[Previous output was provisional; the final answer is empty.]\n');
                        } else if (event.text) {
                            process.stdout.write('\nFinal answer:\n');
                            const width = Math.max(20, (process.stdout.columns || 80) - 4);
                            process.stdout.write(isInitialized()
                                ? renderMarkdownJawcode(event.text, width).join('\n') + '\n'
                                : renderMarkdown(event.text, { width, gutter: '  ' }));
                        }
                    }
                } else if (ctx.streaming) {
                    ctx.streamSink?.end();
                    ctx.streamSink = null;
                    if (event.text) {
                        const existingText = assistantTextSinceLastUser(transcript);
                        if (!existingText) {
                            appendAssistantTurnText(transcript, event.text, event.agentId);
                        } else if (event.text.startsWith(existingText) && event.text.length > existingText.length) {
                            appendAssistantTurnText(transcript, event.text.slice(existingText.length), event.agentId);
                        } else if (!event.text.startsWith(existingText) && !existingText.includes(event.text.trim())) {
                            // 260703 CJ-WP3: the server final is canonical. A
                            // reordered/renormalized final was silently DROPPED
                            // (prefix-only reconciliation) — losing the answer
                            // tail. Append the full final instead; bounded
                            // redundancy beats silent loss.
                            appendAssistantTurnText(transcript, `\n${event.text}`, event.agentId);
                            if (!isFullscreen(ctx)) {
                                // Classic mode streams to stdout directly — the
                                // transcript append alone would be invisible.
                                process.stdout.write(`\n${event.text}\n`);
                            }
                        }
                    }
                    finalizeStreamingAssistants(transcript);
                    if (!isFullscreen(ctx)) console.log('');
                } else if (event.text) {
                    startAssistantItem(transcript, event.agentId);
                    appendAssistantTurnText(transcript, event.text, event.agentId);
                    finalizeAssistant(transcript);
                    if (!isFullscreen(ctx)) {
                        process.stdout.write('\n');
                        if (isInitialized()) {
                            const mdLines = renderMarkdownJawcode(event.text, Math.max(20, (process.stdout.columns || 80) - 4));
                            process.stdout.write(mdLines.join('\n') + '\n');
                        } else {
                            process.stdout.write(renderMarkdown(event.text, { width: Math.max(20, (process.stdout.columns || 80) - 4), gutter: '  ' }));
                        }
                        console.log('');
                    }
                }
                // IDE diff
                if (ctx.isGit && ctx.preFileSetQueue.length > 0) {
                    const preSet = ctx.preFileSetQueue.shift()!;
                    if (ctx.ideEnabled) {
                        const postSet = captureFileSet(ctx.chatCwd);
                        const changed = diffFileSets(preSet, postSet);
                        if (changed.length > 0) {
                            const stat = getDiffStat(ctx.chatCwd, changed);
                            if (isFullscreen(ctx)) {
                                appendToolItem(transcript, `${changed.length} files changed`);
                                if (stat) appendToolItem(transcript, stat);
                            } else {
                                console.log(`\n  ${c.cyan}\uD83D\uDCC2 ${changed.length}\uAC1C \uD30C\uC77C \uBCC0\uACBD\uB428${c.reset}`);
                                if (stat) console.log(`  ${stat}`);
                                else for (const f of changed.slice(0, 10)) console.log(`  ${c.dim}  \u25E6 ${f}${c.reset}`);
                                if (changed.length > 10) console.log(`  ${c.dim}  ... +${changed.length - 10}\uAC1C${c.reset}`);
                                const colored = colorizeDiff(getUnifiedDiff(ctx.chatCwd, changed), { maxLines: 40, gutter: '  ' });
                                if (colored) console.log(colored);
                            }
                            if (ctx.idePopEnabled && ctx.detectedIde) {
                                if (!isFullscreen(ctx)) {
                                    console.log(`  ${c.dim}\u2192 ${getIdeCli(ctx.detectedIde)}\uC5D0\uC11C diff \uC5F4\uAE30${c.reset}`);
                                }
                                openDiffInIde(ctx.chatCwd, changed, ctx.detectedIde);
                            }
                        }
                    }
                }
                ctx.streaming = false;
                ctx.streamState = 'idle';
                stopFooterTimer(ctx);
                rebuildFooter(ctx); // safe point: turn finished, before reopening the prompt
                ctx.inputActive = true;
                if (ctx.activityActiveRunId === runId) ctx.activityActiveRunId = null;
                openPromptBlock(ctx);
                if (semanticFinal && activity) activity.compatibilityDone = true;
                if (nativeFinal) {
                    const runs = receipt?.runs ?? [];
                    if (runId) { runs.push(runId); if (runs.length > 8) runs.shift(); }
                    nativeTerminalReceipts.set(ctx, { runs, items: transcript.items,
                        length: transcript.items.length, tail: transcript.items.at(-1) });
                }
                break;
            }

            case 'agent-status':
                if (event.status === 'done') break;
                if (ctx.isRaw) {
                    console.log(`  ${c.dim}${raw}${c.reset}`);
                } else if (event.status === 'running') {
                    ensureTurnClock(ctx, 'responding');
                    const name = event.agentName || event.agentId || 'agent';
                    if (!isFullscreen(ctx)) {
                        appendStatusItem(transcript, `${name} thinking\u2026`);
                        startSpinner((ch) => {
                            process.stdout.write(`\r  ${c.dim}${ch} ${name} thinking\u2026${c.reset}          \r`);
                        });
                        process.stdout.write(`\r  ${c.dim}\u25CC ${name} thinking\u2026${c.reset}          \r`);
                    } else {
                        ctx.requestFrame?.();
                    }
                }
                break;

            case 'agent-tool':
                if (mirroredActivity && isThinkingToolEvent(event)) {
                    handleActivityFallbackOutput(ctx, mirroredActivity, event.detail || event.label, {
                        thinking: true, replace: true, ...(event.agentId ? { agentId: event.agentId } : {}),
                        ...(event.stepRef ? { stepRef: event.stepRef } : {}),
                    });
                    if (ctx.activeActivityKey === mirroredActivity.key) ensureTurnClock(ctx, 'responding');
                    break;
                }
                if (ctx.isRaw) {
                    console.log(`  ${c.dim}${raw}${c.reset}`);
                } else {
                    clearEphemeralStatus(transcript);
                    if (isThinkingToolEvent(event)) {
                        if (event.status === 'running') {
                            appendThinkingItem(transcript, event.detail || event.label, {
                                ...(event.agentId ? { agentId: event.agentId } : {}),
                                ...(event.stepRef ? { stepRef: event.stepRef } : {}),
                                streaming: true,
                                // collapsed omitted — appendThinkingItem's default honors
                                // verbose render mode (settles expanded there).
                            });
                        } else {
                            commitThinkingItemOnce(transcript, event, { updateCommitted: true });
                        }
                        ensureTurnClock(ctx, 'responding');
                        if (isFullscreen(ctx)) ctx.requestFrame?.();
                        break;
                    }
                    if (isFullscreen(ctx) && event.status === 'running') {
                        upsertLiveToolItem(transcript, event);
                    } else if (isFullscreen(ctx)) {
                        commitToolItemOnce(transcript, event);
                    } else {
                        const toolDetail = event.detail ? `: ${event.detail}` : '';
                        const toolOpts: Parameters<typeof appendToolItem>[2] = { detail: event.detail, status: event.status };
                        if (event.agentId) toolOpts.agentId = event.agentId;
                        if (event.stepRef) toolOpts.stepRef = event.stepRef;
                        appendToolItem(transcript, `${event.label}${toolDetail}`, toolOpts);
                    }
                    ensureTurnClock(ctx, 'tool');
                    if (!isFullscreen(ctx)) {
                        const renderState = event.status === 'running' ? 'pending' : event.status;
                        process.stdout.write(`\r\x1b[2K${renderToolLine(event.icon, event.label, event.detail, renderState)}\n`);
                    } else {
                        ctx.requestFrame?.();
                    }
                }
                break;

            case 'agent-fallback':
                if (ctx.isRaw) {
                    console.log(`  ${c.dim}${raw}${c.reset}`);
                } else {
                    clearEphemeralStatus(transcript);
                    appendToolItem(transcript, `${event.from} \u2192 ${event.to}`);
                    if (!isFullscreen(ctx)) {
                        process.stdout.write(`\r\x1b[2K  ${c.yellow}\u26A1${c.reset} ${c.dim}${event.from} \u2192 ${event.to}${c.reset}\n`);
                    } else {
                        ctx.requestFrame?.();
                    }
                }
                break;

            case 'bgtask-update': {
                const msg = event.raw;
                const runningTasks = Array.isArray(msg['running']) ? msg['running'] : [];
                ctx.bgtaskCount = runningTasks.length;
                ctx.bgtaskTasks = runningTasks;
                const changed = msg['changed'] as { id: string; kind: string; status: string } | null;
                if (changed && changed.status !== 'running' && !ctx.isRaw) {
                    const ok = changed.status === 'complete';
                    // jawcode attention latch \u2014 the status-bar badge grows a `!`
                    // until the user opens the Ctrl+O panel (devlog doc 40).
                    if (!ok) ctx.bgtaskAttention = true;
                    // jawcode unicode glyph set: \u2714 complete \u00b7 \u23f9 cancelled \u00b7 \u2718 failed/orphaned
                    const mark = ok ? `${c.green}\u2714` : changed.status === 'cancelled' ? `${c.red}\u23f9` : `${c.red}\u2718`;
                    appendStatusItem(transcript, `bgtask ${changed.kind} ${changed.status} \u00b7 Ctrl+O`);
                    if (!isFullscreen(ctx)) {
                        process.stdout.write(`\r\x1b[2K  ${mark} bgtask ${changed.kind} ${changed.status}${c.dim} \u00b7 Ctrl+O${c.reset}\n`);
                    }
                }
                rebuildFooter(ctx); // refresh the magenta count segment immediately
                if (isFullscreen(ctx)) ctx.requestFrame?.();
                // Open fullscreen panel paints from ctx.bgtaskOverlayItems,
                // which only openBgtaskOverlay refreshes — refetch so the panel
                // doesn't keep showing a finished task as running (adversarial
                // review, devlog doc 40). Classic mode keeps snapshot-at-open
                // semantics: repainting a shrinking box would leave residue.
                if (ctx.store.overlay.bgtaskOpen && isFullscreen(ctx)) {
                    void openBgtaskOverlay(ctx).catch(() => { /* keep last snapshot */ });
                }
                break;
            }

            case 'queue-update':
                // Cache the item snapshot for /queue \u2014 including the empty
                // update, or drained items would ghost in the cache.
                ctx.queueItems = Array.isArray(event.raw['queued'])
                    ? event.raw['queued'] as Array<{ id: string; prompt: string; source?: string; ts?: number }>
                    : [];
                if (event.pending > 0) {
                    appendStatusItem(transcript, `${event.pending}\uAC1C \uB300\uAE30 \uC911 \u00B7 /queue`);
                    if (!isFullscreen(ctx)) {
                        process.stdout.write(`\r  ${c.yellow}\u23F3 ${event.pending}\uAC1C \uB300\uAE30 \uC911 \u00B7 /queue${c.reset}          \r`);
                    } else {
                        ctx.requestFrame?.();
                    }
                }
                break;

            case 'external-message':
                if (ctx.isRaw) {
                    console.log(`  ${c.dim}${raw}${c.reset}`);
                } else if (event.source && event.source !== 'cli') {
                    const message = `[${event.source}] ${event.content.slice(0, 120)}`;
                    if (isFullscreen(ctx)) appendFullscreenStatus(ctx, message);
                    else console.log(`\n  ${c.dim}[${event.source}]${c.reset} ${event.content.slice(0, 60)}`);
                }
                break;

            case 'session-reset':
                invalidateActivityContext(ctx);
                void refreshActivityIdentity(ctx);
                if (!isFullscreen(ctx)) console.log(`\n  ${c.dim}🔄 세션 초기화됨${c.reset}`);
                break;

            case 'worker-warning':
                if (!isFullscreen(ctx)) console.log(`\n  ${c.yellow}⚠️  Worker ${event.type}: ${event.agentId || ''}${c.reset}`);
                break;

            case 'raw':
                if (ctx.isRaw) {
                    console.log(`  ${c.dim}${raw}${c.reset}`);
                    break;
                }
                switch (event.raw['type']) {
                    case 'system_notice':
                        if (event.raw['text'] && !isFullscreen(ctx)) console.log(`\n  ${c.dim}ℹ️  ${event.raw['text']}${c.reset}`);
                        break;
                    case 'alert_escalation':
                        if (isFullscreen(ctx)) {
                            appendFullscreenStatus(ctx, `Error: ${event.raw['text'] || 'Alert escalation'}`);
                        } else {
                            console.log(`\n  ${c.red}${c.bold}┌─ Error ─────────────────────────┐${c.reset}`);
                            console.log(`  ${c.red}│${c.reset} 🚨 ${event.raw['text'] || 'Alert escalation'}`);
                            console.log(`  ${c.red}${c.bold}└─────────────────────────────────┘${c.reset}`);
                        }
                        break;
                    case 'settings_change':
                        void refreshInfo(ctx).then(() => ctx.requestFrame?.());
                        if (!isFullscreen(ctx)) console.log(`\n  ${c.dim}⚙️  설정 변경됨${c.reset}`);
                        break;
                    case 'orc_state':
                    case 'orchestrate_done':
                    case 'orchestrate_warning': {
                        const phase = String(event.raw['phase'] || event.raw['state'] || '');
                        if (phase) ctx.orchPhase = phase;
                        if (event.raw['type'] === 'orchestrate_done' || event.raw['status'] === 'idle') delete ctx.orchPhase;
                        rebuildFooter(ctx);
                        if (isFullscreen(ctx)) {
                            ctx.requestFrame?.();
                        } else if (phase) {
                            console.log(`\n  ${c.dim}📋 PABCD: ${phase}${event.raw['status'] ? ` (${event.raw['status']})` : ''}${c.reset}`);
                        }
                        break;
                    }
                    // Steer/retry/schedule lifecycle — these explain why the
                    // current stream just died or restarted; the Web UI renders
                    // them but the TUI used to drop them silently
                    // (devlog 260703 tui_steer_esc_rca doc 30 §A3).
                    case 'steer_started': {
                        const promptPreview = String(event.raw['prompt'] || '').replace(/\s+/g, ' ').trim().slice(0, 60);
                        const message = `↳ steer (${event.raw['origin'] || 'web'}): ${promptPreview}`;
                        if (isFullscreen(ctx)) appendFullscreenStatus(ctx, message);
                        else console.log(`\n  ${c.yellow}${message}${c.reset}`);
                        break;
                    }
                    case 'agent_retry': {
                        const delay = Number(event.raw['delay'] ?? 0);
                        const reason = String(event.raw['reason'] || '429');
                        const message = `⟳ ${event.raw['cli'] || 'agent'} ${reason}${delay > 0 ? ` — retry in ${delay}s` : ' — retrying'}`;
                        if (isFullscreen(ctx)) appendFullscreenStatus(ctx, message);
                        else console.log(`\n  ${c.dim}${message}${c.reset}`);
                        break;
                    }
                    case 'schedule_wakeup': {
                        const message = `⏰ wakeup in ${event.raw['delaySeconds']}s — ${event.raw['reason'] || ''}`;
                        if (isFullscreen(ctx)) appendFullscreenStatus(ctx, message);
                        else console.log(`\n  ${c.dim}${message}${c.reset}`);
                        break;
                    }
                    case 'schedule_wakeup_failed': {
                        const message = `⚠ wakeup failed — ${event.raw['reason'] || ''}: ${event.raw['error'] || ''}`;
                        if (isFullscreen(ctx)) appendFullscreenStatus(ctx, message);
                        else console.log(`\n  ${c.yellow}${message}${c.reset}`);
                        break;
                    }
                    case 'goal_done':
                    case 'goal_continuation':
                    case 'goal_pause_detected':
                    case 'goal_pause_gate_pending':
                    case 'goal_continuation_limit':
                    case 'goal_continuation_failed':
                    case 'goal_done_rejected':
                    case 'goal_cancel': {
                        const detail = event.raw['reason'] || event.raw['source'] || event.raw['error']
                            || (event.raw['attempts'] !== undefined ? `${event.raw['attempts']} attempts` : '');
                        const message = `🎯 Goal: ${String(event.raw['type']).replace('goal_', '')}${detail ? ` — ${detail}` : ''}`;
                        if (isFullscreen(ctx)) appendFullscreenStatus(ctx, message);
                        else console.log(`\n  ${c.dim}${message}${c.reset}`);
                        break;
                    }
                    case 'memory_status':
                        if (event.raw['text'] && !isFullscreen(ctx)) console.log(`\n  ${c.dim}🧠 ${event.raw['text']}${c.reset}`);
                        break;
                    default:
                        break;
                }
                break;

            case 'ignore':
                if (ctx.isRaw) console.log(`  ${c.dim}${raw}${c.reset}`);
                break;

            default:
                if (ctx.isRaw) {
                    console.log(`  ${c.dim}${raw}${c.reset}`);
                }
                break;
        }
    } catch { /* ignore parse errors */ }
}
