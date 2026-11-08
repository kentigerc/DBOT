import { observeVolatilityMarkets, type LiveVolatilitySample } from '../live-volatility-markets';
import { watchManualMarkets, manualEntryReady, type ManualMarket } from '../manual-trader-markets';
jest.mock('../live-volatility-markets', () => ({ observeVolatilityMarkets: jest.fn() }));
it('uses Momentum’s live rising share and two-digit formation, clearing that formation after settlement', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(2000000);
    const controller = new AbortController();
    const api = { disconnect: jest.fn() } as any;
    let update!: (sample: LiveVolatilitySample) => void;
    (observeVolatilityMarkets as jest.Mock).mockImplementation((_api, _size, signal, sample) => {
        update = sample;
        return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    });
    const readings: ManualMarket[] = [];
    let after = 0;
    const watching = watchManualMarkets(
        async () => api,
        controller.signal,
        value => readings.push(value),
        jest.fn(),
        jest.fn(),
        undefined,
        () => after
    );
    await Promise.resolve();
    let digits = [...Array(200).fill(0), ...Array(800).fill(3)];
    let epoch = Date.now() / 1000;
    const emit = (live: boolean) =>
        update({ market: { symbol: 'R_100', display_name: 'Volatility 100' }, digits, epoch, live });
    try {
        emit(false);
        expect(manualEntryReady(readings[readings.length - 1], 'over')).toBe(false);
        for (let i = 0; i < 5; i++) {
            jest.advanceTimersByTime(1000);
            epoch++;
            digits = [...digits.slice(1), 3];
            emit(true);
        }
        expect(manualEntryReady(readings[readings.length - 1], 'over')).toBe(true);
        expect(manualEntryReady(readings[readings.length - 1], 'under')).toBe(false); // 100% but no rising momentum.
        after = Date.now();
        jest.advanceTimersByTime(1000);
        epoch++;
        digits = [...digits.slice(1), 3];
        emit(true);
        expect(manualEntryReady(readings[readings.length - 1], 'over')).toBe(false);
        for (let i = 0; i < 2; i++) {
            jest.advanceTimersByTime(1000);
            epoch++;
            digits = [...digits.slice(1), 3];
            emit(true);
        }
        expect(manualEntryReady(readings[readings.length - 1], 'over')).toBe(true);
    } finally {
        controller.abort();
        await watching;
        jest.useRealTimers();
    }
    expect(api.disconnect).toHaveBeenCalled();
});
