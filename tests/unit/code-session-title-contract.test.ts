import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function read(path: string): string {
    return readFileSync(join(ROOT, path), 'utf8');
}

test('code session stored rows use JWC title and first-message fallback instead of cwd primary fallback', () => {
    const list = read('public/manager/src/code/CodeSessionList.tsx');

    assert.ok(list.includes('storedSessionTitle'), 'CodeSessionList must centralize stored title fallback');
    assert.ok(list.includes("session.title?.trim()"), 'stored title must prefer JWC title');
    assert.ok(list.includes("session.firstMessage?.replace"), 'stored title must fall back to first user message when available');
    assert.ok(list.includes("session.sessionId.slice"), 'stored title must use a stable session id prefix after title/firstMessage');
    assert.equal(list.includes('s.title || cwdLabel(s.cwd)'), false, 'stored session primary title must not fall back to cwd basename');
    assert.ok(list.includes('storedSessionMeta'), 'cwd should move to secondary metadata');
});

test('code session live rows do not use cwd basename as primary title', () => {
    const list = read('public/manager/src/code/CodeSessionList.tsx');

    assert.ok(list.includes('liveSessionTitle'), 'CodeSessionList must centralize live title fallback');
    assert.ok(list.includes("session.title?.trim()"), 'live title must prefer returned JWC title when available');
    assert.ok(list.includes("session.sessionId.slice(0, 12)"), 'live title must fall back to stable session id prefix, not cwd');
    assert.ok(list.includes('liveSessionMeta'), 'live cwd should render as secondary metadata');
    assert.equal(list.includes('<span className="code-session-cwd">{cwdLabel(s.cwd)}</span>'), false, 'live session primary title must not be cwd basename');
});

test('code session list searches title firstMessage cwd and session id, then sorts before limit', () => {
    const list = read('public/manager/src/code/CodeSessionList.tsx');

    assert.ok(list.includes('storedSessionSearchText'), 'stored session search helper must exist');
    for (const token of ['session.sessionId', "session.title ?? ''", "session.firstMessage ?? ''", 'session.cwd']) {
        assert.ok(list.includes(token), `search helper must include ${token}`);
    }
    const sortIndex = list.indexOf('.sort((left, right) => storedSessionTime(right) - storedSessionTime(left))');
    const sliceIndex = list.indexOf('.slice(0, 20)');
    assert.ok(sortIndex > 0, 'stored sessions must sort by timestamp');
    assert.ok(sliceIndex > sortIndex, 'stored sessions must sort before applying visible limit');
    assert.ok(list.includes('Date.parse(session.updatedAt)'), 'stored timestamp must parse ACP updatedAt');
});

