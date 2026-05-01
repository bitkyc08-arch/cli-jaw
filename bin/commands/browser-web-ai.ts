import { parseArgs } from 'node:util';
import { renderContextDryRunReport } from '../../src/browser/web-ai/context-pack/index.js';

type BrowserApi = (method: string, path: string, body?: unknown) => Promise<unknown>;
type QueryString = (params: Record<string, unknown>) => string;

const WEB_AI_COMMANDS = new Set(['render', 'status', 'send', 'poll', 'query', 'watch', 'watchers', 'sessions', 'sessions-prune', 'notifications', 'capabilities', 'stop', 'diagnose', 'context-dry-run', 'context-render']);

function rejectFutureWebAiFlags(values: Record<string, unknown>): void {
    const vendor = values.vendor ?? 'chatgpt';
    if (vendor !== 'chatgpt' && vendor !== 'gemini' && vendor !== 'grok') throw new Error(`unsupported vendor: ${vendor}`);
    if (values.model && !isSupportedWebAiModel(vendor, values.model)) throw new Error(`unsupported ${webAiVendorLabel(vendor)} model selection: ${values.model}`);
}

function isSupportedWebAiModel(vendor: unknown, model: unknown): boolean {
    const key = String(model || '').trim().toLowerCase();
    const byVendor: Record<string, Set<string>> = {
        chatgpt: new Set(['instant', 'fast', 'gpt-5-3', 'gpt-5.3', 'thinking', 'think', 'gpt-5-5-thinking', 'gpt-5.5-thinking', 'pro', 'gpt-5-5-pro', 'gpt-5.5-pro']),
        gemini: new Set(['fast', 'flash', 'gemini-fast', 'thinking', 'think', 'gemini-thinking', 'pro', 'gemini-pro', '3.1-pro']),
        grok: new Set(['auto', 'automatic', 'fast', 'quick', 'expert', 'thinking', 'think', 'grok-4.3', 'grok43', 'grok-43', 'beta', 'heavy']),
    };
    return Boolean(byVendor[String(vendor || 'chatgpt')]?.has(key));
}

function webAiVendorLabel(vendor: unknown): string {
    const key = String(vendor || 'chatgpt');
    if (key === 'chatgpt') return 'ChatGPT';
    if (key === 'gemini') return 'Gemini';
    if (key === 'grok') return 'Grok';
    return key;
}

