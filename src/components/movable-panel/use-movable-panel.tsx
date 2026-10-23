import React, { useCallback, useEffect, useRef, useState } from 'react';
import './movable-panel.scss';

type Position = { x: number; y: number };
export const constrainPosition = (position: Position, width: number, height: number): Position => ({
    x: Math.max(8, Math.min(position.x, Math.max(8, window.innerWidth - width - 8))),
    y: Math.max(8, Math.min(position.y, Math.max(8, window.innerHeight - height - 8))),
});

export default function useMovablePanel(label: string) {
    const [node, setNode] = useState<HTMLDivElement | HTMLElement | null>(null);
    const [position, setPosition] = useState<Position | null>(null);
    const drag = useRef<{ pointer: number; x: number; y: number; origin: Position } | null>(null);
    const move = useCallback(
        (next: Position) => {
            if (node) setPosition(constrainPosition(next, node.offsetWidth, node.offsetHeight));
        },
        [node]
    );
    useEffect(() => {
        if (!node) return;
        const clamp = () =>
            setPosition(current => current && constrainPosition(current, node.offsetWidth, node.offsetHeight));
        const pointerMove = (event: PointerEvent) => {
            const active = drag.current;
            if (active?.pointer === event.pointerId) {
                event.preventDefault();
                move({ x: active.origin.x + event.clientX - active.x, y: active.origin.y + event.clientY - active.y });
            }
        };
        const end = () => {
            drag.current = null;
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clamp);
        observer?.observe(node);
        window.addEventListener('resize', clamp);
        window.addEventListener('pointermove', pointerMove, { passive: false });
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
        window.addEventListener('blur', end);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', clamp);
            window.removeEventListener('pointermove', pointerMove);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            window.removeEventListener('blur', end);
            drag.current = null;
        };
    }, [node, move]);
    const reset = () => {
        drag.current = null;
        setPosition(null);
    };
    const handle = (
        <button
            type='button'
            className='movable-panel__handle'
            aria-label={`Move ${label}`}
            title='Drag to move. Arrow keys move; Home or double-click resets.'
            onDoubleClick={reset}
            onPointerDown={event => {
                if (!node || (event.pointerType === 'mouse' && event.button !== 0)) return;
                event.preventDefault();
                const rect = node.getBoundingClientRect();
                drag.current = {
                    pointer: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    origin: { x: rect.left, y: rect.top },
                };
                event.currentTarget.focus();
            }}
            onKeyDown={event => {
                if (event.key === 'Home') {
                    event.preventDefault();
                    reset();
                    return;
                }
                const offsets: Record<string, [number, number]> = {
                    ArrowLeft: [-1, 0],
                    ArrowRight: [1, 0],
                    ArrowUp: [0, -1],
                    ArrowDown: [0, 1],
                };
                const offset = offsets[event.key];
                if (!node || !offset) return;
                event.preventDefault();
                const rect = node.getBoundingClientRect();
                const step = event.shiftKey ? 50 : 10;
                move({ x: rect.left + offset[0] * step, y: rect.top + offset[1] * step });
            }}
        >
            <span aria-hidden='true'>⠿</span>
        </button>
    );
    const style: React.CSSProperties | undefined = position
        ? {
              position: 'fixed',
              left: position.x,
              top: position.y,
              right: 'auto',
              bottom: 'auto',
              insetInlineEnd: 'auto',
              transform: 'none',
              zIndex: 1250,
          }
        : undefined;
    return { ref: setNode, style, handle, moved: !!position };
}
