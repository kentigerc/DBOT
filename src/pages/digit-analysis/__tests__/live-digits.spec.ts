import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { subscribeLiveDigits } from '../live-digits';

jest.mock('@/external/bot-skeleton/services/api/appId', () => ({ generateDerivApiInstance: jest.fn() }));
const connect = generateDerivApiInstance as jest.Mock;
const initial = { pip_size: 2, history: { prices: [100.01, 100.02, 100.03], times: [1, 2, 3] } };
const markets = { active_symbols: [{ symbol: 'R_100', market: 'synthetic_index', exchange_is_open: 1 }] };
const api = (snapshot = initial) => {
    let receive: (message: unknown) => void = () => {};
    return {
        connection: new EventTarget(),
        disconnect: jest.fn(),
        unsubscribe: jest.fn(),
        send: jest.fn().mockImplementation(async request => (request.active_symbols ? markets : snapshot)),
        onMessage() {
            return {
                subscribe: (callback: typeof receive) => {
                    receive = callback;
                    return { unsubscribe: this.unsubscribe };
                },
            };
        },
        tick(digit: number, epoch: number, symbol = 'R_100') {
            receive({ data: { tick: { quote: 100 + digit / 100, epoch, symbol, pip_size: 2 } } });
        },
    };
};
const stops: (() => void)[] = [];
const watch = () => {
    const onSnapshot = jest.fn(),
        onStatus = jest.fn(),
        onMarkets = jest.fn();
    stops.push(subscribeLiveDigits({ symbol: 'R_100', sampleSize: 3, onSnapshot, onStatus, onMarkets }));
    return { onSnapshot, onStatus, onMarkets };
};
beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
afterEach(() => {
    stops.splice(0).forEach(stop => stop());
    jest.useRealTimers();
});
it('streams rolling digits and ignores duplicates and unrelated symbols', async () => {
    const feed = api();
    connect.mockResolvedValue(feed);
    const view = watch();
    await jest.advanceTimersByTimeAsync(0);
    expect(view.onSnapshot).toHaveBeenLastCalledWith([1, 2, 3], '100.03');
    feed.tick(4, 4);
    feed.tick(9, 4);
    feed.tick(8, 5, 'R_50');
    expect(view.onSnapshot).toHaveBeenLastCalledWith([2, 3, 4], '100.04');
    expect(view.onSnapshot).toHaveBeenCalledTimes(2);
    expect(view.onStatus).toHaveBeenLastCalledWith('Live', '');
    expect(feed.send).toHaveBeenCalledWith({
        ticks_history: 'R_100',
        style: 'ticks',
        end: 'latest',
        count: 3,
        subscribe: 1,
    });
});
it('automatically reconnects after close and backfills history instead of appending guessed ticks', async () => {
    const first = api(),
        next = api({ pip_size: 2, history: { prices: [100.07, 100.08, 100.09], times: [7, 8, 9] } });
    connect.mockResolvedValueOnce(first).mockResolvedValue(next);
    const view = watch();
    await jest.advanceTimersByTimeAsync(0);
    first.connection.dispatchEvent(new Event('close'));
    expect(view.onStatus.mock.calls[view.onStatus.mock.calls.length - 1][0]).toBe('Reconnecting…');
    expect(view.onSnapshot).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(view.onSnapshot).toHaveBeenLastCalledWith([7, 8, 9], '100.09');
    first.tick(0, 10);
    expect(view.onSnapshot).toHaveBeenLastCalledWith([7, 8, 9], '100.09');
    expect(first.disconnect).toHaveBeenCalled();
    expect(first.unsubscribe).toHaveBeenCalled();
});
it('detects a silent stalled feed and resubscribes automatically', async () => {
    connect.mockImplementation(async () => api());
    const view = watch();
    await jest.advanceTimersByTimeAsync(14000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(view.onStatus).toHaveBeenLastCalledWith('Live', '');
});
it('backs off repeated connection failures and cancels retries when disposed', async () => {
    connect.mockRejectedValue(new Error('network unavailable'));
    const view = watch();
    await jest.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2000);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(view.onStatus.mock.calls[view.onStatus.mock.calls.length - 1][1]).toContain('4s');
    stops.pop()!();
    await jest.advanceTimersByTimeAsync(30000);
    expect(connect).toHaveBeenCalledTimes(3);
});
it('recovers as soon as the browser comes online', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    connect.mockResolvedValue(api());
    const view = watch();
    expect(connect).not.toHaveBeenCalled();
    expect(view.onStatus.mock.calls[view.onStatus.mock.calls.length - 1][0]).toBe('Offline');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
    await jest.advanceTimersByTimeAsync(0);
    expect(view.onStatus).toHaveBeenLastCalledWith('Live', '');
});
it('queues ticks arriving before history and cleans up without updates after disposal', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(value => {
        resolve = value;
    });
    const feed = api();
    feed.send.mockImplementation(request => (request.active_symbols ? Promise.resolve(markets) : pending));
    connect.mockResolvedValue(feed);
    const view = watch();
    await jest.advanceTimersByTimeAsync(0);
    feed.tick(4, 4);
    resolve(initial);
    await jest.advanceTimersByTimeAsync(0);
    expect(view.onSnapshot).toHaveBeenLastCalledWith([2, 3, 4], '100.04');
    const calls = view.onSnapshot.mock.calls.length;
    stops.pop()!();
    feed.tick(5, 5);
    window.dispatchEvent(new Event('online'));
    await jest.advanceTimersByTimeAsync(30000);
    expect(view.onSnapshot).toHaveBeenCalledTimes(calls);
    expect(connect).toHaveBeenCalledTimes(1);
});
