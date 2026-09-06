/** Captured server response identity; clients must not derive execution scopes. */
export interface ActivityIdentity { sessionId: string; scope: string; }

export function parseActivityIdentity(value: unknown): ActivityIdentity | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 240;
    return id(input['sessionId']) && id(input['scope'])
        ? { sessionId: input['sessionId'], scope: input['scope'] } : null;
}
