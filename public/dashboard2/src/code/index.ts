// 060/061 — the ONLY public entry of the Code lazy boundary. The shell reaches
// this module exclusively through `import('../code/index.ts')` (React.lazy).
// The entry exports the capability GATE (small chunk); the heavy Code
// implementation (CodeTab + source adapter) loads through the gate's nested
// dynamic import only when the capability probe reports available (061).
export { CodeTabGate, default } from './CodeTabGate.tsx';
export { fetchCodeCapabilities, type CodeCapabilityState, type CodeCapabilityReason } from './code-capability-client.ts';
export {
    fetchHistorySummaries,
    toHistorySummaries,
    type CodeHistorySummary,
} from './code-history-adapter.ts';
