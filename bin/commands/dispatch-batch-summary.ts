export interface BatchDispatchResultSummary {
    agent: string;
    ok: boolean;
    runId?: string;
    status?: string;
    preview?: string;
    recoveryCommand?: string;
    outputBytes?: number;
    error?: string;
}

function compact(value: unknown, max = 240): string {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function byteLabel(value: number | undefined): string {
    if (!value) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function printBatchDispatchSummary(results: BatchDispatchResultSummary[]): number {
    let exitCode = 0;
    for (const result of results) {
        const statusIcon = result.ok ? '✅' : '❌';
        console.log(`\n${statusIcon} ${result.agent}`);
        console.log(`  status: ${result.status || (result.ok ? 'done' : 'error')}`);
        if (result.runId) console.log(`  runId: ${result.runId}`);
        const preview = compact(result.preview || result.error);
        if (preview) console.log(`  ${result.ok ? 'preview' : 'error'}: ${preview}`);
        const bytes = byteLabel(result.outputBytes);
        if (bytes) console.log(`  outputBytes: ${bytes}`);
        const recovery = result.recoveryCommand || (result.runId ? `cli-jaw worker read ${result.runId} --tail 120` : '');
        if (recovery) console.log(`  output: ${recovery}`);
        if (!result.ok) exitCode = 1;
    }
    return exitCode;
}
