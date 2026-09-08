import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

type PanelResizerProps = {
    direction: 'horizontal' | 'vertical';
    onDelta: (delta: number) => void;
    onEnd?: (() => void) | undefined;
    className?: string | undefined;
    ariaLabel?: string | undefined;
    ariaValueNow?: number | undefined;
    onDoubleClick?: (() => void) | undefined;
};

export function PanelResizer(props: PanelResizerProps) {
    const dragging = useRef(false);
    const lastPos = useRef(0);
    const startPos = useRef(0);
    const moved = useRef(false);
    const onDeltaRef = useRef(props.onDelta);
    const onEndRef = useRef(props.onEnd);
    const [isDragging, setIsDragging] = useState(false);
    const { direction } = props;

    useEffect(() => {
        onDeltaRef.current = props.onDelta;
        onEndRef.current = props.onEnd;
    }, [props.onDelta, props.onEnd]);

    const applyPointerPosition = useCallback((clientX: number, clientY: number) => {
        if (!dragging.current) return;
        const pos = direction === 'horizontal' ? clientX : clientY;
        // A double-click is two mousedowns a few pixels apart; do not treat
        // that jitter as a resize (t3 sidebar rail uses the same 2px guard).
        if (!moved.current) {
            if (Math.abs(pos - startPos.current) <= 2) return;
            moved.current = true;
        }
        const delta = pos - lastPos.current;
        lastPos.current = pos;
        if (delta !== 0) onDeltaRef.current(delta);
    }, [direction]);

    const handlePointerMove = useCallback((e: PointerEvent) => {
        if (!dragging.current) return;
        e.preventDefault();
        applyPointerPosition(e.clientX, e.clientY);
    }, [applyPointerPosition]);

    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!dragging.current) return;
        e.preventDefault();
        applyPointerPosition(e.clientX, e.clientY);
    }, [applyPointerPosition]);

    const stopDragging = useCallback(() => {
        if (!dragging.current) return;
        dragging.current = false;
        setIsDragging(false);
        document.body.classList.remove('is-resizing-horizontal', 'is-resizing-vertical');
        onEndRef.current?.();
    }, []);

    useEffect(() => {
        const options: AddEventListenerOptions = { capture: true };
        document.addEventListener('pointermove', handlePointerMove, options);
        document.addEventListener('pointerup', stopDragging, options);
        document.addEventListener('pointercancel', stopDragging, options);
        document.addEventListener('mousemove', handleMouseMove, options);
        document.addEventListener('mouseup', stopDragging, options);
        window.addEventListener('pointermove', handlePointerMove, options);
        window.addEventListener('pointerup', stopDragging, options);
        window.addEventListener('pointercancel', stopDragging, options);
        window.addEventListener('mousemove', handleMouseMove, options);
        window.addEventListener('mouseup', stopDragging, options);
        window.addEventListener('blur', stopDragging);
        return () => {
            document.removeEventListener('pointermove', handlePointerMove, options);
            document.removeEventListener('pointerup', stopDragging, options);
            document.removeEventListener('pointercancel', stopDragging, options);
            document.removeEventListener('mousemove', handleMouseMove, options);
            document.removeEventListener('mouseup', stopDragging, options);
            window.removeEventListener('pointermove', handlePointerMove, options);
            window.removeEventListener('pointerup', stopDragging, options);
            window.removeEventListener('pointercancel', stopDragging, options);
            window.removeEventListener('mousemove', handleMouseMove, options);
            window.removeEventListener('mouseup', stopDragging, options);
            window.removeEventListener('blur', stopDragging);
            document.body.classList.remove('is-resizing-horizontal', 'is-resizing-vertical');
        };
    }, [handleMouseMove, handlePointerMove, stopDragging]);

    function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        startDragging(e.clientX, e.clientY);
    }

    function handleMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
        e.preventDefault();
        e.stopPropagation();
        startDragging(e.clientX, e.clientY);
    }

    function startDragging(clientX: number, clientY: number) {
        dragging.current = true;
        moved.current = false;
        setIsDragging(true);
        startPos.current = direction === 'horizontal' ? clientX : clientY;
        lastPos.current = startPos.current;
        document.body.classList.add(direction === 'horizontal' ? 'is-resizing-horizontal' : 'is-resizing-vertical');
    }

    function handleOverlayPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
        e.preventDefault();
        applyPointerPosition(e.clientX, e.clientY);
    }

    function handleOverlayPointerEnd(e: ReactPointerEvent<HTMLDivElement>) {
        e.preventDefault();
        stopDragging();
    }

    function handleOverlayMouseMove(e: ReactMouseEvent<HTMLDivElement>) {
        e.preventDefault();
        applyPointerPosition(e.clientX, e.clientY);
    }

    function handleOverlayMouseEnd(e: ReactMouseEvent<HTMLDivElement>) {
        e.preventDefault();
        stopDragging();
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
        if (e.nativeEvent.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const step = 10;
        const decreaseKey = direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
        const increaseKey = direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== decreaseKey && e.key !== increaseKey) return;
        e.preventDefault();
        onDeltaRef.current(e.key === decreaseKey ? -step : step);
        onEndRef.current?.();
    }

    return (
        <>
            <div
                role="separator"
                tabIndex={0}
                className={`panel-resizer panel-resizer-${direction} ${props.className ?? ''}`}
                aria-label={props.ariaLabel ?? `Resize ${direction === 'horizontal' ? 'width' : 'height'}`}
                aria-valuenow={props.ariaValueNow}
                aria-valuetext={props.ariaValueNow === undefined ? undefined : `${props.ariaValueNow}px`}
                aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
                onPointerDown={handlePointerDown}
                onMouseDown={handleMouseDown}
                onLostPointerCapture={stopDragging}
                onKeyDown={handleKeyDown}
                onDoubleClick={props.onDoubleClick}
            />
            {isDragging && (
                <div
                    aria-hidden="true"
                    className={`panel-resize-overlay panel-resize-overlay-${direction}`}
                    onPointerMove={handleOverlayPointerMove}
                    onPointerUp={handleOverlayPointerEnd}
                    onPointerCancel={handleOverlayPointerEnd}
                    onMouseMove={handleOverlayMouseMove}
                    onMouseUp={handleOverlayMouseEnd}
                />
            )}
        </>
    );
}
