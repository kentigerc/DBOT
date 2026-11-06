import { act, fireEvent, render, screen } from '@testing-library/react';
import LiveDigits from '../live-digits';
import { subscribeLiveDigits } from '@/pages/digit-analysis/live-digits';
jest.mock('@/pages/digit-analysis/live-digits', () => ({ subscribeLiveDigits: jest.fn() }));
const subscribe = subscribeLiveDigits as jest.Mock;
const stop = jest.fn();
let callbacks: any;
beforeEach(() => {
    jest.clearAllMocks();
    subscribe.mockImplementation(options => {
        callbacks = options;
        return stop;
    });
});
it('shows ten live circles with the same high, low and latest markers as Digit Analysis', () => {
    render(<LiveDigits />);
    act(() => {
        callbacks.onSnapshot([0, 0, 2, 2, 2, 9], '123.09');
        callbacks.onStatus('Live', '');
    });
    const circles = screen.getByLabelText('Last-digit frequencies');
    expect(circles.children).toHaveLength(10);
    expect(screen.getByLabelText('Digit 2: 50.0 percent, 3 ticks')).toBeTruthy();
    expect(circles.querySelector('.digit-analysis__digit--high strong')?.textContent).toBe('2');
    expect(circles.querySelector('.digit-analysis__digit--latest strong')?.textContent).toBe('9');
    expect(screen.getByText('123.09')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable chart controls' })).toBeNull();
});
it('switches the public market/sample subscription and releases the previous stream', () => {
    const { unmount } = render(<LiveDigits />);
    expect(callbacks).toMatchObject({ symbol: 'R_100', sampleSize: 1000 });
    act(() =>
        callbacks.onMarkets([
            { symbol: 'R_100', display_name: 'Volatility 100' },
            { symbol: '1HZ10V', display_name: 'Volatility 10 (1s)' },
        ])
    );
    fireEvent.change(screen.getByLabelText('Market'), { target: { value: '1HZ10V' } });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(callbacks.symbol).toBe('1HZ10V');
    fireEvent.change(screen.getByLabelText('Sample size'), { target: { value: '500' } });
    expect(callbacks.sampleSize).toBe(500);
    unmount();
    expect(stop).toHaveBeenCalledTimes(3);
});
it('shows a data interruption without claiming stale percentages are live', () => {
    render(<LiveDigits />);
    act(() =>
        callbacks.onStatus(
            'Reconnecting…',
            'Restoring live data automatically. Displayed percentages are the last received snapshot.'
        )
    );
    expect(screen.getByRole('status').textContent).toBe('Reconnecting…');
    expect(screen.getByRole('alert').textContent).toContain('last received snapshot');
});
