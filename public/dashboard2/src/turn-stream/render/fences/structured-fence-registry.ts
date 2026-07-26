import type { ComponentType } from 'react';
import type { RenderIdentity } from '../../render/parse-coalescer.ts';
import { ElicitationFence, parseElicitationSpec, type ElicitationSpec } from './ElicitationFence.tsx';
import { SearchResultsFence, normalizeSearchResultsSpec, type SearchResultsSpec } from './SearchResultsFence.tsx';
import { DataframeFence, normalizeDataframeSpec, type DataframeSpec } from './DataframeFence.tsx';
import { ChartJsonFence, normalizeChartJsonSpec, type ChartJsonSpec } from './ChartJsonFence.tsx';
import { ComposeBlockFence, normalizeComposeBlockSpec, type ComposeBlockSpec } from './ComposeBlockFence.tsx';
export type StructuredFenceKind = 'elicitation'|'choice-buttons'|'search-results'|'compose-block'|'dataframe'|'chart-json';
export type StructuredFenceSpec = ElicitationSpec | SearchResultsSpec | DataframeSpec | ChartJsonSpec | ComposeBlockSpec;
export interface StructuredFenceInput { fenceKind: StructuredFenceKind | string; rawSpec: string; ordinal: number; sourceHash?: string }
export type StructuredFenceComponentProps = { spec: never; identity?: RenderIdentity; slotId?: string };
export interface StructuredFenceSuccess { kind: 'component'; fenceKind: StructuredFenceKind; spec: StructuredFenceSpec; component: ComponentType<StructuredFenceComponentProps> }
export interface StructuredFenceFallback { kind: 'fallback'; escapedSource: string; error: string }
export type StructuredFenceDescriptor = StructuredFenceSuccess | StructuredFenceFallback;
export function parseJson<T>(raw: string, normalize: (value: unknown) => T | null): T | null { try { return normalize(JSON.parse(raw)); } catch { return null; } }
type Entry = { parse(raw: string): StructuredFenceSpec | null; component: ComponentType<StructuredFenceComponentProps> };
const entry = <T,>(parse: (raw: string) => T | null, component: ComponentType<{ spec: T; identity?: RenderIdentity; slotId?: string }>): Entry => ({ parse: parse as (raw: string) => StructuredFenceSpec | null, component: component as ComponentType<StructuredFenceComponentProps> });
export const structuredFenceRegistry: Readonly<Record<StructuredFenceKind, Entry>> = Object.freeze({
    elicitation: entry(parseElicitationSpec, ElicitationFence), 'choice-buttons': entry(parseElicitationSpec, ElicitationFence),
    'search-results': entry(raw => parseJson(raw, normalizeSearchResultsSpec), SearchResultsFence), dataframe: entry(raw => parseJson(raw, normalizeDataframeSpec), DataframeFence),
    'chart-json': entry(raw => parseJson(raw, normalizeChartJsonSpec), ChartJsonFence), 'compose-block': entry(raw => parseJson(raw, normalizeComposeBlockSpec), ComposeBlockFence),
});
export function resolveStructuredFence(input: StructuredFenceInput): StructuredFenceDescriptor { const kind = input.fenceKind as StructuredFenceKind, owner = structuredFenceRegistry[kind]; if (!owner) return { kind: 'fallback', escapedSource: input.rawSpec, error: 'Unsupported structured fence.' }; const spec = owner.parse(input.rawSpec); return spec ? { kind: 'component', fenceKind: kind, spec, component: owner.component } : { kind: 'fallback', escapedSource: input.rawSpec, error: 'Invalid structured fence specification.' }; }
