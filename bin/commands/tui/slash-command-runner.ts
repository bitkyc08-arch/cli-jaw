/**
 * Fullscreen/line-mode slash command execution.
 */
import { executeCommand, getArgumentCompletionItems, resolveEffortLevelsForCli } from '../../../src/cli/commands.js';
import type { ArgumentCompletionItem } from '../../../src/cli/commands.js';
import type { ParsedSlashCommand } from '../../../src/cli/types.js';
import { setBracketedPaste } from '../../../src/cli/tui/composer.js';
import { appendCommandItem, isVerboseRenderMode } from '../../../src/cli/tui/transcript.js';
import { cleanupScrollRegion, resolveShellLayout, setupScrollRegion } from '../../../src/cli/tui/shell.js';
import { getIdeCli } from '../../../src/ide/diff.js';
import { c, getRows, hrLine, renderCommandText, type TuiContext } from './types.js';
import { rebuildFooter, openPromptBlock } from './renderer.js';
import { refreshInfo, makeCliCommandCtx, apiJson } from './api.js';
import { runQueueCommand } from './queue-command.js';
import {
    closeAutocompleteForCtx,
    openChoiceSelector,
    openCommandPalette,
    openHelpOverlay,
    openSettingsScreen,
} from './overlays.js';

function appendFullscreenFeedback(ctx: TuiContext, text: string, opts?: { commandName?: string; ok?: boolean }): void {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    appendCommandItem(ctx.store.transcript, normalized, opts);
    ctx.requestFrame?.();
}

function clearFullscreenTranscript(ctx: TuiContext): void {
    ctx.store.transcript.items.length = 0;
    ctx.store.transcript.liveTools.length = 0;
    ctx.store.transcript.liveToolsExpanded = isVerboseRenderMode();
    ctx.store.transcript.committedToolRefs.clear();
    ctx.requestFrame?.();
}

function openArgumentSelector(
    ctx: TuiContext,
    commandName: string,
    title: string,
    subtitle: string,
    items: ArgumentCompletionItem[],
): void {
    openChoiceSelector(ctx, () => {
        const sel = ctx.store.overlay.selector;
        sel.open = true;
        sel.commandName = commandName;
        sel.title = title;
        sel.subtitle = subtitle;
        sel.filter = '';
        sel.selected = 0;
        sel.allItems = items.map((a) => ({
            value: a.name,
            label: a.desc || '',
            current: a.name === (commandName === 'model' ? ctx.info.model : ctx.info.cli),
        }));
        sel.filteredItems = sel.allItems;
        const curIdx = sel.filteredItems.findIndex(i => i.current);
        if (curIdx >= 0) sel.selected = curIdx;
    });
    ctx.commandRunning = false;
    ctx.inputActive = true;
}

// /steer must run in the SERVER process where the active agent lives — the
// command registry excludes the 'cli' interface on purpose (process boundary,
// tests/unit/steer-command.test.ts STR-001) and a local executeCommand would
// see an empty spawn state. Forward the raw text to POST /api/message so
// src/routes/command.ts executes steerHandler server-side, and surface the
// handler's feedback text here (the SSE channel discards POST responses).
async function runSteerViaServer(ctx: TuiContext, parsed: ParsedSlashCommand & { type: 'known' }): Promise<void> {
    const feedback = (text: string, ok: boolean) => {
        if (ctx.displayMode === 'fullscreen') appendFullscreenFeedback(ctx, text, { commandName: 'steer', ok });
        else if (ok) console.log(`  ${renderCommandText(text)}`);
        else console.log(`  ${c.red}${text}${c.reset}`);
    };
    const restoreInput = () => {
        ctx.commandRunning = false;
        ctx.inputActive = true;
        openPromptBlock(ctx);
    };
    if (!parsed.args.length) {
        feedback('Usage: /steer <prompt>', false);
        restoreInput();
        return;
    }
    const prompt = parsed.rawText || `/steer ${parsed.args.join(' ')}`;
    try {
        // claude-e steers wait up to 30s for the old turn to die — keep the
        // HTTP timeout above getSteerWaitMsForActiveAgent's worst case.
        const resp = await apiJson<{ ok?: boolean; text?: string; error?: string }>(
            ctx, '/api/message', { method: 'POST', body: { prompt } }, 45_000,
        );
        if (resp.ok === false) {
            feedback(resp.text || resp.error || 'steer failed', false);
            restoreInput();
            return;
        }
        feedback(resp.text || 'steering…', true);
        // The steered turn is starting: keep the stream shortcuts (ESC stop)
        // armed instead of reopening the prompt as if idle.
        ctx.commandRunning = false;
        ctx.inputActive = false;
        ctx.requestFrame?.();
    } catch (err) {
        feedback((err as Error).message, false);
        restoreInput();
    }
}