test('code canvas accepts replay user chunks and loads stored sessions without dropping replayed transcript', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const types = read('src/code-mode/types.ts');
    const host = read('src/code-mode/acp-host.ts');
    const client = read('public/manager/src/code/code-session-client.ts');

    assert.ok(types.includes('export interface CodeSessionReplayEvent'), 'backend session type must expose replay event fallback');
    assert.ok(types.includes('replayEvents?: CodeSessionReplayEvent[]'), 'backend session info must return replay events when captured');
    assert.ok(client.includes('export interface CodeSessionReplayEvent'), 'frontend client type must expose replay event fallback');
    assert.ok(client.includes('replayEvents?: CodeSessionReplayEvent[]'), 'frontend session type must carry replay events');
    assert.ok(host.includes('#replayCaptures = new Map<string, Set<CodeSessionReplayEvent[]>>()'), 'ACP host must support concurrent same-session replay captures');
    assert.ok(host.includes('const event = `code_${kind}`'), 'ACP host must reuse the same event name for publish and replay capture');
    assert.ok(host.includes('for (const capture of captures)'), 'ACP host must append replay events to all active load captures');
    assert.ok(host.includes('capture.push({ event, sessionId, update })'), 'ACP host must capture replay update payloads');
    assert.ok(host.includes('const replayCapture: CodeSessionReplayEvent[] = []'), 'loadSession must create a per-call replay capture');
    assert.ok(host.includes('captures.add(replayCapture)'), 'loadSession must register replay capture before session/load');
    assert.ok(host.includes('captures.delete(replayCapture)'), 'loadSession must remove replay capture in cleanup');
    assert.ok(host.includes('if (captures.size === 0) this.#replayCaptures.delete(sessionId)'), 'loadSession must delete empty capture sets');
    assert.ok(host.includes('if (replayCapture.length > 0) info.replayEvents = replayCapture'), 'loadSession must return captured replay fallback events');
    assert.ok(canvas.includes('function replayEventsToTranscriptEntries'), 'CodeCanvas must convert response replay fallback events into transcript entries');
    assert.ok(canvas.includes("kind === 'code_user_message_chunk'"), 'CodeCanvas must handle replayed user message chunks');
    assert.ok(canvas.includes("event.event === 'code_user_message_chunk'"), 'replay fallback must handle replayed user chunks');
    assert.ok(canvas.includes("event.event === 'code_agent_message_chunk'"), 'replay fallback must handle assistant chunks');
    assert.ok(canvas.includes("event.event === 'code_agent_thought_chunk'"), 'replay fallback must handle thought chunks');
    assert.ok(canvas.includes("event.event === 'code_tool_call'"), 'replay fallback must handle tool calls');
    assert.ok(canvas.includes("event.event === 'code_tool_call_update'"), 'replay fallback must handle tool call updates');
    assert.ok(canvas.includes("role: 'user', text"), 'replayed user chunks must render as user transcript entries');

    const loadBlockStart = canvas.indexOf('onLoadSession={(id, cwd) => {');
    const loadBlockEnd = canvas.indexOf('onNewSession=', loadBlockStart);
    assert.ok(loadBlockStart > 0 && loadBlockEnd > loadBlockStart, 'stored session load handler must be present');
    const loadBlock = canvas.slice(loadBlockStart, loadBlockEnd);

    const refIndex = loadBlock.indexOf('activeSessionIdRef.current = id');
    const activeIndex = loadBlock.indexOf('setActiveSessionId(id)');
    const clearIndex = loadBlock.indexOf('setMessages([])');
    const loadIndex = loadBlock.indexOf('client.loadSession(id, cwd)');
    assert.ok(refIndex >= 0 && refIndex < loadIndex, 'activeSessionIdRef must be set before client.loadSession');
    assert.ok(activeIndex >= 0 && activeIndex < loadIndex, 'active session state must be set before client.loadSession');
    assert.ok(clearIndex >= 0 && clearIndex < loadIndex, 'transcript must be cleared before replay can arrive');
    assert.equal(loadBlock.indexOf('setMessages([])', loadIndex), -1, 'success path must not clear replayed transcript after load');
    assert.equal(loadBlock.indexOf("setSessionTitle('')", loadIndex), -1, 'success path must not clear loaded title after load');
    assert.ok(loadBlock.includes('const session = await client.loadSession(id, cwd)'), 'load handler must read returned session metadata');
    assert.ok(loadBlock.includes('if (session.title) setSessionTitle(session.title)'), 'load handler must preserve returned JWC title in header');
    assert.ok(loadBlock.includes('const replayFallback = replayEventsToTranscriptEntries(session.replayEvents ?? [])'), 'load handler must convert returned replay fallback events');
    assert.ok(loadBlock.includes('setMessages(prev => prev.length > 0 ? prev : replayFallback)'), 'replay fallback must only apply when SSE did not already populate transcript');
    assert.equal(loadBlock.includes('messages.length'), false, 'load handler must not read stale messages.length after await');
    assert.ok(loadBlock.includes('if (activeSessionIdRef.current === id)'), 'load failure must only restore state when failed id is still active');
});

test('code canvas owns code cwd override independent from manager instance selection', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');

    assert.ok(canvas.includes('const [codeWorkingDir, setCodeWorkingDir] = useState(workingDir)'), 'CodeCanvas must keep an internal Code cwd override');
    assert.ok(canvas.includes('const handleWorkingDirChange = useCallback'), 'CodeCanvas must own the cwd apply handler');
    assert.ok(canvas.includes('setCodeWorkingDir(next)'), 'cwd apply must update Code mode immediately before parent persistence');
    assert.ok(canvas.includes('onWorkingDirChange?.(path)'), 'cwd apply should still persist through the manager settings bridge');
    assert.ok(canvas.includes('client.getGitInfo(codeWorkingDir)'), 'git/worktree context must use the Code cwd override');
    assert.ok(canvas.includes('const cwd = codeWorkingDir ||'), 'new sessions must be created in the Code cwd override');
    assert.ok(canvas.includes('workingDir={codeWorkingDir}'), 'session list, header, and transcript must render the Code cwd override');
    assert.equal(canvas.includes('const cwd = workingDir ||'), false, 'new sessions must not fall back to the manager instance workingDir prop');
});