export async function runWebAiCommand(
    args: string[],
    deps: { api: BrowserApi; qs: QueryString },
): Promise<void> {
    const command = args[0];
    if (!command || !WEB_AI_COMMANDS.has(command)) {
        throw new Error(`Usage: cli-jaw browser web-ai <${[...WEB_AI_COMMANDS].join('|')}> --vendor chatgpt`);
    }
    const { values } = parseArgs({
        args: args.slice(1),
        options: {
            vendor: { type: 'string', default: 'chatgpt' },
            prompt: { type: 'string' },
            url: { type: 'string' },
            system: { type: 'string' },
            project: { type: 'string' },
            goal: { type: 'string' },
            context: { type: 'string' },
            question: { type: 'string' },
            output: { type: 'string' },
            constraints: { type: 'string' },
            timeout: { type: 'string' },
            session: { type: 'string' },
            stage: { type: 'string' },
            status: { type: 'string' },
            family: { type: 'string' },
            'frontend-status': { type: 'string' },
            'poll-interval': { type: 'string' },
            'inline-only': { type: 'boolean', default: false },
            'allow-copy-markdown-fallback': { type: 'boolean', default: false },
            'allow-grok-context-pack': { type: 'boolean', default: false },
            notify: { type: 'boolean', default: true },
            file: { type: 'string' },
            model: { type: 'string' },
            'thinking-time': { type: 'string' },
            'context-from-files': { type: 'string', multiple: true },
            'context-exclude': { type: 'string', multiple: true },
            'context-file': { type: 'string' },
            'max-input': { type: 'string' },
            'max-file-size': { type: 'string' },
            'files-report': { type: 'boolean', default: false },
            'context-transport': { type: 'string' },
            'dry-run': { type: 'string' },
            'older-than-ms': { type: 'string' },
            before: { type: 'string' },
            probe: { type: 'string' },
            full: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
        strict: false,
    });
    rejectFutureWebAiFlags(values);
    const hasContextPackage = Boolean(values['context-file'] || (Array.isArray(values['context-from-files']) && values['context-from-files'].length > 0));
    if (['send', 'query'].includes(command) && !values['inline-only'] && !values.file && !hasContextPackage) {
        throw new Error('web-ai send/query require --inline-only or --file=<path>');
    }
    const body = {
        vendor: values.vendor,
        url: values.url,
        prompt: values.prompt,
        system: values.system,
        project: values.project,
        goal: values.goal,
        context: values.context,
        question: values.question,
        output: values.output,
        constraints: values.constraints,
        timeout: values.timeout,
        attachmentPolicy: values.file ? 'upload' : 'inline-only',
        ...(values.file ? { filePath: values.file } : {}),
        ...(values['thinking-time'] ? { thinkingTime: values['thinking-time'] } : {}),
        ...(values.model ? { model: values.model } : {}),
        contextFromFiles: values['context-from-files'] || [],
        contextExclude: values['context-exclude'] || [],
        ...(values['context-file'] ? { contextFile: values['context-file'] } : {}),
        ...(values['max-input'] ? { maxInput: values['max-input'] } : {}),
        ...(values['max-file-size'] ? { maxFileSize: values['max-file-size'] } : {}),
        ...(values['files-report'] ? { filesReport: values['files-report'] } : {}),
        ...(values['context-transport'] ? { contextTransport: values['context-transport'] } : {}),
        ...(values['inline-only'] ? { inlineOnly: true } : {}),
        ...(values['allow-copy-markdown-fallback'] ? { allowCopyMarkdownFallback: true } : {}),
        ...(values['allow-grok-context-pack'] ? { allowGrokContextPack: true } : {}),
    };
    const result = await callWebAiEndpoint(command, body, values, deps) as Record<string, unknown>;
    const fullContextOutput = values.full === true || command === 'context-render';
    if (isContextCommand(command) && values.json) {
        console.log(renderContextDryRunReport(result as any, {
            mode: 'json',
            full: fullContextOutput,
            json: true,
            includeComposerText: fullContextOutput,
        }));
    } else if (values.json) console.log(JSON.stringify(result, null, 2));
    else if (isContextCommand(command)) {
        console.log(renderContextDryRunReport(result as any, {
            mode: fullContextOutput ? 'full' : String(values['dry-run'] || 'summary') as any,
            full: fullContextOutput,
        }));
    }
    else printWebAiHuman(command, result);
}

async function callWebAiEndpoint(
    command: string,
    body: Record<string, unknown>,
    values: Record<string, unknown>,
    deps: { api: BrowserApi; qs: QueryString },
): Promise<unknown> {
    if (command === 'status') return deps.api('GET', `/web-ai/status${deps.qs({ vendor: values.vendor, probe: values.probe })}`);
    if (command === 'sessions') return deps.api('GET', `/web-ai/sessions${deps.qs({ vendor: values.vendor, status: values.status })}`);
    if (command === 'sessions-prune') {
        const olderThanMs = values['older-than-ms'] ? Number(values['older-than-ms']) : undefined;
        return deps.api('POST', '/web-ai/sessions/prune', {
            ...(olderThanMs !== undefined && Number.isFinite(olderThanMs) ? { olderThanMs } : {}),
            ...(values.before ? { before: values.before } : {}),
            ...(values.status ? { status: values.status } : {}),
        });
    }
    if (command === 'notifications') return deps.api('GET', `/web-ai/notifications${deps.qs({ vendor: values.vendor, status: values.status, session: values.session })}`);
    if (command === 'watchers') return deps.api('GET', '/web-ai/watchers');
    if (command === 'capabilities') return deps.api('GET', `/web-ai/capabilities${deps.qs({ vendor: values.vendor, family: values.family, frontendStatus: values['frontend-status'] })}`);
    if (command === 'poll') return deps.api('GET', `/web-ai/poll${deps.qs({ vendor: values.vendor, timeout: values.timeout, session: values.session, allowCopyMarkdownFallback: values['allow-copy-markdown-fallback'] })}`);
    if (command === 'watch') return deps.api('GET', `/web-ai/watch${deps.qs({ vendor: values.vendor, timeout: values.timeout, session: values.session, url: values.url, notify: values.notify, pollIntervalSeconds: values['poll-interval'], allowCopyMarkdownFallback: values['allow-copy-markdown-fallback'] })}`);
    if (command === 'diagnose') return deps.api('GET', `/web-ai/diagnose${deps.qs({ vendor: values.vendor, stage: values.stage })}`);
    if (command === 'context-dry-run' || command === 'context-render') return deps.api('POST', `/web-ai/${command}`, body);
    return deps.api('POST', `/web-ai/${command}`, body);
}

function isContextCommand(command: string): boolean {
    return command === 'context-dry-run' || command === 'context-render';
}

function printWebAiHuman(command: string, result: Record<string, unknown>): void {
    if (command === 'render') {
        const rendered = result.rendered as { composerText?: string; markdown?: string } | undefined;
        console.log(rendered?.composerText || rendered?.markdown || '');
        if (Array.isArray(result.warnings) && result.warnings.length) console.error(`[warnings] ${result.warnings.join(', ')}`);
        return;
    }
    if (result.answerText) {
        console.log(result.answerText);
        return;
    }
    for (const key of ['sessions', 'notifications', 'watchers', 'capabilities']) {
        if (Array.isArray(result[key])) {
            console.log(JSON.stringify(result[key], null, 2));
            return;
        }
    }
    console.log(`${result.status}: ${result.url || result.vendor || 'web-ai'}`);
}
