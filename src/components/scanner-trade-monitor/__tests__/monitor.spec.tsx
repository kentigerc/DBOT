import { observable, runInAction } from 'mobx';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { useStore } from '@/hooks/useStore';
import { scannerExitGuard } from '@/utils/scanner-exit-guard';
import { getScannerWatch, setScannerWatch } from '@/utils/scanner-watch';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import ScannerTradeMonitor from '..';

jest.mock('@/external/bot-skeleton/services/api/appId', () => ({ generateDerivApiInstance: jest.fn() }));
jest.mock('@/hooks/useStore', () => ({ useStore: jest.fn() }));
let emit: (message: {
    data: { tick?: { symbol: string; quote: number; epoch: number; pip_size: number }; error?: unknown };
}) => void;
let store: { run_panel: { is_running: boolean; onStopButtonClick: jest.Mock } };
const counts = [9, 9, 9, 8, 10, 10, 11, 11, 11, 12];
const sample = (values: number[]) => values.flatMap((count, digit) => Array<number>(count).fill(digit));
const history = (values = counts) => ({
    pip_size: 2,
    history: {
        prices: sample(values).map(d => 100 + d / 100),
        times: Array.from(
            { length: values.reduce((a, b) => a + b, 0) },
            (_, i) => 100 - values.reduce((a, b) => a + b, 0) + i
        ),
    },
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
    jest.spyOn(Date, 'now').mockReturnValue(99000);
    store = { run_panel: observable({ is_running: true, onStopButtonClick: jest.fn() }, { onStopButtonClick: false }) };
    (useStore as jest.Mock).mockReturnValue(store);
    setScannerWatch({ symbol: 'R_100', side: 'over', sampleSize: 100, name: 'Over Punisher' });
    Object.defineProperty(window, 'Blockly', {
        configurable: true,
        value: { xmlValues: { file_name: 'Over Punisher' } },
    });
});
afterEach(() => {
    cleanup();
    scannerExitGuard.begin(() => {});
    scannerExitGuard.cancel();
    setScannerWatch(null);
    jest.restoreAllMocks();
    jest.useRealTimers();
});
it.each(['over', 'under'] as const)(
    'keeps %s monitoring and live entry data active without rendering a popup',
    async side => {
        const name = side === 'over' ? 'Over Punisher' : 'Under Punisher';
        Object.defineProperty(window, 'Blockly', { configurable: true, value: { xmlValues: { file_name: name } } });
        setScannerWatch({ symbol: 'R_100', side, sampleSize: 100, name });
        const api = createApi(side === 'over' ? counts : [...counts].reverse());
        (generateDerivApiInstance as jest.Mock).mockResolvedValue(api);
        const market = jest.spyOn(xmlScannerCycle, 'market');
        const { container } = render(<ScannerTradeMonitor />);
        await waitFor(() => expect(market).toHaveBeenCalledTimes(1));
        tick(1, 100);
        expect(market).toHaveBeenCalledTimes(2);
        expect(api.send).toHaveBeenCalledWith({
            ticks_history: 'R_100',
            style: 'ticks',
            end: 'latest',
            count: 100,
            subscribe: 1,
        });
        expect(container).toBeEmptyDOMElement();
    }
);
it('ignores unrelated/out-of-order ticks and disconnects when the bot stops', async () => {
    const api = createApi();
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(api);
    const market = jest.spyOn(xmlScannerCycle, 'market');
    render(<ScannerTradeMonitor />);
    await waitFor(() => expect(market).toHaveBeenCalledTimes(1));
    tick(1, 100, 'R_50');
    tick(1, 99);
    expect(market).toHaveBeenCalledTimes(1);
    act(() =>
        runInAction(() => {
            store.run_panel.is_running = false;
        })
    );
    expect(api.disconnect).toHaveBeenCalled();
});
it('replays ticks received while history is loading', async () => {
    let release!: (value: unknown) => void;
    const api = createApi();
    api.send.mockReturnValue(
        new Promise(resolve => {
            release = resolve;
        })
    );
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(api);
    const market = jest.spyOn(xmlScannerCycle, 'market');
    render(<ScannerTradeMonitor />);
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    tick(1, 100);
    await act(async () => {
        release(history());
    });
    expect(market).toHaveBeenCalledTimes(2);
    expect(market).toHaveBeenLastCalledWith('R_100', expect.any(Array), 100);
});
it.each(['close', 'error', 'subscription'] as const)(
    'pauses and reconnects after a %s failure without stopping the session',
    async failure => {
        const first = createApi(),
            second = createApi();
        (generateDerivApiInstance as jest.Mock).mockResolvedValueOnce(first).mockResolvedValue(second);
        const pause = jest.spyOn(xmlScannerCycle, 'pauseMarket');
        const stop = jest.spyOn(xmlScannerCycle, 'stop');
        const market = jest.spyOn(xmlScannerCycle, 'market');
        const { container } = render(<ScannerTradeMonitor />);
        await waitFor(() => expect(market).toHaveBeenCalledTimes(1));
        act(() => {
            if (failure === 'subscription') emit({ data: { error: {} } });
            else first.connection.dispatchEvent(new Event(failure));
        });
        expect(pause).toHaveBeenCalledWith('R_100');
        expect(first.disconnect).toHaveBeenCalled();
        await waitFor(() => expect(second.send).toHaveBeenCalled(), { timeout: 2000 });
        await waitFor(() => expect(market).toHaveBeenCalledTimes(2));
        expect(stop).not.toHaveBeenCalled();
        expect(container).toBeEmptyDOMElement();
    }
);
it('reconnects on missed ticks and stops if fresh history cannot be restored within 20 seconds', async () => {
    const api = createApi();
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(api);
    const stop = jest.spyOn(xmlScannerCycle, 'stop');
    const pause = jest.spyOn(xmlScannerCycle, 'pauseMarket');
    render(<ScannerTradeMonitor />);
    await waitFor(() => expect(api.send).toHaveBeenCalled());
    tick(9, 110);
    expect(pause).toHaveBeenCalledWith('R_100');
    expect(stop).not.toHaveBeenCalled();
    (Date.now as jest.Mock).mockReturnValue(120000);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(stop).toHaveBeenCalledWith(expect.stringContaining('could not reconnect within 20 seconds'));
});
it('pauses a stale feed on focus and ignores an obsolete socket after replacement', async () => {
    const api = createApi();
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(api);
    const pause = jest.spyOn(xmlScannerCycle, 'pauseMarket');
    const market = jest.spyOn(xmlScannerCycle, 'market');
    render(<ScannerTradeMonitor />);
    await waitFor(() => expect(market).toHaveBeenCalledTimes(1));
    (Date.now as jest.Mock).mockReturnValue(105000);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(pause).toHaveBeenCalledWith('R_100');
    tick(1, 105);
    expect(market).toHaveBeenCalledTimes(1);
});
it.each(['over', 'under'] as const)('keeps a renamed hosted %s bot linked to monitoring', async side => {
    setScannerWatch(null);
    Object.defineProperty(window, 'Blockly', {
        configurable: true,
        value: {
            xmlValues: { file_name: 'Renamed' },
            derivWorkspace: {
                getAllBlocks: () => [
                    {
                        type: 'trade_definition_market',
                        data: `netoacademy:hosted-bot:${side}-punisher.xml`,
                        getFieldValue: () => 'R_100',
                    },
                ],
                addChangeListener: jest.fn(),
                removeChangeListener: jest.fn(),
            },
        },
    });
    const api = createApi(counts.map(n => n * 10));
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(api);
    const { container } = render(<ScannerTradeMonitor />);
    await waitFor(() => expect(getScannerWatch()).toMatchObject({ symbol: 'R_100', side, sampleSize: 1000 }));
    expect(container).toBeEmptyDOMElement();
});
it('clears the scanner link for an unrelated bot', async () => {
    Object.defineProperty(window, 'Blockly', { configurable: true, value: { xmlValues: { file_name: 'My own bot' } } });
    render(<ScannerTradeMonitor />);
    await waitFor(() => expect(getScannerWatch()).toBeNull());
});
it('still automatically stops at two one-percentage-point rises against the saved match', async () => {
    setScannerWatch({
        symbol: 'R_100',
        side: 'over',
        sampleSize: 100,
        name: 'Over Punisher',
        baselineCounts: [8, 9, 9, 9, 0, 0, 0, 0, 0, 0],
    });
    scannerExitGuard.begin(store.run_panel.onStopButtonClick);
    (generateDerivApiInstance as jest.Mock).mockResolvedValue(createApi([9, 10, 9, 9, 9, 10, 11, 11, 11, 11]));
    const { container } = render(<ScannerTradeMonitor />);
    await waitFor(() => expect(store.run_panel.onStopButtonClick).toHaveBeenCalledTimes(1));
    expect(scannerExitGuard.getSnapshot()).toMatchObject({ triggered: true, phase: 'stopped' });
    expect(container).toBeEmptyDOMElement();
});
