import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { CodeControllerModel, CodeControllerOptions } from './code-controller-types';
import { CodeController } from './code-controller-runtime';
import { codeBaseOrigin } from './code-session-client';
import { useCodeEvents } from './useCodeEvents';

export type { CodeControllerModel, CodeControllerOptions } from './code-controller-types';

export function useCodeController({ port, workingDir }: CodeControllerOptions): CodeControllerModel {
    const endpoint = codeBaseOrigin(port);
    const controller = useMemo(() => new CodeController({ port, workingDir }), [endpoint, port]);
    useEffect(() => controller.mount(), [controller]);
    useEffect(() => controller.setWorkingDir(workingDir), [controller, workingDir]);
    useCodeEvents({ port, onEvent: controller.onEvent, onTransport: controller.onTransport });
    return useSyncExternalStore(controller.subscribe, controller.getModel, controller.getModel);
}