test('code cwd picker is editable only before a Code session starts', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const header = read('public/manager/src/code/CodeWorkspaceHeader.tsx');
    const css = read('public/manager/src/code/code.css');

    assert.ok(header.includes("import { getDesktop } from '../panels/desktop-bridge'"), 'CodeWorkspaceHeader must use the existing Electron desktop bridge');
    assert.ok(header.includes('cwdLocked?: boolean'), 'CodeWorkspaceHeader props must include cwdLocked');
    assert.ok(header.includes('cwdLocked = false'), 'CodeWorkspaceHeader must default cwdLocked to false for web/pre-session use');
    assert.ok(header.includes('const canApplyCwd = Boolean(!cwdLocked'), 'Apply must be disabled while a Code session is active');
    assert.ok(header.includes('const canPickCwd = Boolean(!cwdLocked'), 'native folder picker must be disabled while a Code session is active');
    assert.ok(header.includes('desktop?.folder?.pickFolder'), 'header must call the existing Electron folder picker bridge');
    assert.ok(header.includes('const result = await desktop.folder.pickFolder()'), 'Browse must await the native folder picker');
    assert.ok(header.includes('disabled={cwdLocked}'), 'cwd input must be disabled while locked');
    assert.ok(header.includes('aria-readonly={cwdLocked}'), 'cwd input must expose readonly state to assistive tech');
    assert.ok(header.includes('code-workspace-cwd-lock'), 'header must render a compact locked cwd hint');
    assert.ok(header.includes('code-workspace-cwd-error'), 'header must render picker errors without blocking the app');

    const syncStart = canvas.indexOf('useEffect(() => {');
    const syncEnd = canvas.indexOf('const handleWorkingDirChange', syncStart);
    const syncBlock = canvas.slice(syncStart, syncEnd);
    assert.ok(syncBlock.includes('if (activeSessionIdRef.current || activeSessionId) return'), 'workingDir prop sync must not overwrite cwd while a session is active');
    assert.ok(syncBlock.includes('setCodeWorkingDir(workingDir)'), 'workingDir prop sync must still update cwd before a session starts');

    const handlerStart = canvas.indexOf('const handleWorkingDirChange = useCallback');
    const handlerEnd = canvas.indexOf('}, [activeSessionId, onWorkingDirChange])', handlerStart);
    const handlerBlock = canvas.slice(handlerStart, handlerEnd);
    assert.ok(handlerBlock.includes('if (activeSessionIdRef.current || activeSessionId) return'), 'manual cwd changes must be ignored while a session is active');
    assert.ok(handlerBlock.includes('setCodeWorkingDir(next)'), 'manual cwd changes must still update cwd before a session starts');
    assert.ok(canvas.includes('cwdLocked={Boolean(activeSessionId)}'), 'CodeCanvas must pass active session lock state to the header');

    for (const selector of ['.code-workspace-cwd-pick', '.code-workspace-cwd-lock', '.code-workspace-cwd-error', '.code-workspace-cwd-input:disabled']) {
        assert.ok(css.includes(selector), `code.css must include ${selector}`);
    }
});

