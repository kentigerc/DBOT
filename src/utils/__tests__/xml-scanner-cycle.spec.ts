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
    if (cycle.getSnapshot().phase === 'waiting') cycle.market('R_100', sample(), Date.now() / 1000 + id / 1000);
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
it('preserves batch counters through recovery and starts a full normal batch after its win', async () => {
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
        cycle.market('R_100', sample(), Date.now() / 1000 + id / 1000);
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

it('reports the first exact stop reason once, without changing it during repeated stop callbacks', () => {
    const cycle = new XmlScannerCycle(),
        report = jest.fn();
    cycle.start('TEST-DEMO', 100, jest.fn(), report);
    cycle.stop('Market protection: live conditions changed; recovery is clear.');
    cycle.stop();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
        'XML Auto stopped: Market protection: live conditions changed; recovery is clear.'
    );
    expect(cycle.getSnapshot().message).toContain('Market protection');
});
it('records the provider rejection instead of an unexplained generic stop', () => {
    const cycle = new XmlScannerCycle(),
        report = jest.fn();
    cycle.start('TEST-DEMO', 100, jest.fn(), report);
    cycle.purchaseFailed({ code: 'InvalidContractProposal', message: 'The proposal expired.' });
    expect(report).toHaveBeenCalledWith(expect.stringContaining('InvalidContractProposal · The proposal expired.'));
});

it('two wins then a loss recover first, then require exactly three new normal wins', async () => {
    const { cycle, stop } = setup();
    cycle.market('R_100', sample(), Date.now() / 1000);
    await settle(cycle, 1, 0.12);
    await settle(cycle, 2, 0.12);
    expect(cycle.getSnapshot().wins).toBe(2);
    await settle(cycle, 3, -0.35);
    expect(cycle.getSnapshot().wins).toBe(0);
    await settle(cycle, 4, 0.65);
    expect(cycle.getSnapshot().wins).toBe(0); // Recovery win is not normal win one.
    for (let id = 5; id <= 6; id++) await settle(cycle, id, 0.12);
    expect(stop).not.toHaveBeenCalled();
    await settle(cycle, 7, 0.12);
    expect(cycle.purchase('TEST-DEMO')).toBe(false);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(true);
    cycle.stop();
});

it.each(['over', 'under'] as const)(
    'keeps the normal %s market and entry context through recovery without rebinding XML',
    async side => {
        const cycle = new XmlScannerCycle();
        cycle.start('TEST-DEMO', 100, jest.fn());
        const selected = {
            ...match,
            symbol: '1HZ10V',
            side,
            name: side === 'over' ? 'Over Punisher' : 'Under Punisher',
        };
        const token = cycle.claim(selected)!;
        cycle.loaded(token, { takeProfit: 1000, stopLoss: 10000 });
        cycle.runStarted();
        const values = side === 'over' ? counts : [...counts].reverse();
        const digits = (latest: number) => {
            const result = values.flatMap((n, d) => Array<number>(n).fill(d));
            result.splice(result.indexOf(latest), 1);
            result.push(latest);
            return result;
        };
        const epoch = Date.now() / 1000;
        cycle.market(selected.symbol, digits(side === 'over' ? 1 : 7), epoch);
        for (const [id, profit] of [
            [501, -0.35],
            [502, -0.74],
            [503, 1.36],
        ]) {
            expect(await cycle.beforePurchase(selected.symbol)).toBe(true);
            expect(cycle.purchase('TEST-DEMO')).toBe(true);
            cycle.purchased(id);
            cycle.contract({ contract_id: id, is_sold: 1, profit, exit_tick_time: epoch + 0.5 });
            expect(cycle.getSnapshot()).toMatchObject({
                phase: 'running',
                recoverySearch: false,
                match: selected,
                wins: 0,
            });
            expect(cycle.recoveryTarget()).toBeUndefined();
            expect(cycle.offerRecoveryMarket({ ...selected, symbol: 'R_50' }, digits(1), epoch + 0.6)).toBe(false);
            // Fresh live data is required, but scanner entry digits are no longer required during recovery.
            cycle.market(selected.symbol, digits(side === 'over' ? 9 : 0), epoch);
        }
        expect(cycle.getSnapshot()).toMatchObject({ wins: 0, losses: 0, phase: 'running' });
        expect(await cycle.beforePurchase(selected.symbol)).toBe(true);
        cycle.stop();
        expect(await cycle.beforePurchase(selected.symbol)).toBe(false);
    }
);

it('pauses purchases during a feed reconnect, preserving wins, losses and session P/L', async () => {
    const { cycle } = setup();
    await settle(cycle, 1, 0.12);
    cycle.pauseMarket('R_100');
    expect(cycle.canPurchase('TEST-DEMO')).toBe(false);
    let released = false;
    const pending = cycle.beforePurchase('R_100').then(value => {
        released = true;
        return value;
    });
    cycle.market('R_50', sample(), Date.now() / 1000);
    cycle.market('R_100', sample(), Date.now() / 1000 - 30);
    await Promise.resolve();
    expect(released).toBe(false);
    cycle.market('R_100', sample(9), Date.now() / 1000);
    expect(await pending).toBe(true);
    expect(cycle.getSnapshot()).toMatchObject({ wins: 1, losses: 0, pnl: 12 });
    expect(cycle.canPurchase('TEST-DEMO')).toBe(true);
    cycle.stop();
});
it('STOP cancels a purchase waiting for live monitoring to reconnect', async () => {
    const { cycle } = setup();
    await settle(cycle, 1, -0.35);
    cycle.pauseMarket('R_100');
    const pending = cycle.beforePurchase('R_100');
    cycle.stop();
    expect(await pending).toBe(false);
    cycle.market('R_100', sample(), Date.now() / 1000);
    expect(cycle.canPurchase('TEST-DEMO')).toBe(false);
});
it('requires the restored normal-market live guard before releasing recovery after a feed stall', async () => {
    const { cycle } = setup();
    await settle(cycle, 1, -0.35);
    cycle.pauseMarket('R_100');
    const pending = cycle.beforePurchase('R_100');
    expect(cycle.offerRecoveryMarket(match, sample(), Date.now() / 1000 + 0.1)).toBe(false);
    cycle.market('R_100', sample(9), Date.now() / 1000 + 0.1);
    expect(cycle.canPurchase('TEST-DEMO')).toBe(true);
    expect(cycle.getSnapshot().losses).toBe(1);
    expect(await pending).toBe(true);
    expect(cycle.getSnapshot()).toMatchObject({ losses: 1, wins: 0, pnl: -35 });
    cycle.stop();
});
it('doubles XML recovery stakes and refuses stakes beyond the risk budget', async () => {
    const { cycle } = setup();
    await settle(cycle, 1, -0.35);
    expect(cycle.recoveryStake(0.35)).toBe(0.7);
    expect(cycle.recoveryStake(0.7)).toBe(1.4);
    expect(cycle.recoveryStake(1.4)).toBe(2.8);
    expect(cycle.recoveryStake(50)).toBeUndefined();
    expect(cycle.getSnapshot().enabled).toBe(false);
});
it('carries a frozen session configuration through XML reloads and uses its recovery multiplier', async () => {
    const cycle = new XmlScannerCycle();
    const draft = { stake: 1, stopLoss: 30, multiplier: 3 };
    cycle.start('TEST-DEMO', 100, jest.fn(), undefined, draft);
    draft.multiplier = 8;
    const token = cycle.claim(match)!;
    cycle.loaded(token, { takeProfit: 1000, stopLoss: 3000 });
    cycle.runStarted();
    await settle(cycle, 1, -1);
    expect(cycle.recoveryStake(1)).toBe(3);
    expect(cycle.getSnapshot().settings).toEqual({ stake: 1, stopLoss: 30, multiplier: 3 });
    cycle.stop();
    cycle.start('TEST-DEMO', 100, jest.fn(), undefined, { stake: 2, stopLoss: 50, multiplier: 2 });
    expect(cycle.getSnapshot().settings).toEqual({ stake: 2, stopLoss: 50, multiplier: 2 });
    cycle.stop();
});
it('enforces the chosen session loss budget during recovery', async () => {
    const cycle = new XmlScannerCycle();
    cycle.start('TEST-DEMO', 100, jest.fn(), undefined, { stake: 1, stopLoss: 1.5, multiplier: 2 });
    const token = cycle.claim(match)!;
    cycle.loaded(token, { takeProfit: 1000, stopLoss: 150 });
    cycle.runStarted();
    await settle(cycle, 1, -1);
    expect(cycle.recoveryStake(1)).toBeUndefined();
    expect(cycle.getSnapshot().enabled).toBe(false);
});
