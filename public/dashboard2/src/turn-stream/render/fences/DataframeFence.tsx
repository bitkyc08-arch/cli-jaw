// @ts-nocheck -- normalized untrusted JSON is narrowed at runtime below.
import { useMemo, useState, type ReactElement } from 'react';
import { useRenderActionPorts } from '../../../providers/render-action-ports.tsx';

export type DataframeType = 'string' | 'number' | 'boolean' | 'date' | 'json';
export interface DataframeSpec { schemaVersion: 'dataframe-v1'; title: string; columns: string[]; types: DataframeType[]; rows: string[][]; pageSize: number }
const clip = (value: unknown, max = 240): string => { let out = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); out = out.trim(); return out.length > max ? `${out.slice(0, max - 1)}…` : out; };
export function normalizeDataframeSpec(raw: unknown): DataframeSpec | null {
    if (!raw || typeof raw !== 'object') return null; const obj = raw as Record<string, unknown>;
    if (obj.schemaVersion !== 'dataframe-v1') return null;
    const columns = (Array.isArray(obj.columns) ? obj.columns : []).map(v => clip(v, 80)).filter(Boolean).slice(0, 20); if (!columns.length) return null;
    const source = Array.isArray(obj.rows) ? obj.rows : Array.isArray(obj.data) ? obj.data : [];
    const rows = source.filter((r): r is unknown[] => Array.isArray(r)).slice(0, 500).map(r => columns.map((_, i) => clip(r[i])));
    const rawTypes = Array.isArray(obj.types) ? obj.types : [];
    const types = columns.map((_, i): DataframeType => ['number', 'boolean', 'date', 'json'].includes(String(rawTypes[i])) ? rawTypes[i] as DataframeType : 'string');
    const requested = typeof obj.pageSize === 'number' && Number.isFinite(obj.pageSize) ? Math.floor(obj.pageSize) : 25;
    return { schemaVersion: 'dataframe-v1', title: clip(obj.title, 120) || 'Dataframe', columns, types, rows, pageSize: Math.max(5, Math.min(100, requested)) };
}
export function DataframeFence({ spec }: { spec: DataframeSpec }): ReactElement {
    const ports = useRenderActionPorts(); const [filter, setFilter] = useState(''); const [sort, setSort] = useState<{ column: number; direction: 1 | -1 } | null>(null); const [page, setPage] = useState(0);
    const rows = useMemo(() => spec.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.some(cell => cell.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))).sort((a, b) => { if (!sort) return a.index - b.index; const av = a.row[sort.column] || '', bv = b.row[sort.column] || ''; const numeric = spec.types[sort.column] === 'number'; const compared = numeric ? (Number(av) - Number(bv)) : av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }); return (compared || a.index - b.index) * sort.direction; }), [filter, sort, spec]);
    const pages = Math.max(1, Math.ceil(rows.length / spec.pageSize)); const safePage = Math.min(page, pages - 1); const visible = rows.slice(safePage * spec.pageSize, (safePage + 1) * spec.pageSize);
    return <section className="dataframe-block"><header>{spec.title}</header><input aria-label="Filter rows" value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }} /><div className="d2-table-wrapper"><table><thead><tr>{spec.columns.map((column, i) => <th key={column}><button type="button" onClick={() => setSort(current => current?.column === i ? { column: i, direction: current.direction === 1 ? -1 : 1 } : { column: i, direction: 1 })}>{column}</button></th>)}</tr></thead><tbody>{visible.map(({ row, index }) => <tr key={index}>{row.map((cell, i) => <td key={i}><button type="button" onClick={() => { void ports.copyText(cell).then(() => ports.announce('Cell copied')); }}>{cell}</button></td>)}</tr>)}</tbody></table></div><footer><button disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>Previous</button><span>{safePage + 1}/{pages}</span><button disabled={safePage + 1 >= pages} onClick={() => setPage(p => p + 1)}>Next</button></footer></section>;
}
