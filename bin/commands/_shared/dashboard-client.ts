// One way to call the dashboard, shared by the commands that do (devlog 034).
//
// Two copies of this existed, identical down to the truncation of the error body, and
// each carried its own hardcoded base path. A caller now says which surface it wants and
// what to call itself in an error, so the two cannot drift apart again.

import { DASHBOARD_DEFAULT_PORT } from '../../../src/manager/constants.js';

// Re-exported so a command can name the default port in its help text without reaching
// past this module for it.
export { DASHBOARD_DEFAULT_PORT };

export function dashboardPort(): number {
    const fromEnv = Number(process.env["DASHBOARD_PORT"]);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : Number(DASHBOARD_DEFAULT_PORT);
}

export type DashboardRequest = {
    /** Mounted surface, e.g. `/api/dashboard/memory`. */
    basePath: string;
    /** Path under the surface, already query-encoded. */
    path: string;
    /** What this command calls itself when something fails. */
    label: string;
    body?: unknown;
    fetchImpl?: typeof fetch;
};

/**
 * Calls the dashboard and returns the parsed JSON, or throws with a message that names
 * the command the user actually ran.
 */
export async function callDashboard<T>(options: DashboardRequest): Promise<T> {
    const port = dashboardPort();
    const url = `http://127.0.0.1:${port}${options.basePath}${options.path}`;
    const doFetch = options.fetchImpl ?? fetch;
    const hasBody = options.body !== undefined;

    let res: Response;
    try {
        res = await doFetch(url, {
            ...(hasBody ? { method: 'POST', body: JSON.stringify(options.body) } : {}),
            headers: {
                host: `127.0.0.1:${port}`,
                ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
            },
        });
    } catch (err) {
        throw new Error(
            `${options.label} unreachable at :${port} — run \`jaw dashboard serve\` first. (${(err as Error).message})`,
        );
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${options.label} ${options.path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
}
