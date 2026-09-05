import type { RuntimeTransport as SharedRuntimeTransport } from '../../../../../../src/shared/runtime-contract';

export function canSelectRuntimeTransport(cli: string): boolean {
    return cli === 'cursor' || cli === 'grok' || cli === 'claude';
}

export function transportFieldValue(value: unknown): SharedRuntimeTransport {
    return value === 'native' ? 'native' : 'print';
}

export function transportFieldPatch(cli: string, value: string): Record<string, unknown> {
    if (!canSelectRuntimeTransport(cli)) throw new Error('runtime_transport_not_selectable');
    if (value !== 'native' && value !== 'print') throw new Error('invalid_runtime_transport');
    return { [`perCli.${cli}.transport`]: value };
}
