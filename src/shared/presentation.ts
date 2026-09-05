export type PresentationMode = 'activity' | 'legacy';

export function isPresentationMode(value: unknown): value is PresentationMode {
    return value === 'activity' || value === 'legacy';
}

export function presentationMode(settings: unknown): PresentationMode {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'activity';
    const block = (settings as Record<string, unknown>)['presentation'];
    if (!block || typeof block !== 'object' || Array.isArray(block)) return 'activity';
    const mode = (block as Record<string, unknown>)['mode'];
    return isPresentationMode(mode) ? mode : 'activity';
}

/** Captured server response identity; clients must not derive execution scopes. */
export interface ActivityIdentity { sessionId: string; scope: string; }

export function parseActivityIdentity(value: unknown): ActivityIdentity | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 240;
    return id(input['sessionId']) && id(input['scope'])
        ? { sessionId: input['sessionId'], scope: input['scope'] } : null;
}