test('code transcript preserves failed tool state and remains scrollable after replay', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const transcript = read('public/manager/src/code/CodeTranscript.tsx');
    const css = read('public/manager/src/code/code.css');

    assert.ok(canvas.includes('function normalizeToolStatus'), 'CodeCanvas must centralize tool status normalization');
    assert.ok(canvas.includes("if (value === 'failed' || value === 'error' || value === 'errored') return 'failed'"), 'failed/error tool statuses must normalize to failed');
    assert.ok(canvas.includes("toolStatus: normalizeToolStatus(status)"), 'tool call creation must preserve failed status instead of mapping it to done');
    assert.ok(canvas.includes('if (status) entry.toolStatus = normalizeToolStatus(status)'), 'tool call updates must preserve failed status instead of mapping it to done');
    assert.equal(canvas.includes("status === 'completed' || status === 'failed' ? 'done'"), false, 'failed tool statuses must not be coerced to done');
    assert.equal(canvas.includes("status === 'completed' || status === 'failed') entry.toolStatus = 'done'"), false, 'failed tool updates must not be coerced to done');

    assert.ok(canvas.includes('const scrollTranscriptToBottom = useCallback'), 'CodeCanvas must centralize transcript bottom scrolling');
    assert.ok(canvas.includes('const latestTranscriptFootprint = useMemo'), 'CodeCanvas must track rendered transcript changes for replay/load scroll');
    assert.ok(canvas.includes('}, [latestTranscriptFootprint, sending, scrollTranscriptToBottom])'), 'auto-scroll must run from rendered message state, not only event delivery');

    assert.ok(transcript.includes('role="log"'), 'transcript must expose log semantics');
    assert.ok(transcript.includes('aria-live="polite"'), 'transcript must announce appended output politely');
    assert.ok(transcript.includes('tabIndex={0}'), 'transcript must be keyboard focusable for scroll keys');
    assert.ok(transcript.includes('function handleTranscriptKeyDown'), 'transcript must own keyboard scroll handling');
    for (const token of ["key === 'd'", "key === 'j'", "event.key === 'PageDown'", "event.key === 'End'"]) {
        assert.ok(transcript.includes(token), `transcript keyboard handler must include ${token}`);
    }
    assert.ok(transcript.includes('isEditableTarget(event.target)'), 'transcript must not steal keys from composer inputs');
    assert.ok(transcript.includes("open={status === 'running' || failed}"), 'failed tools must open by default so error details are visible');
    assert.ok(transcript.includes("failed ? 'fail' : 'done'"), 'failed tools must not show the done icon label');
    assert.ok(transcript.includes('code-tool-error-snippet'), 'failed tools must show a visible error snippet');

    assert.ok(css.includes('.code-canvas-main'), 'code.css must style the Code main pane');
    assert.ok(css.includes('min-height: 0;'), 'code.css must include flex min-height containment');
    assert.ok(css.includes('scroll-padding-bottom: 160px'), 'transcript must reserve bottom scroll space near composer/footer');
    assert.ok(css.includes('.code-transcript:focus-visible'), 'keyboard-focused transcript must show focus affordance');
    assert.ok(css.includes('.code-tool-failed'), 'failed tool rows must have distinct styling');
    assert.ok(css.includes('.code-tool-error-snippet'), 'failed tool error snippet must be styled');
});

test('code backend normalizes JWC session title metadata and returns title on load', () => {
    const types = read('src/code-mode/types.ts');
    const host = read('src/code-mode/acp-host.ts');
    const client = read('public/manager/src/code/code-session-client.ts');

    assert.ok(types.includes('title?: string;'), 'CodeSessionInfo must carry optional title');
    assert.ok(types.includes('StoredCodeSessionInfo'), 'stored session metadata type must exist');
    for (const token of ['firstMessage?: string', 'updatedAt?: string', 'messageCount?: number', 'size?: number']) {
        assert.ok(types.includes(token), `stored metadata type must include ${token}`);
        assert.ok(client.includes(token), `frontend stored metadata type must include ${token}`);
    }

    assert.ok(host.includes('function normalizeStoredSession'), 'ACP host must normalize stored session metadata');
    assert.ok(host.includes("stringField(raw['title'])"), 'backend must normalize title');
    assert.ok(host.includes("stringField(raw['firstMessage'])"), 'backend must normalize firstMessage');
    assert.ok(host.includes("stringField(raw['updatedAt'])"), 'backend must normalize updatedAt');
    assert.ok(host.includes("objectField(raw['_meta'])"), 'backend must normalize ACP _meta');
    assert.ok(host.includes("numberField(meta['messageCount'])"), 'backend must normalize messageCount');
    assert.ok(host.includes("numberField(meta['size'])"), 'backend must normalize size');
    assert.ok(host.includes('const stored = await this.#findStoredSession(sessionId, cwd)'), 'loadSession must find stored metadata');
    assert.ok(host.includes('if (stored?.title) info.title = stored.title'), 'loadSession must attach stored title to returned session');
});
