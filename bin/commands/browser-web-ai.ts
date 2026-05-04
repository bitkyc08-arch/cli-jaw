import { parseArgs } from 'node:util';
import { renderContextDryRunReport } from '../../src/browser/web-ai/context-pack/index.js';

type BrowserApi = (method: string, path: string, body?: unknown) => Promise<unknown>;
type QueryString = (params: Record<string, unknown>) => string;

const WEB_AI_COMMANDS = new Set(['render', 'status', 'send', 'poll', 'query', 'watch', 'watchers', 'sessions', 'sessions-prune', 'resume', 'reattach', 'notifications', 'capabilities', 'stop', 'diagnose', 'doctor', 'context-dry-run', 'context-render']);

export const WEB_AI_USAGE = `
Usage:
  cli-jaw browser web-ai <command> --vendor <chatgpt|gemini|grok> [options]

Commands:
  render              Render the prompt envelope without opening a browser
  status              Check verified provider tab state
  send                Send a prompt and store a durable session
  poll                Poll a session for completion
  query               send + poll in one command
  watch               Watch a saved session until terminal status
  watchers            List active web-ai watchers
  sessions            List saved web-ai sessions
  notifications       List web-ai completion notifications
  capabilities        List observed/provider capability schemas
  diagnose | doctor   Capture redacted diagnostics for the active provider page
  stop                Stop current provider generation with Escape
  context-dry-run     Build a context package without sending
  context-render      Render full prompt/context package text

Provider:
  --vendor <name>     chatgpt | gemini | grok (default: chatgpt)
  --model <alias>     ChatGPT: instant, thinking, pro
                      Gemini:  fast, thinking, pro
                      Grok:    auto, fast, expert, thinking, heavy
  --effort <alias>    ChatGPT reasoning effort. Requires --model because
                      Pro and Thinking expose different effort menus.
                      Pro: standard, extended
                      Thinking: light, standard, extended, heavy
  --reasoning-effort <alias>
                      Alias for --effort
  --timeout <sec>     Polling timeout

Prompt and context:
  --prompt <text>     Main prompt/question
  --inline-only       Required for send/query without files
  --file <path>       Upload a single file
  --context-from-files <glob|path>
  --context-exclude <glob>
  --context-file <path>
  --context-transport <upload|inline>
  --allow-copy-markdown-fallback
  --allow-grok-context-pack

Sessions:
  --session <id>      Resume/poll a saved session
  --deadline <iso>    Override session deadline
  --navigate          Allow resume to switch tabs if needed
  --new-tab           Force a fresh provider tab; default reuses pooled or inactive tabs first
  --reuse-tab         Reuse active tab

Output:
  --json              Print JSON
  --full              Print full context dry-run/render output

Examples:
  cli-jaw browser web-ai render --vendor chatgpt --prompt "hello" --json
  cli-jaw browser web-ai query --vendor chatgpt --model pro --effort extended --inline-only --prompt "Reply OK"
  cli-jaw browser web-ai query --vendor grok --inline-only --prompt "Reply OK"
`;

function rejectFutureWebAiFlags(values: Record<string, unknown>): void {
    const vendor = values.vendor ?? 'chatgpt';
    if (vendor !== 'chatgpt' && vendor !== 'gemini' && vendor !== 'grok') throw new Error(`unsupported vendor: ${vendor}`);
    if (values.model && !isSupportedWebAiModel(vendor, values.model)) throw new Error(`unsupported ${webAiVendorLabel(vendor)} model selection: ${values.model}`);
    const effort = values.effort || values['reasoning-effort'];
    if (effort && !values.model) throw new Error(`${webAiVendorLabel(vendor)} reasoning effort requires --model because effort menus differ by model`);
    if (effort && !isSupportedWebAiEffort(vendor, values.model, effort)) throw new Error(`unsupported ${webAiVendorLabel(vendor)} reasoning effort: ${effort}`);
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

function isSupportedWebAiEffort(vendor: unknown, model: unknown, effort: unknown): boolean {
    if (String(vendor || 'chatgpt') !== 'chatgpt') return false;
    const effortKey = String(effort || '').trim().toLowerCase();
    const normalizedEffort = ({ low: 'light', light: 'light', standard: 'standard', normal: 'standard', regular: 'standard', default: 'standard', high: 'extended', extended: 'extended', heavy: 'heavy' } as Record<string, string>)[effortKey];
    if (!normalizedEffort) return false;
    const modelKey = String(model || '').trim().toLowerCase();
    const normalizedModel = ({ think: 'thinking', thinking: 'thinking', 'gpt-5-5-thinking': 'thinking', 'gpt-5.5-thinking': 'thinking', pro: 'pro', 'gpt-5-5-pro': 'pro', 'gpt-5.5-pro': 'pro' } as Record<string, string>)[modelKey];
    if (normalizedModel === 'thinking') return ['light', 'standard', 'extended', 'heavy'].includes(normalizedEffort);
    if (normalizedModel === 'pro') return ['standard', 'extended'].includes(normalizedEffort);
    return false;
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
    if (!command || command === '--help' || command === 'help' || args.includes('--help')) {
        console.log(WEB_AI_USAGE.trim());
        return;
    }
    if (!command || !WEB_AI_COMMANDS.has(command)) {
        throw new Error(WEB_AI_USAGE.trim());
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
            effort: { type: 'string' },
            'reasoning-effort': { type: 'string' },
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
            deadline: { type: 'string' },
            navigate: { type: 'boolean', default: false },
            'new-tab': { type: 'boolean', default: false },
            'reuse-tab': { type: 'boolean', default: false },
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
        ...(values.effort || values['reasoning-effort'] ? { reasoningEffort: values.effort || values['reasoning-effort'] } : {}),
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
        ...(values['new-tab'] ? { newTab: true } : {}),
        ...(values['reuse-tab'] ? { reuseTab: true } : {}),
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
    if (command === 'resume') return deps.api('GET', `/web-ai/poll${deps.qs({ vendor: values.vendor, session: values.session, timeout: values.timeout || values.deadline, allowCopyMarkdownFallback: values['allow-copy-markdown-fallback'] })}`);
    if (command === 'reattach') {
        if (!values.session) throw new Error('reattach requires --session <id>');
        return deps.api('GET', `/web-ai/status${deps.qs({ vendor: values.vendor, session: values.session, navigate: values.navigate })}`);
    }
    if (command === 'doctor' || command === 'diagnose') return deps.api('GET', `/web-ai/diagnose${deps.qs({ vendor: values.vendor, stage: values.stage })}`);
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
