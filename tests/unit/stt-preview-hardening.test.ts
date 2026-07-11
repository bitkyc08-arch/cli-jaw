import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const json = (path: string) => JSON.parse(read(path)) as Record<string, string>;

test('classic web STT recorder exposes pending/error states and preview lifecycle events', () => {
    const recorder = read('public/js/features/voice-recorder.ts');
    const css = read('public/css/chat.css');

    assert.ok(recorder.includes('let startPending = false'), 'recorder must guard duplicate getUserMedia requests');
    assert.ok(recorder.includes("postPreviewSttRecording('request')"), 'recorder must notify Manager before requesting the mic');
    assert.ok(recorder.includes("postPreviewSttRecording('failed')"), 'recorder must notify Manager when mic acquisition fails');
    assert.ok(recorder.includes('MIC_PERMISSION_TIMEOUT_MS'), 'recorder must not leave mic permission requests pending forever');
    assert.ok(recorder.includes('requestMicStreamWithTimeout'), 'recorder must wrap getUserMedia with a bounded request path');
    assert.ok(recorder.includes('isMicBlockedByDocumentPolicy'), 'recorder must fail before arming when Permissions Policy blocks microphone');
    assert.ok(recorder.includes("allowsFeature?.('microphone') === false"), 'recorder must check the browser microphone policy synchronously');
    assert.ok(recorder.includes('getMicrophonePermissionState'), 'recorder must preflight explicit browser microphone denials');
    assert.ok(recorder.includes("name: 'microphone' as PermissionName"), 'recorder must query the microphone permission state directly');
    assert.ok(recorder.includes('voice.permissionDeniedBrowser'), 'recorder must explain explicit browser-level microphone blocks');
    assert.ok(recorder.includes('voice.requestTimeoutLoopback'), 'recorder must explain localhost and 127.0.0.1 permission split on pending prompts');
    assert.ok(recorder.includes('Promise.race([mediaPromise, timeoutPromise])'), 'recorder must race getUserMedia against the permission timeout');
    assert.ok(recorder.includes("track => track.stop()"), 'late mic streams must be released after a timeout');
    assert.ok(recorder.includes('new MediaRecorder(stream, options)'), 'recorder must keep MediaRecorder creation inside the guarded start path');
    assert.ok(recorder.includes('catch (err)'), 'recorder start path must catch getUserMedia and MediaRecorder failures');
    assert.ok(recorder.includes("btn.classList.toggle('arming', pending)"), 'mic button must expose a pending visual state');
    assert.ok(recorder.includes("btn.toggleAttribute('aria-busy', pending)"), 'mic button must expose a pending accessibility state');
    assert.ok(recorder.includes('else void startRecording()'), 'toggleRecording must not leave an unhandled start promise');
    assert.ok(css.includes('.btn-voice.arming'), 'CSS must style the mic pending state');
});

test('classic web and Manager preview both support STT keyboard fallback and iframe bridging', () => {
    const main = read('public/js/main.ts');
    const preview = read('public/manager/src/InstancePreview.tsx');
    const app = read('public/manager/src/App.tsx');
    const bridge = read('public/manager/src/jaw-ceo/useJawCeoDashboardBridge.tsx');
    const lifecycle = read('public/manager/src/usePreviewSttLifecycle.ts');

    assert.ok(main.includes('function isVoiceRecordingShortcut'), 'classic Web must centralize STT shortcut matching');
    assert.ok(main.includes("e.code === 'KeyM'"), 'classic Web must support Alt/Option+M as a fallback shortcut');
    assert.ok(main.includes("data.type !== 'jaw-preview-stt-toggle'"), 'classic Web must listen for Manager preview STT toggles');
    assert.ok(main.includes('isLocalPreviewOrigin(event.origin)'), 'classic Web must origin-check preview STT messages');

    assert.ok(preview.includes('function postPreviewSttToggle'), 'Manager preview must post STT toggles into the iframe');
    assert.ok(preview.includes("type: 'jaw-preview-stt-toggle'"), 'Manager preview must use a dedicated STT toggle message');
    assert.ok(preview.includes("event.code === 'KeyM'"), 'Manager preview must support Alt/Option+M while parent has focus');
    assert.ok(preview.includes("document.addEventListener('keydown', onKeyDown, true)"), 'Manager preview must capture shortcuts before parent chrome handlers');
    assert.ok(preview.includes('previewTargetOrigin(src, frame)'), 'Manager preview STT messages must target the iframe origin');

    assert.ok(app.includes('usePreviewSttLifecycle(jawCeoBridge.voice, data)'), 'Manager App must install the preview STT lifecycle hook with scan-derived preview origins');
    assert.ok(lifecycle.includes("data?.type !== 'jaw-preview-stt-recording'"), 'Manager lifecycle hook must listen for child STT lifecycle messages');
    assert.ok(lifecycle.includes('isAllowedPreviewMessage(event, allowedOrigins)'), 'Manager lifecycle hook must allowlist child STT lifecycle message origins');
    assert.ok(lifecycle.includes('void voice.end()'), 'Manager lifecycle hook must release Jaw CEO realtime mic before preview STT starts');
    assert.ok(bridge.includes('voice,'), 'Jaw CEO dashboard bridge must expose the voice controller for STT coordination');
});

test('STT shortcut copy and locale strings mention the fallback shortcut', () => {
    for (const locale of ['ko', 'en', 'zh', 'ja']) {
        const values = json(`public/locales/${locale}.json`);
        assert.ok(values['voice.requesting'], `${locale} locale must name the mic-request pending state`);
        assert.ok(values['voice.requestTimeout'], `${locale} locale must explain stalled mic permission prompts`);
        assert.ok(values['voice.requestTimeoutLoopback'], `${locale} locale must explain loopback-origin mic permission prompts`);
        assert.ok(values['voice.policyBlocked'], `${locale} locale must explain browser policy-blocked microphone access`);
        assert.ok(values['voice.permissionDeniedBrowser'], `${locale} locale must explain browser-denied microphone access`);
        assert.ok(values['stt.shortcutHint'].includes('Alt/Option+M'), `${locale} STT hint must mention fallback shortcut`);
        assert.ok(values['help.keyboardShortcuts.howTo.1'].includes('Alt/Option+M'), `${locale} shortcut help must mention fallback shortcut`);
    }
    assert.ok(read('public/index.html').includes('Alt/Option+M'), 'static HTML fallback hint must mention fallback shortcut before i18n loads');
});
