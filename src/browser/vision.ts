/**
 * src/browser/vision.js — Vision Click coordinate extraction
 * Phase 2: Codex provider only. Phase 3: + Gemini/Claude REST.
 */
import { spawn } from 'child_process';
import { screenshot, mouseClick, snapshot } from './actions.ts';

/**
 * Extract click coordinates from screenshot using vision AI.
 * @param {string} screenshotPath - Path to screenshot image
 * @param {string} target - Description of element to find
 * @param {object} opts - { provider: 'codex' }
 * @returns {Promise<{ found: boolean, x: number, y: number, description?: string, provider: string }>}
 */
export async function extractCoordinates(screenshotPath, target, opts = {}) {
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
function codexVision(screenshotPath, target) {
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
                        const event = JSON.parse(line);
                        const textsToSearch = [];

                        // Collect text from all event types
                        if (event.item?.text) textsToSearch.push(event.item.text);
                        if (event.item?.aggregated_output) textsToSearch.push(event.item.aggregated_output);

                        for (const text of textsToSearch) {
                            // Try to extract {"found":...,"x":...,"y":...} from text
                            const jsonMatch = text.match(/\{[^{}]*"found"\s*:\s*(true|false)[^{}]*"x"\s*:\s*\d+[^{}]*"y"\s*:\s*\d+[^{}]*\}/);
                            if (jsonMatch) {
                                const coords = JSON.parse(jsonMatch[0]);
                                if (typeof coords.x === 'number' && typeof coords.y === 'number') {
                                    return resolve({ ...coords, provider: 'codex' });
                                }
                            }
                        }
                    } catch { /* skip non-JSON lines */ }
                }
                reject(new Error('No coordinate JSON found in codex output'));
            } catch (e) {
                reject(new Error(`Failed to parse codex output: ${e.message}`));
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
export async function visionClick(port, target, opts = {}) {
    // 1. Screenshot (includes DPR)
    const ss = await screenshot(port);
    const dpr = ss.dpr || 1;

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
    const cssX = Math.round(result.x / dpr);
    const cssY = Math.round(result.y / dpr);

    // 4. Click
    await mouseClick(port, cssX, cssY, { doubleClick: opts.doubleClick });

    // 5. Verify (optional snapshot)
    let snap = null;
    try { snap = await snapshot(port, { interactive: true }); } catch { }

    return {
        success: true,
        clicked: { x: cssX, y: cssY },
        raw: { x: result.x, y: result.y },
        dpr,
        provider: result.provider,
        description: result.description,
        snap,
    };
}
