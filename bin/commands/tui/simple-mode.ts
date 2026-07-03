/**
 * TUI simple mode: plain readline, no raw stdin tricks.
 */
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { APP_VERSION } from '../../../src/core/config.js';
import { parseCommand, executeCommand } from '../../../src/cli/commands.js';
import type { ParsedSlashCommand } from '../../../src/cli/types.js';
import { captureFileSet, diffFileSets, openDiffInIde, getIdeCli } from '../../../src/ide/diff.js';
import { c, renderCommandText, type TuiContext } from './types.js';
import { makeCliCommandCtx, apiJson } from './api.js';
import { runQueueCommand } from './queue-command.js';

export async function runSimpleMode(ctx: TuiContext): Promise<void> {
    const { ws } = ctx;
    console.log(`\n  cli-jaw v${APP_VERSION} \u00B7 ${ctx.label} \u00B7 :${ctx.values.port}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${ctx.label} > ` });
    let streaming = false;

    async function handleSlashCommand(parsed: ParsedSlashCommand) {
        // /steer must run in the server process (registry excludes 'cli' —
        // process boundary). Forward the raw text to POST /api/message, same
        // as the full TUI (slash-command-runner.ts runSteerViaServer).
        if (parsed?.type === 'known' && parsed.name === 'steer') {
            if (!parsed.args.length) {
                console.log(`  ${c.red}Usage: /steer <prompt>${c.reset}`);
                rl.prompt();
                return;
            }
            try {
                const resp = await apiJson<{ ok?: boolean; text?: string; error?: string }>(
                    ctx, '/api/message',
                    { method: 'POST', body: { prompt: parsed.rawText || `/steer ${parsed.args.join(' ')}` } },
                    45_000,
                );
                if (resp.ok === false) console.log(`  ${c.red}${resp.text || resp.error || 'steer failed'}${c.reset}`);
                else console.log(`  ${renderCommandText(resp.text || 'steering…')}`);
            } catch (err) {
                console.log(`  ${c.red}${(err as Error).message}${c.reset}`);
            }
            rl.prompt();
            return;
        }
        // /queue: same shared executor as the full TUI.
        if (parsed?.type === 'known' && parsed.name === 'queue') {
            try {
                const result = await runQueueCommand(ctx, parsed.args);
                if (result.ok) console.log(`  ${renderCommandText(result.text)}`);
                else console.log(`  ${c.red}${result.text}${c.reset}`);
            } catch (err) {
                console.log(`  ${c.red}${(err as Error).message}${c.reset}`);
            }
            rl.prompt();
            return;
        }
        try {
            const result = await executeCommand(parsed, makeCliCommandCtx(ctx));
            if (result?.code === 'clear_screen') console.clear();
            if (result?.text) console.log(`  ${renderCommandText(result.text)}`);
            if (result?.code === 'ide_toggle') { ctx.ideEnabled = !ctx.ideEnabled; }
            if (result?.code === 'ide_on') { ctx.ideEnabled = true; }
            if (result?.code === 'ide_off') { ctx.ideEnabled = false; }
            if (result?.code && ['ide_toggle', 'ide_on', 'ide_off'].includes(result.code)) {
                console.log(`  ${ctx.ideEnabled ? '\u2713' : '\u2717'} IDE diff: ${ctx.ideEnabled ? 'ON' : 'OFF'}${ctx.isGit ? '' : ' (non-git)'}`);
            }
            if (result?.code === 'ide_pop_toggle') {
                ctx.idePopEnabled = !ctx.idePopEnabled;
                const ideName = ctx.detectedIde ? getIdeCli(ctx.detectedIde) : null;
                console.log(`  ${ctx.idePopEnabled ? '\u2713' : '\u2717'} IDE popup: ${ctx.idePopEnabled ? 'ON' : 'OFF'}${ideName ? ` (${ideName})` : ' (IDE \uBBF8\uAC10\uC9C0)'}`);
            }
            if (result?.code === 'exit') {
                ws.close();
                rl.close();
                process.exit(0);
            }
        } catch (err) {
            console.log(`  ${c.red}${(err as Error).message}${c.reset}`);
        }
        rl.prompt();
    }

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'agent_chunk' || msg.type === 'agent_output') {
                if (!streaming) {
                    streaming = true;
                    if (msg.agentId) process.stdout.write(`\x1b[2m[${msg.agentId}]\x1b[0m `);
                }
                process.stdout.write(msg.text || '');
            }
            else if (msg.type === 'agent_fallback') {
                console.log(`  \u26A1 ${msg.from} \uC2E4\uD328 \u2192 ${msg.to}\uB85C \uC7AC\uC2DC\uB3C4`);
            }
            else if (msg.type === 'agent_tool' && msg.icon && msg.label) {
                const detail = msg.detail ? `: ${msg.detail}` : '';
                process.stdout.write(`\r\x1b[2K  ${msg.icon} ${msg.label}${detail}\n`);
            }
            else if (msg.type === 'agent_status' && msg.text) {
                process.stdout.write(`\r\x1b[2K  ⏳ ${msg.text}\r`);
            }
            else if (msg.type === 'system_notice' && msg.text) {
                console.log(`\n  ℹ️  ${msg.text}`);
            }
            else if (msg.type === 'session_reset' || msg.type === 'clear') {
                console.log('\n  🔄 세션 초기화됨');
            }
            else if (msg.type === 'worker_stalled' || msg.type === 'worker_timeout') {
                console.log(`\n  ⚠️  Worker ${msg.type}: ${msg.agentId || ''}`);
            }
            else if (msg.type === 'alert_escalation') {
                console.log(`\n  🚨 ${msg.text || 'Alert escalation'}`);
            }
            else if (msg.type === 'agent_done') {
                if (streaming) { process.stdout.write('\n\n'); streaming = false; }
                else if (msg.text) console.log(msg.text + '\n');
                if (ctx.isGit && ctx.preFileSetQueue.length > 0) {
                    const preSet = ctx.preFileSetQueue.shift()!;
                    if (ctx.ideEnabled) {
                        const postSet = captureFileSet(ctx.chatCwd);
                        const changed = diffFileSets(preSet, postSet);
                        if (changed.length > 0) {
                            console.log(`  \uD83D\uDCC2 ${changed.length}\uAC1C \uD30C\uC77C \uBCC0\uACBD\uB428`);
                            for (const f of changed.slice(0, 10)) console.log(`    \u25E6 ${f}`);
                            if (ctx.idePopEnabled && ctx.detectedIde) openDiffInIde(ctx.chatCwd, changed, ctx.detectedIde);
                        }
                    }
                }
                rl.prompt();
            }
            else if (msg.type === 'agent_status' && msg.status === 'running')
                process.stdout.write(`[${msg.agentName || msg.agentId}] working...\r`);
        } catch { /* ignore parse errors */ }
    });

    rl.on('line', (line) => {
        const t = line.trim();
        if (!t) { rl.prompt(); return; }
        if (t.startsWith('/file ')) {
            const parts = t.slice(6).trim().split(/\s+/);
            const fp = resolvePath(parts[0]!);
            const caption = parts.slice(1).join(' ');
            if (!fs.existsSync(fp)) { console.log(`  ${c.red}\uD30C\uC77C \uC5C6\uC74C: ${fp}${c.reset}`); rl.prompt(); return; }
            const prompt = `[\uC0AC\uC6A9\uC790\uAC00 \uD30C\uC77C\uC744 \uBCF4\uB0C8\uC2B5\uB2C8\uB2E4: ${fp}]\n\uC774 \uD30C\uC77C\uC744 Read \uB3C4\uAD6C\uB85C \uC77D\uACE0 \uBD84\uC11D\uD574\uC8FC\uC138\uC694.${caption ? `\n\n\uC0AC\uC6A9\uC790 \uBA54\uC2DC\uC9C0: ${caption}` : ''}`;
            if (ctx.ideEnabled && ctx.isGit) {
                ctx.preFileSetQueue.push(captureFileSet(ctx.chatCwd));
            }
            ws.send(JSON.stringify({ type: 'send_message', text: prompt }));
            return;
        }
        const parsed = parseCommand(t);
        if (parsed) { void handleSlashCommand(parsed); return; }
        if (ctx.ideEnabled && ctx.isGit) {
            ctx.preFileSetQueue.push(captureFileSet(ctx.chatCwd));
        }
        ws.send(JSON.stringify({ type: 'send_message', text: t }));
    });
    rl.on('close', () => { ws.close(); process.exit(0); });
    ws.on('close', () => { console.log('Disconnected'); process.exit(0); });
    rl.prompt();
}
