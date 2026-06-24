import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let cachedPython: string | null | undefined;
let cachedAvailable: boolean | undefined;

async function detectPython(): Promise<string | null> {
    if (cachedPython !== undefined) return cachedPython;
    for (const name of ['python3', 'python']) {
        try {
            const { stdout } = await execFileAsync(name, ['--version']);
            if (stdout.includes('Python 3')) {
                cachedPython = name;
                return name;
            }
        } catch { /* not found */ }
    }
    cachedPython = null;
    return null;
}

async function detectCamoufox(): Promise<boolean> {
    if (cachedAvailable !== undefined) return cachedAvailable;
    const python = await detectPython();
    if (!python) { cachedAvailable = false; return false; }
    try {
        await execFileAsync(python, ['-c', 'from camoufox.sync_api import Camoufox; print("ok")'], { timeout: 10_000 });
        cachedAvailable = true;
        return true;
    } catch {
        cachedAvailable = false;
        return false;
    }
}

export interface CamoufoxResult {
    ok: boolean;
    html: string;
    title: string;
    url: string;
}

export async function fetchViaCamoufox(
    url: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<CamoufoxResult | null> {
    // P0-6: bail before spawning if the overall deadline already fired.
    if (options?.signal?.aborted) return null;
    const available = await detectCamoufox();
    if (!available) return null;

    const python = cachedPython!;
    const timeout = Math.ceil((options?.timeoutMs || 30_000) / 1000);
    const script = [
        'import json, sys',
        'from camoufox.sync_api import Camoufox',
        `url = ${JSON.stringify(url)}`,
        `timeout = ${timeout * 1000}`,
        'with Camoufox(headless=True) as browser:',
        '    page = browser.new_page()',
        '    page.goto(url, timeout=timeout)',
        '    title = page.title()',
        '    html = page.content()',
        '    print(json.dumps({"ok": True, "title": title, "html": html, "url": url}))',
    ].join('\n');

    try {
        const { stdout } = await execFileAsync(python, ['-c', script], {
            timeout: (timeout + 30) * 1000,
            maxBuffer: 10_000_000,
            // P0-6: kill the Camoufox subprocess if the overall deadline fires.
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        const result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
        return result as CamoufoxResult;
    } catch {
        return null;
    }
}

export { detectCamoufox, detectPython };
