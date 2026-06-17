/**
 * TUI WebSocket message handler.
 */
import type WebSocket from 'ws';
import {
    startAssistantItem, appendAssistantTurnText,
    finalizeAssistant, finalizeStreamingAssistants, assistantTextSinceLastUser,
    appendStatusItem, appendToolItem, clearEphemeralStatus, appendThinkingTurnText, appendThinkingItem,
    upsertLiveToolItem, commitToolItemOnce, commitThinkingItemOnce, commitRemainingLiveToolItems,
    isThinkingToolEvent,
} from '../../../src/cli/tui/transcript.js';
import { captureFileSet, diffFileSets, getDiffStat, getUnifiedDiff, getIdeCli, openDiffInIde } from '../../../src/ide/diff.js';
import { createStreamSink } from '../../../src/cli/tui/stream.js';
import { renderMarkdown } from '../../../src/cli/tui/markdown.js';
import { renderMarkdownJawcode, isInitialized } from '../../../src/cli/tui/jawcode-render.js';
import { renderToolLine } from '../../../src/cli/tui/jawcode-bridge.js';
import { colorizeDiff } from '../../../src/cli/tui/diffview.js';
import { normalizeTuiWsEvent } from '../../../src/cli/tui/events.js';
import { c, type TuiContext } from './types.js';
import { openPromptBlock, rebuildFooter } from './renderer.js';
import { dismissOverlay } from './overlays.js';
import { startSpinner, stopSpinner } from '../../../src/cli/tui/spinner.js';

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

export function handleWsMessage(ctx: TuiContext, data: WebSocket.Data): void {
    const raw = data.toString();
    const ov = ctx.store.overlay;
    const transcript = ctx.store.transcript;
    try {
        const event = normalizeTuiWsEvent(JSON.parse(raw));
        switch (event.kind) {
            case 'assistant-output':
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
                    if (!isFullscreen(ctx) && !isThinkingDelta) {
                        process.stdout.write('\n');
                        ctx.streamSink = createStreamSink({
                            write: (s) => process.stdout.write(s),
                            width: Math.max(20, (process.stdout.columns || 80) - 4),
                            gutter: '  ',
                        });
                    }
                } else if (ctx.streamState === 'tool') {
                    ctx.streamState = 'responding';
                    rebuildFooter(ctx);
                }
                if (isThinkingDelta) {
                    appendThinkingTurnText(transcript, event.text, event.agentId);
                    if (isFullscreen(ctx)) ctx.requestFrame?.();
                    break;
                }
                appendAssistantTurnText(transcript, event.text, event.agentId);
                if (ctx.streamSink) {
                    ctx.streamSink.push(event.text);
                } else if (isFullscreen(ctx)) {
                    ctx.requestFrame?.();
                }
                break;

            case 'agent-done':
                stopSpinner();
                clearEphemeralStatus(transcript);
                for (const tool of event.toolLog) {
                    if (isThinkingToolEvent(tool)) {
                        commitThinkingItemOnce(transcript, tool, { updateCommitted: true });
                    } else {
                        commitToolItemOnce(transcript, tool, { updateCommitted: true });
                    }
                }
                commitRemainingLiveToolItems(transcript, event.raw['error'] ? 'error' : 'done');
                if (ctx.isRaw) {
                    console.log(`  ${c.dim}${raw}${c.reset}`);
                } else if (ctx.streaming) {
                    ctx.streamSink?.end();
                    ctx.streamSink = null;
                    if (event.text) {
                        const existingText = assistantTextSinceLastUser(transcript);
                        if (!existingText) {
                            appendAssistantTurnText(transcript, event.text, event.agentId);
                        } else if (event.text.startsWith(existingText) && event.text.length > existingText.length) {
                            appendAssistantTurnText(transcript, event.text.slice(existingText.length), event.agentId);
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
                openPromptBlock(ctx);
                break;

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
                                collapsed: true,
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
                    const mark = ok ? `${c.green}\u2713` : `${c.red}\u2717`;
                    appendStatusItem(transcript, `bgtask ${changed.kind} ${changed.status}`);
                    if (!isFullscreen(ctx)) {
                        process.stdout.write(`\r\x1b[2K  ${mark} bgtask ${changed.kind} ${changed.status}${c.reset}\n`);
                    }
                }
                rebuildFooter(ctx); // refresh the magenta count segment immediately
                if (isFullscreen(ctx)) ctx.requestFrame?.();
                break;
            }

            case 'queue-update':
                if (event.pending > 0) {
                    appendStatusItem(transcript, `${event.pending}\uAC1C \uB300\uAE30 \uC911`);
                    if (!isFullscreen(ctx)) {
                        process.stdout.write(`\r  ${c.yellow}\u23F3 ${event.pending}\uAC1C \uB300\uAE30 \uC911${c.reset}          \r`);
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
                    case 'goal_done':
                    case 'goal_continuation':
                    case 'goal_pause_detected':
                        if (!isFullscreen(ctx)) console.log(`\n  ${c.dim}🎯 Goal: ${String(event.raw['type']).replace('goal_', '')}${event.raw['reason'] || event.raw['source'] ? ` — ${event.raw['reason'] || event.raw['source']}` : ''}${c.reset}`);
                        break;
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
