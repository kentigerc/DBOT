import { observable, runInAction } from 'mobx';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { useStore } from '@/hooks/useStore';
import { evaluateScan } from '@/pages/digit-analysis/scanner';
import { getScannerWatch, setScannerWatch } from '@/utils/scanner-watch';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ScannerTradeMonitor from '..';

jest.mock('@/external/bot-skeleton/services/api/appId', () => ({ generateDerivApiInstance: jest.fn() }));
jest.mock('@/hooks/useStore', () => ({ useStore: jest.fn() }));
let emit: (message: { data: { tick: { symbol: string; quote: number; epoch: number; pip_size: number } } }) => void;
let store: {
    run_panel: { is_running: boolean; onStopButtonClick: jest.Mock };
    dashboard: { bot_builder_symbol: string };
};
const counts = [8, 9, 9, 9, 10, 10, 11, 11, 11, 12];
const sample = (values: number[]) => values.flatMap((count, digit) => Array<number>(count).fill(digit));
const history = (values = counts) => ({
    pip_size: 2,
    history: { prices: sample(values).map(d => 100 + d / 100), times: Array.from({ length: 100 }, (_, i) => i) },
});
const createApi = (values = counts) => ({
    connection: new EventTarget(),
    send: jest.fn().mockResolvedValue(history(values)),
    disconnect: jest.fn(),
    onMessage: () => ({
        subscribe: (callback: typeof emit) => {
            emit = callback;
            return { unsubscribe: jest.fn() };
        },
    }),
});
const tick = (digit: number, epoch: number, symbol = 'R_100') =>
    act(() => emit({ data: { tick: { symbol, quote: 100 + digit / 100, epoch, pip_size: 2 } } }));
beforeEach(() => {
    jest.clearAllMocks();
    store = {
        run_panel: observable({ is_running: true, onStopButtonClick: jest.fn() }, { onStopButtonClick: false }),
        dashboard: { bot_builder_symbol: 'R_100' },
    };
    (useStore as jest.Mock).mockImplementation(() => store);
    setScannerWatch({ symbol: 'R_100', side: 'over', sampleSize: 100, name: 'Over Punisher' });
    Object.defineProperty(window, 'Blockly', {
        configurable: true,
        value: { xmlValues: { file_name: 'Over Punisher' } },
    });
});
afterEach(() => {
    cleanup();
    setScannerWatch(null);
    jest.useRealTimers();
});
it.each(['over', 'under'] as const)(
    'warns on the first tick that invalidates %s and stops only on user request',
    async side => {
        const name = side === 'over' ? 'Over Punisher' : 'Under Punisher';
        Object.defineProperty(window, 'Blockly', { configurable: true, value: { xmlValues: { file_name: name } } });
        setScannerWatch({ symbol: 'R_100', side, sampleSize: 100, name });
        const api = createApi(side === 'over' ? counts : [...counts].reverse());
        (generateDerivApiInstance as jest.Mock).mockResolvedValue(api);
        render(<ScannerTradeMonitor />);
        await screen.findByText('Live market monitor');
        tick(side === 'over' ? 1 : 6, 100);
        expect(screen.getByRole('alert').textContent).toContain('Market changed');
        expect(store.run_panel.onStopButtonClick).not.toHaveBeenCalled();
        expect(api.send).toHaveBeenCalledWith({
            ticks_history: 'R_100',
            style: 'ticks',
            end: 'latest',
            count: 100,
            subscribe: 1,
        });
        fireEvent.click(screen.getByRole('button', { name: 'Stop bot' }));
        expect(store.run_panel.onStopButtonClick).toHaveBeenCalledTimes(1);
    }
);
it('keeps the alert latched after the percentages recover', async () => {
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(createApi());
    render(<ScannerTradeMonitor />);
    await screen.findByText('Live market monitor');
    const digits = sample(counts);
    tick(1, 100);
    digits.shift();
    digits.push(1);
    for (let epoch = 101; epoch <= 108; epoch++) {
        tick(0, epoch);
        digits.shift();
        digits.push(0);
    }
    expect(evaluateScan(digits, 'over', 100).matches).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Market changed');
});
it('ignores unrelated or duplicate ticks and disconnects when trading stops', async () => {
    const api = createApi();
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(api);
    const { rerender } = render(<ScannerTradeMonitor />);
    await screen.findByText('Live market monitor');
    tick(1, 100, 'R_50');
    tick(1, 99);
    expect(screen.queryByRole('alert')).toBeNull();
    act(() =>
        runInAction(() => {
            store.run_panel.is_running = false;
        })
    );
    rerender(<ScannerTradeMonitor />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(api.disconnect).toHaveBeenCalled();
});
it('warns immediately on disconnect and on delayed tick data', async () => {
    jest.useFakeTimers();
    const api = createApi();
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(api);
    render(<ScannerTradeMonitor />);
    await act(async () => {});
    await act(async () => {
        await jest.advanceTimersByTimeAsync(11000);
    });
    expect(screen.getByRole('alert').textContent).toContain('delayed');
    act(() => api.connection.dispatchEvent(new Event('close')));
    expect(screen.getByRole('alert')).toBeTruthy();
});
it('warns if the entry conditions already changed before Run', async () => {
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(createApi(Array(10).fill(10)));
    render(<ScannerTradeMonitor />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Market changed'));
});
it('clears a scanner link when a different bot is run', async () => {
    Object.defineProperty(window, 'Blockly', { configurable: true, value: { xmlValues: { file_name: 'My own bot' } } });
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(createApi());
    render(<ScannerTradeMonitor />);
    await waitFor(() => expect(getScannerWatch()).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
});
it('evaluates ticks received while initial history is loading', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(value => {
        resolve = value;
    });
    const api = createApi();
    api.send.mockReturnValue(pending);
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(api);
    render(<ScannerTradeMonitor />);
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    tick(1, 100);
    await act(async () => {
        resolve(history());
    });
    expect(screen.getByRole('alert').textContent).toContain('Market changed');
});
it('warns immediately when a live connection closes', async () => {
    const api = createApi();
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(api);
    render(<ScannerTradeMonitor />);
    await screen.findByText('Live market monitor');
    act(() => api.connection.dispatchEvent(new Event('close')));
    expect(screen.getByRole('alert').textContent).toContain('disconnected');
});
it('follows the actual bot market rather than the chart selection and latches manual market changes', async () => {
    let symbol = 'R_100';
    let change = () => {};
    const workspace = {
        getAllBlocks: () => [{ type: 'trade_definition_market', getFieldValue: () => symbol }],
        addChangeListener: (callback: () => void) => {
            change = callback;
        },
        removeChangeListener: jest.fn(),
    };
    Object.defineProperty(window, 'Blockly', {
        configurable: true,
        value: { xmlValues: { file_name: 'Over Punisher' }, derivWorkspace: workspace },
    });
    store.dashboard.bot_builder_symbol = 'R_50';
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(createApi());
    render(<ScannerTradeMonitor />);
    await screen.findByText('Live market monitor');
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => {
        symbol = 'R_50';
        change();
    });
    expect(screen.getByRole('alert').textContent).toContain('bot market was changed');
    act(() => {
        symbol = 'R_100';
        change();
    });
    expect(screen.getByRole('alert').textContent).toContain('bot market was changed');
});