export async function runSlashCommand(ctx: TuiContext, parsed: ParsedSlashCommand): Promise<void> {
    if (!parsed) return;
    const panes = ctx.store.panes;

    if (parsed.type === 'known' && parsed.name === 'steer') {
        await runSteerViaServer(ctx, parsed);
        return;
    }

    // /queue: interactive listing + steer/drop against the server queue routes
    // (shared executor with simple-mode; registry handler is usage-only).
    if (parsed.type === 'known' && parsed.name === 'queue') {
        try {
            const result = await runQueueCommand(ctx, parsed.args);
            if (ctx.displayMode === 'fullscreen') appendFullscreenFeedback(ctx, result.text, { commandName: 'queue', ok: result.ok });
            else if (result.ok) console.log(`  ${renderCommandText(result.text)}`);
            else console.log(`  ${c.red}${result.text}${c.reset}`);
            ctx.commandRunning = false;
            if (result.steered) {
                // A steered turn is starting — keep ESC-stop armed.
                ctx.inputActive = false;
                ctx.requestFrame?.();
            } else {
                ctx.inputActive = true;
                openPromptBlock(ctx);
            }
        } catch (err) {
            if (ctx.displayMode === 'fullscreen') appendFullscreenFeedback(ctx, (err as Error).message, { commandName: 'queue', ok: false });
            else console.log(`  ${c.red}${(err as Error).message}${c.reset}`);
            ctx.commandRunning = false;
            ctx.inputActive = true;
            openPromptBlock(ctx);
        }
        return;
    }

    if (parsed.type === 'known' && parsed.name === 'help') {
        openHelpOverlay(ctx);
        ctx.commandRunning = false;
        ctx.inputActive = true;
        return;
    }

    if (parsed.type === 'known' && parsed.name === 'model' && !parsed.args.length) {
        const items = await getArgumentCompletionItems('model', '', 'cli', [], makeCliCommandCtx(ctx));
        openArgumentSelector(ctx, 'model', 'Model', `${ctx.info.cli}: ${ctx.info.model || 'default'}`, items);
        return;
    }

    if (parsed.type === 'known' && parsed.name === 'cli' && !parsed.args.length) {
        const items = await getArgumentCompletionItems('cli', '', 'cli', [], makeCliCommandCtx(ctx));
        openArgumentSelector(ctx, 'cli', 'CLI Engine', `current: ${ctx.info.cli}`, items);
        return;
    }

    if (parsed.type === 'known' && parsed.name === 'effort' && !parsed.args.length) {
        // Accepted efforts are per CLI and, for Codex, per MODEL — a live
        // opencodex advertises `ultra` for gpt-5.6-sol but stops at `max` for
        // gpt-5.6-luna. A hardcoded list hid `xhigh`/`ultra` entirely.
        const levels = ['off', ...await resolveEffortLevelsForCli(ctx.info.cli, ctx.info.model || '')];
        if (levels.length === 1) {
            appendFullscreenFeedback(ctx, `${ctx.info.cli} does not accept a reasoning effort.`, { commandName: 'effort' });
            ctx.commandRunning = false;
            ctx.inputActive = true;
            return;
        }
        openChoiceSelector(ctx, () => {
            const sel = ctx.store.overlay.selector;
            sel.open = true;
            sel.commandName = 'effort';
            sel.title = 'Reasoning Effort';
            sel.subtitle = 'Select thinking level';
            sel.filter = '';
            sel.selected = 2;
            sel.allItems = levels.map(l => ({ value: l, label: '', current: false }));
            sel.filteredItems = sel.allItems;
        });
        ctx.commandRunning = false;
        ctx.inputActive = true;
        return;
    }

    if (parsed.type === 'known' && parsed.name === 'resume' && !parsed.args.length) {
        try {
            const response = await apiJson<{
                data?: { sessions?: Array<{ id: string; label?: string; created_at?: string }> };
                sessions?: Array<{ id: string; label?: string; created_at?: string }>;
            }>(ctx, '/api/chat-sessions', {}, 3000);
            {
                const sessions = response.data?.sessions || response.sessions || [];
                openChoiceSelector(ctx, () => {
                    const sel = ctx.store.overlay.selector;
                    sel.open = true;
                    sel.commandName = 'resume';
                    sel.title = 'Resume Session';
                    sel.subtitle = `${sessions.length} sessions`;
                    sel.filter = '';
                    sel.selected = 0;
                    sel.allItems = sessions.map(s => ({
                        value: s.id,
                        label: s.label || s.created_at || '',
                        current: false,
                    }));
                    sel.filteredItems = sel.allItems;
                });
                ctx.commandRunning = false;
                ctx.inputActive = true;
                return;
            }
        } catch { /* fallthrough to text handler */ }
    }

    if (parsed.type === 'known' && parsed.name === 'commands') {
        openCommandPalette(ctx);
        ctx.commandRunning = false;
        ctx.inputActive = true;
        return;
    }

    if (parsed.type === 'known' && parsed.name === 'settings' && ctx.displayMode === 'fullscreen') {
        openSettingsScreen(ctx);
        ctx.commandRunning = false;
        ctx.inputActive = true;
        return;
    }

    let exiting = false;
    try {
        const result = await executeCommand(parsed, makeCliCommandCtx(ctx));
        if (result?.code === 'clear_screen') {
            if (ctx.displayMode === 'fullscreen') {
                clearFullscreenTranscript(ctx);
            } else {
                console.clear();
                setupScrollRegion(ctx.footer, `  ${c.dim}${hrLine()}${c.reset}`, resolveShellLayout(process.stdout.columns || 80, getRows(), panes));
            }
        }
        if (result?.text) {
            if (ctx.displayMode === 'fullscreen') appendFullscreenFeedback(ctx, result.text, { commandName: parsed.name, ok: result.ok !== false });
            else console.log(`  ${renderCommandText(result.text)}`);
        }
        if (result?.code === 'ide_toggle') { ctx.ideEnabled = !ctx.ideEnabled; }
        if (result?.code === 'ide_on') { ctx.ideEnabled = true; }
        if (result?.code === 'ide_off') { ctx.ideEnabled = false; }
        if (result?.code && ['ide_toggle', 'ide_on', 'ide_off'].includes(result.code)) {
            const message = `IDE diff: ${ctx.ideEnabled ? 'ON' : 'OFF'}${ctx.isGit ? '' : ' (non-git)'}`;
            if (ctx.displayMode === 'fullscreen') appendFullscreenFeedback(ctx, message, { commandName: parsed.name, ok: true });
            else console.log(`  ${ctx.ideEnabled ? c.green + '\u2713' : c.yellow + '\u2717'}${c.reset} ${message}`);
        }
        if (result?.code === 'ide_pop_toggle') {
            ctx.idePopEnabled = !ctx.idePopEnabled;
            const ideName = ctx.detectedIde ? getIdeCli(ctx.detectedIde) : null;
            const message = `IDE popup: ${ctx.idePopEnabled ? 'ON' : 'OFF'}${ideName ? ` (${ideName})` : ' (IDE \uBBF8\uAC10\uC9C0)'}`;
            if (ctx.displayMode === 'fullscreen') appendFullscreenFeedback(ctx, message, { commandName: parsed.name, ok: true });
            else console.log(`  ${ctx.idePopEnabled ? c.green + '\u2713' : c.yellow + '\u2717'}${c.reset} ${message}`);
        }
        if (result?.ok && (parsed.name === 'model' || parsed.name === 'cli') && parsed.args.length > 0) {
            await refreshInfo(ctx);
            rebuildFooter(ctx);
            if (ctx.displayMode === 'fullscreen') ctx.requestFrame?.();
        }
        if (result?.code === 'redraw') {
            if (ctx.displayMode === 'fullscreen') ctx.requestFrame?.();
            else rebuildFooter(ctx);
        }
        if (result?.code === 'retry') {
            const last = ctx.store.transcript.items.filter(i => i.type === 'user').pop();
            if (last && 'submitText' in last) {
                // 'send_message' is the only outbound chat type the transport
                // adapter maps (channel.ts) — the old 'message' type was
                // silently dropped over SSE, breaking /retry.
                ctx.ws.send(JSON.stringify({ type: 'send_message', text: last.submitText }));
            }
        }
        if (result?.code === 'show_help') {
            openHelpOverlay(ctx);
        }
        if (result?.code === 'exit') {
            exiting = true;
            cleanupScrollRegion(resolveShellLayout(process.stdout.columns || 80, getRows(), panes));
            console.log(`  ${c.dim}Bye! \uD83E\uDD88${c.reset}\n`);
            setBracketedPaste(false);
            ctx.ws.close();
            process.stdin.setRawMode(false);
            process.exit(0);
        }
    } catch (err) {
        if (ctx.displayMode === 'fullscreen') appendFullscreenFeedback(ctx, (err as Error).message, { commandName: parsed.name, ok: false });
        else console.log(`  ${c.red}${(err as Error).message}${c.reset}`);
    } finally {
        if (!exiting) {
            ctx.commandRunning = false;
            ctx.inputActive = true;
            closeAutocompleteForCtx(ctx);
            openPromptBlock(ctx);
        }
    }
}
