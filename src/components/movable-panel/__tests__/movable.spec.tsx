import { fireEvent, render, screen } from '@testing-library/react';
import useMovablePanel from '../use-movable-panel';

const Panel = () => {
    const panel = useMovablePanel('test panel');
    return (
        <div ref={panel.ref} style={panel.style} data-testid='panel'>
            {panel.handle}
            <button>Stop bot</button>
        </div>
    );
};
test('keyboard movement stays in the viewport and resets without activating Stop', () => {
    render(<Panel />);
    const panel = screen.getByTestId('panel');
    Object.defineProperty(panel, 'offsetWidth', { value: 300 });
    Object.defineProperty(panel, 'offsetHeight', { value: 100 });
    const handle = screen.getByRole('button', { name: 'Move test panel' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.left).toBe('10px');
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(panel.style.left).toBe('8px');
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(panel.style.position).toBe('');
    expect(screen.getByRole('button', { name: 'Stop bot' })).toBeEnabled();
});
test('resizing clamps a moved panel and double-click restores its original layout', () => {
    render(<Panel />);
    const panel = screen.getByTestId('panel');
    const handle = screen.getByRole('button', { name: 'Move test panel' });
    Object.defineProperty(panel, 'offsetWidth', { value: 300 });
    Object.defineProperty(panel, 'offsetHeight', { value: 100 });
    panel.getBoundingClientRect = () => ({ left: 900, top: 600 }) as DOMRect;
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(Number.parseInt(panel.style.left)).toBeLessThanOrEqual(window.innerWidth - 308);
    expect(Number.parseInt(panel.style.top)).toBeLessThanOrEqual(window.innerHeight - 108);
    fireEvent.doubleClick(handle);
    expect(panel.style.position).toBe('');
});
