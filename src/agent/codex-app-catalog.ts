// Model/effort pre-validation prevents unsupported combinations from hanging.
// The source of truth is model_catalog_json in $CODEX_HOME/config.toml.
import fs from 'node:fs';

export type CatalogEfforts = Map<string, Set<string>>;

export function resolveCatalogPath(env: NodeJS.ProcessEnv = process.env): string | null {
    const home = env['CODEX_HOME'] || null;
    if (!home) return null;
    const configPath = `${home}/config.toml`;
    let toml: string;
    try {
        toml = fs.readFileSync(configPath, 'utf8');
    } catch {
        return null;
    }
    const match = toml.match(/^\s*model_catalog_json\s*=\s*"([^"]+)"/m);
    return match?.[1] ?? null;
}

export function loadCatalogEfforts(catalogPath: string): CatalogEfforts {
    const efforts: CatalogEfforts = new Map();
    let raw: string;
    try {
        raw = fs.readFileSync(catalogPath, 'utf8');
    } catch {
        return efforts;
    }
    try {
        const parsed = JSON.parse(raw) as {
            models?: Array<{
                slug?: string;
                supported_reasoning_levels?: Array<{ effort?: string }>;
            }>;
        };
        for (const entry of parsed.models || []) {
            if (!entry.slug) continue;
            efforts.set(entry.slug, new Set(
                (entry.supported_reasoning_levels || [])
                    .map((level) => level.effort)
                    .filter((effort): effort is string => Boolean(effort)),
            ));
        }
    } catch {
        // Fail open when the external catalog is malformed.
    }
    return efforts;
}

export type EffortValidation =
    | { ok: true; skipped: 'no-catalog' | 'model-not-listed' }
    | { ok: true }
    | { ok: false; error: string };

export function validateModelEffort(
    model: string,
    effort: string,
    efforts: CatalogEfforts,
): EffortValidation {
    if (efforts.size === 0) return { ok: true, skipped: 'no-catalog' };
    const baseModel = model.replace(/\[[^\]]+\]$/, '');
    const supported = efforts.get(model) || (baseModel !== model ? efforts.get(baseModel) : undefined);
    if (!supported) return { ok: true, skipped: 'model-not-listed' };
    if (!effort || supported.has(effort)) return { ok: true };
    return {
        ok: false,
        error: `effort "${effort}" is not supported by ${model} (supported: ${[...supported].join(', ')})`,
    };
}
