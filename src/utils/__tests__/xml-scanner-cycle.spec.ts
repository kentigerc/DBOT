import { XmlScannerCycle, type XmlScannerMatch } from '../xml-scanner-cycle';
const counts = [9, 9, 9, 8, 10, 10, 11, 11, 11, 12];
const match: XmlScannerMatch = {
    symbol: 'R_100',
    side: 'over',
    name: 'Over Punisher',
    submarket: 'random_index',
    sampleSize: 100,
    baselineCounts: counts,
};
const sample = (latest = 1) => {
    const digits = counts.flatMap((n, digit) => Array<number>(n).fill(digit));
    const index = digits.indexOf(latest);
    digits.splice(index, 1);
    digits.push(latest);
    return digits;
};
const setup = () => {
    const cycle = new XmlScannerCycle(),
        stop = jest.fn();
    cycle.start('TEST-DEMO', 100, stop);
    const token = cycle.claim(match)!;
    cycle.loaded(token, { takeProfit: 1000, stopLoss: 10000 });
    cycle.runStarted();
    return { cycle, stop, token };
};
const settle = async (cycle: XmlScannerCycle, id: number, profit: number) => {
    expect(await cycle.beforePurchase('R_100')).toBe(true);
    expect(cycle.purchase('TEST-DEMO')).toBe(true);
    cycle.purchased(id);
    cycle.contract({ contract_id: id, is_sold: 1, profit });
};
afterEach(() => jest.useRealTimers());
it('waits for the qualifying latest digit, rejects stale data, and cancels a waiting entry on STOP', async () => {
    const { cycle, stop } = setup();
    let resolved = false;
    const pending = cycle.beforePurchase('R_100').then(allow => {
        resolved = true;
        return allow;
    });
    cycle.market('OTHER-MARKET', sample(1), Date.now() / 1000);
    cycle.market('R_100', sample(9), Date.now() / 1000);
    cycle.market('R_100', sample(1), Date.now() / 1000 - 20);
    await Promise.resolve();
    expect(resolved).toBe(false);
    cycle.stop();
    expect(await pending).toBe(false);
    expect(cycle.purchase('TEST-DEMO')).toBe(false);
    expect(stop).toHaveBeenCalledWith(false);
});
it('blocks a fourth purchase, stops after three normal wins, then scans again after five seconds', async () => {
    jest.useFakeTimers();
    const { cycle, stop } = setup();
    cycle.market('R_100', sample(), Date.now() / 1000);
    for (let id = 1; id <= 3; id++) await settle(cycle, id, 0.12);
    expect(cycle.purchase('TEST-DEMO')).toBe(false);
    jest.runAllTicks();
    expect(stop).toHaveBeenCalledWith(true);
    cycle.runnerStopped();
    expect(cycle.getSnapshot()).toMatchObject({ enabled: true, phase: 'cooldown', batches: 1, pnl: 36 });
    jest.advanceTimersByTime(5000);
    expect(cycle.getSnapshot()).toMatchObject({ phase: 'scanning', match: undefined, wins: 0, pnl: 36 });
    cycle.stop();
});
it('allows XML recovery without another analysis, and its win restarts a full normal batch', async () => {
    const { cycle, stop } = setup();
    cycle.market('R_100', sample(), Date.now() / 1000);
    await settle(cycle, 1, 0.12);
    await settle(cycle, 2, -0.35);
    cycle.market('R_100', sample(9), Date.now() / 1000);
    await settle(cycle, 3, -0.74);
    await settle(cycle, 4, 1.36);
    expect(cycle.getSnapshot()).toMatchObject({ wins: 0, losses: 0, phase: 'running' });
    expect(stop).not.toHaveBeenCalled();
    for (let id = 5; id <= 7; id++) await settle(cycle, id, 0.12);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledWith(true);
    cycle.stop();
});
it('does not revive after STOP during loading/cooldown or accept a changed market/account', async () => {
    const { cycle, token } = setup();
    cycle.stop();
    expect(cycle.loaded(token, { takeProfit: 1000, stopLoss: 10000 })).toBe(false);
    expect(cycle.canRun()).toBe(false);
    const next = setup();
    expect(next.cycle.purchase('OTHER-ACCOUNT')).toBe(false);
    expect(await next.cycle.beforePurchase('R_50')).toBe(false);
    expect(next.cycle.getSnapshot().enabled).toBe(false);
});
it('deduplicates settlements, ignores unrelated/open contracts and never counts a recovery win as a normal win', async () => {
    const { cycle } = setup();
    cycle.market('R_100', sample(), Date.now() / 1000);
    await settle(cycle, 1, -0.35);
    cycle.contract({ contract_id: 1, is_sold: 1, profit: -0.35 });
    cycle.contract({ contract_id: 999, is_sold: 1, profit: 10 });
    expect(cycle.getSnapshot()).toMatchObject({ pnl: -35, losses: 1 });
    await settle(cycle, 2, 0.65);
    expect(cycle.getSnapshot()).toMatchObject({ pnl: 30, wins: 0, losses: 0 });
    cycle.stop();
});
it('keeps session limits across reloads and stops at the cumulative profit limit', async () => {
    const { cycle, stop } = setup();
    cycle.market('R_100', sample(), Date.now() / 1000);
    await settle(cycle, 1, 10);
    expect(cycle.purchase('TEST-DEMO')).toBe(false);
    await Promise.resolve();
    expect(cycle.getSnapshot()).toMatchObject({ enabled: false, pnl: 1000 });
    expect(stop).toHaveBeenCalledWith(false);
});
it('stops at ten consecutive losses, including XML recovery losses', async () => {
    const { cycle } = setup();
    cycle.market('R_100', sample(), Date.now() / 1000);
    for (let id = 1; id <= 10; id++) await settle(cycle, id, -0.35);
    await Promise.resolve();
    expect(cycle.getSnapshot()).toMatchObject({ enabled: false, losses: 10 });
});
it('manual Builder use is unaffected when XML Auto has not been enabled', async () => {
    const cycle = new XmlScannerCycle();
    expect(await cycle.beforePurchase('R_50')).toBe(true);
    expect(cycle.purchase('ANY')).toBe(true);
});

