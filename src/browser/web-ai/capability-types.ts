export type WebAiVendorScope = 'chatgpt' | 'gemini' | 'grok' | 'shared';

export type CapabilityStatus =
    | 'implemented-30_browser'
    | 'ported-cli-jaw'
    | 'planned'
    | 'fail-closed'
    | 'rejected-until-verified'
    | 'deferred'
    | 'out-of-scope'
    | 'unknown';

export type CapabilityFamily =
    | 'modelSelection'
    | 'attachments'
    | 'webSearch'
    | 'tools'
    | 'imageGeneration'
    | 'deepThink'
    | 'responseCapture'
    | 'sessionReattach'
    | 'stopGeneration'
    | 'copyOrExport'
    | 'diagnostics'
    | 'productSurface'
    | 'safety';

export type FrontendObservationStatus = 'observed' | 'actionable' | 'schema-ready' | 'implemented' | 'unsupported' | 'unstable' | 'not-observed';
export type MutationRisk = 'none' | 'read-only' | 'low' | 'medium' | 'high';

export interface FrontendCapabilityObservation {
    status: FrontendObservationStatus;
    source: 'live-frontend' | 'code-inventory' | 'oracle-audit' | 'planning';
    selectorCandidates: string[];
    textCandidates: string[];
    activationPath: string[];
    activeStateSignals: string[];
    mutationRisk: MutationRisk;
    notes: string[];
}

export interface CapabilityEntry {
    id: string;
    vendor: WebAiVendorScope;
    status: CapabilityStatus;
    ownerPrd: string;
    commandBehavior: string;
    browserMutationAllowed: boolean;
    failClosedStage?: string;
    requiredOfficialDocs: string[];
    browserGate: 'present' | 'partial' | 'absent';
    cliJawPortGate: 'present' | 'partial' | 'absent';
    family?: CapabilityFamily;
    observation?: FrontendCapabilityObservation;
}

export interface CapabilitySchemaRow {
    providerId: WebAiVendorScope;
    capabilityId: string;
    family: CapabilityFamily | 'unclassified';
    status: CapabilityStatus;
    frontendStatus: FrontendObservationStatus;
    mutationAllowed: boolean;
    activationPath: string[];
    activeStateSignals: string[];
    failureStage: string;
}

