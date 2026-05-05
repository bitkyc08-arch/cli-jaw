/**
 * src/browser/vision.js — Vision Click coordinate extraction
 * Phase 2: Codex provider only. Phase 3: + Gemini/Claude REST.
 */
import { spawn } from 'child_process';
import { screenshot, mouseClick, snapshot } from './actions.js';

export interface VisionClickOptions {
    provider?: 'codex';
    doubleClick?: boolean;
    prepareStable?: boolean;
    region?: 'left-panel' | 'center-map' | 'top-bar';
    clip?: { x: number; y: number; width: number; height: number };
    verifyBeforeClick?: boolean;
}

type JsonRecord = Record<string, unknown>;
type VisionCoordinates = {
    found: boolean;
    x: number;
    y: number;
    description?: string;
    provider: 'codex';
};

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function recordText(record: JsonRecord, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' ? value : null;
}

function parseVisionCoordinates(value: unknown): VisionCoordinates | null {
    if (!isRecord(value)) return null;
    if (typeof value.found !== 'boolean') return null;
    if (typeof value.x !== 'number' || typeof value.y !== 'number') return null;
    return {
        found: value.found,
        x: value.x,
        y: value.y,
        provider: 'codex',
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
    };
}

function collectEventTexts(value: unknown): string[] {
    if (!isRecord(value) || !isRecord(value.item)) return [];
    return [
        recordText(value.item, 'text'),
        recordText(value.item, 'aggregated_output'),
    ].filter((text): text is string => Boolean(text));
}

/**
 * Extract click coordinates from screenshot using vision AI.
 * @param {string} screenshotPath - Path to screenshot image
 * @param {string} target - Description of element to find
 * @param {object} opts - { provider: 'codex' }
 * @returns {Promise<{ found: boolean, x: number, y: number, description?: string, provider: string }>}
 */
export async function extractCoordinates(screenshotPath: string, target: string, opts: VisionClickOptions = {}): Promise<VisionCoordinates> {
    const provider = opts.provider || 'codex';
    switch (provider) {
        case 'codex': return codexVision(screenshotPath, target);
        default: throw new Error(`Unknown vision provider: ${provider}. Phase 2 supports 'codex' only.`);
    }
}

/**
 * Codex CLI vision provider.
 * Spawns `codex exec -i <image> --json` and parses NDJSON response.
 */
function codexVision(screenshotPath: string, target: string): Promise<VisionCoordinates> {
    const prompt = [
        `Look at this screenshot image carefully.`,
        `Find the UI element "${target}" and return its center pixel coordinate.`,
        `You MUST respond with ONLY this JSON format, nothing else:`,
        `{"found":true,"x":<int>,"y":<int>,"description":"<brief description>"}`,
        `If not found: {"found":false,"x":0,"y":0,"description":"not found"}`,
        `IMPORTANT: Do NOT run any commands. Just analyze the image visually and return the JSON.`,
    ].join(' ');

    return new Promise((resolve, reject) => {
        const args = [
            'exec', '-i', screenshotPath, '--json',
            '--dangerously-bypass-approvals-and-sandbox',
            '--skip-git-repo-check',
            prompt,
        ];

        const child = spawn('codex', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60000,
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);

        child.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`codex exec failed (code ${code}): ${stderr.slice(0, 200)}`));
            }

            try {
                const lines = stdout.split('\n').filter(l => l.trim());

                // Scan ALL events for coordinate JSON (agent_message, command output, etc.)
                // Codex is agentic — JSON may appear in any event type
                for (const line of lines.reverse()) { // Reverse: last message most likely has the answer
                    try {
                        const event: unknown = JSON.parse(line);
                        const textsToSearch = collectEventTexts(event);

                        for (const text of textsToSearch) {
                            // Try to extract {"found":...,"x":...,"y":...} from text
                            const jsonMatch = text.match(/\{[^{}]*"found"\s*:\s*(true|false)[^{}]*"x"\s*:\s*\d+[^{}]*"y"\s*:\s*\d+[^{}]*\}/);
                            if (jsonMatch) {
                                const coords = parseVisionCoordinates(JSON.parse(jsonMatch[0]));
                                if (coords) return resolve(coords);
                            }
                        }
                    } catch { /* skip non-JSON lines */ }
                }
                reject(new Error('No coordinate JSON found in codex output'));
            } catch (e) {
                reject(new Error(`Failed to parse codex output: ${(e as Error).message}`));
            }
        });

        child.on('error', (e) => reject(new Error(`Failed to spawn codex: ${e.message}`)));
    });
}

/**
 * Full vision-click pipeline: screenshot → vision → DPR correction → click → verify.
 * @param {number} port - CDP port
 * @param {string} target - Element description (e.g. "Login button")
 * @param {object} opts - { provider, doubleClick }
 */
export function resolveRegionClip(region: VisionClickOptions['region'], viewport: { width: number; height: number } | null) {
    if (!region || !viewport) return undefined;
    if (region === 'left-panel') return { x: 0, y: 0, width: Math.round(viewport.width * 0.33), height: viewport.height };
    if (region === 'center-map') return { x: Math.round(viewport.width * 0.25), y: 0, width: Math.round(viewport.width * 0.5), height: viewport.height };
    if (region === 'top-bar') return { x: 0, y: 0, width: viewport.width, height: Math.round(viewport.height * 0.2) };
    return undefined;
}

export function toCssPoint(raw: { x: number; y: number }, dpr: number, clip?: { x: number; y: number }) {
    return {
        x: Math.round(raw.x / dpr + (clip?.x || 0)),
        y: Math.round(raw.y / dpr + (clip?.y || 0)),
    };
}

export async function visionClick(port: number, target: string, opts: VisionClickOptions = {}) {
    if (opts.prepareStable) await new Promise(r => setTimeout(r, 500));

    // 1. Screenshot (includes DPR)
    const viewportProbe = await screenshot(port, { json: true });
    const clip = opts.clip || resolveRegionClip(opts.region, viewportProbe.viewport);
    const ss = clip ? await screenshot(port, { clip, json: true }) : viewportProbe;
    const dpr = typeof ss.dpr === 'number' && Number.isFinite(ss.dpr) ? ss.dpr : 1;

    // 2. Vision → coordinates (image pixel space)
    const result = await extractCoordinates(ss.path, target, {
        provider: opts.provider || 'codex',
    });

    if (!result.found) {
        return { success: false, reason: 'target not found', provider: result.provider };
    }

    // 3. DPR correction: image pixels → CSS pixels
    // Playwright screenshots are captured at device pixel resolution
    // page.mouse.click() expects CSS pixels
    const css = toCssPoint({ x: result.x, y: result.y }, dpr, clip);

    if (opts.verifyBeforeClick) {
        const verify = await extractCoordinates(ss.path, target, { provider: opts.provider || 'codex' });
        if (!verify.found) return { success: false, reason: 'verification failed', provider: result.provider };
    }

    // 4. Click
    await mouseClick(port, css.x, css.y, { doubleClick: opts.doubleClick });

    // 5. Verify (optional snapshot)
    let snap = null;
    try { snap = await snapshot(port, { interactive: true }); } catch { }

    return {
        success: true,
        clicked: css,
        raw: { x: result.x, y: result.y },
        clip,
        dpr,
        provider: result.provider,
        description: result.description,
        snap,
    };
}