it('carries cumulative P/L through another loaded XML batch and honours its lower limit', async () => {
    jest.useFakeTimers();
    const { cycle, stop } = setup();
    cycle.market('R_100', sample(), Date.now() / 1000);
    for (let id = 1; id <= 3; id++) await settle(cycle, id, 0.12);
    jest.runAllTicks();
    cycle.runnerStopped();
    jest.advanceTimersByTime(5000);
    const token = cycle.claim(match)!;
    cycle.loaded(token, { takeProfit: 40, stopLoss: 10000 });
    cycle.runStarted();
    cycle.market('R_100', sample(), Date.now() / 1000);
    await settle(cycle, 4, 0.12);
    jest.runAllTicks();
    expect(cycle.getSnapshot()).toMatchObject({ enabled: false, pnl: 48 });
    expect(stop).toHaveBeenLastCalledWith(false);
});
it('STOP during the batch cooldown prevents another scan', async () => {
    jest.useFakeTimers();
    const { cycle } = setup();
    cycle.market('R_100', sample(), Date.now() / 1000);
    for (let id = 1; id <= 3; id++) await settle(cycle, id, 0.12);
    jest.runAllTicks();
    cycle.runnerStopped();
    cycle.stop();
    jest.advanceTimersByTime(6000);
    expect(cycle.getSnapshot()).toMatchObject({ enabled: false, phase: 'stopped' });
});

it('STOP prevents entries but still records the final settlement of its open contract', async () => {
    const { cycle } = setup();
    cycle.market('R_100', sample(), Date.now() / 1000);
    expect(await cycle.beforePurchase('R_100')).toBe(true);
    expect(cycle.purchase('TEST-DEMO')).toBe(true);
    cycle.stop(); // Purchase receipt can arrive after STOP.
    cycle.purchased(500);
    expect(() => cycle.start('TEST-DEMO', 100, jest.fn())).toThrow('Settle the previous');
    cycle.contract({ contract_id: 500, is_sold: 1, profit: 0.12 });
    expect(cycle.getSnapshot()).toMatchObject({ enabled: false, phase: 'stopped', pnl: 12 });
    expect(cycle.purchase('TEST-DEMO')).toBe(false);
    expect(() => cycle.start('TEST-DEMO', 100, jest.fn())).not.toThrow();
    cycle.stop();
});

it('percentage protection ends Auto after four total losses and cannot begin a new batch', async () => {
    const { ScannerExitGuard } = require('../scanner-exit-guard');
    const { cycle } = setup();
    const guard = new ScannerExitGuard();
    guard.begin(() => cycle.stop('Market protection stopped the bot.'));
    cycle.market('R_100', sample(), Date.now() / 1000);
    for (let id = 1; id <= 4; id++) {
        expect(await cycle.beforePurchase('R_100')).toBe(true);
        expect(cycle.purchase('TEST-DEMO') && guard.purchase()).toBe(true);
        cycle.purchased(id);
        guard.purchased(id);
        if (id === 4) guard.trigger();
        const contract = { contract_id: id, is_sold: 1, profit: -0.35 };
        guard.contract(contract);
        cycle.contract(contract);
    }
    expect(guard.purchase()).toBe(false);
    await Promise.resolve();
    expect(cycle.getSnapshot()).toMatchObject({ enabled: false, losses: 4 });
    expect(cycle.purchase('TEST-DEMO')).toBe(false);
    expect(cycle.claim(match)).toBeUndefined();
});
