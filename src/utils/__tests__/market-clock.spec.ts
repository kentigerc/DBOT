import { MarketClock } from '../market-clock';

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1700000000000);
});
afterEach(() => jest.useRealTimers());

it('uses a bounded Deriv time anchor and ignores changes to the device date', () => {
    const clock = new MarketClock();
    expect(clock.now()).toBeNaN();
    clock.synchronize(1700000000, 0, 0);
    jest.setSystemTime(Date.now() + 3600000);
    expect(clock.now()).toBe(1700000000000);
    jest.advanceTimersByTime(1000);
    expect(clock.now()).toBe(1700000001000);
    jest.advanceTimersByTime(90000);
    expect(clock.now()).toBeNaN();
});

it('allows for network latency and rejects imprecise or invalid time responses', () => {
    const clock = new MarketClock();
    clock.synchronize(1700000000, -200, 0);
    expect(clock.now()).toBe(1700000000100);
    for (const value of [undefined, NaN, Infinity, '1700000000', 0, -1, 1700000000.5])
        expect(() => new MarketClock().synchronize(value, 0, 0)).toThrow('synchronization');
    expect(() => clock.synchronize(1700000000, 0, 2001)).toThrow('synchronization');
});
