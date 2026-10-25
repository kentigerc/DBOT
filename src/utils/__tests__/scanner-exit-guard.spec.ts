import { risingScannerDigits, ScannerExitGuard } from '../scanner-exit-guard';
const counts = () => Array<number>(10).fill(80);
it.each(['over', 'under'] as const)('detects two exact two-percentage-point rises only in the %s region', side => {
    const before = counts(),
        after = counts();
    const region = side === 'over' ? [0, 1] : [8, 9];
    after[region[0]] += 20;
    after[region[1]] += 19;
    expect(risingScannerDigits(before, after, side, 1000)).toEqual([region[0]]);
    after[region[1]]++;
    expect(risingScannerDigits(before, after, side, 1000)).toEqual(region);
    expect(risingScannerDigits(before, after, side === 'over' ? 'under' : 'over', 1000)).toEqual([]);
});
it('scales the percentage-point trigger with the scanner sample and ignores missing baselines', () => {
    expect(risingScannerDigits([], counts(), 'over', 1000)).toEqual([]);
    const before = counts().map(n => n / 10),
        after = [...before];
    after[0] += 2;
    after[1] += 2;
    expect(risingScannerDigits(before, after, 'over', 100)).toEqual([0, 1]);
});
const settle = (guard: ScannerExitGuard, id: number, profit: number) => {
    expect(guard.purchase()).toBe(true);
    guard.purchased(id);
    guard.contract({ contract_id: id, is_sold: 1, profit });
};
it('blocks another purchase immediately and stops once when there is no loss or open contract', async () => {
    const guard = new ScannerExitGuard(),
        stop = jest.fn();
    guard.begin(stop);
    guard.trigger();
    guard.trigger();
    expect(guard.purchase()).toBe(false);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
});
it('settles an open trade before allowing recovery and stops after its recovery win', async () => {
    const guard = new ScannerExitGuard(),
        stop = jest.fn();
    guard.begin(stop);
    guard.purchase();
    guard.purchased(1);
    guard.trigger();
    expect(guard.getSnapshot().phase).toBe('settling');
    expect(guard.purchase()).toBe(false);
    guard.contract({ contract_id: 1, is_sold: 1, profit: -0.35 });
    expect(guard.getSnapshot()).toMatchObject({ phase: 'recovering', losses: 1 });
    expect(stop).not.toHaveBeenCalled();
    settle(guard, 2, 0.67);
    expect(guard.purchase()).toBe(false);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
});
it('includes pre-trigger losses and blocks the fifth buy at four consecutive losses total', async () => {
    const guard = new ScannerExitGuard(),
        stop = jest.fn();
    guard.begin(stop);
    for (let id = 1; id <= 3; id++) settle(guard, id, -0.35);
    guard.trigger();
    expect(guard.getSnapshot()).toMatchObject({ phase: 'recovering', losses: 3 });
    settle(guard, 4, -0.74);
    expect(guard.getSnapshot()).toMatchObject({ phase: 'stopped', losses: 4 });
    expect(guard.purchase()).toBe(false);
    guard.contract({ contract_id: 4, is_sold: 1, profit: -0.74 });
    expect(guard.getSnapshot().losses).toBe(4);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
});
it('stops after an open trade wins and ignores unrelated or unsettled contracts', async () => {
    const guard = new ScannerExitGuard(),
        stop = jest.fn();
    guard.begin(stop);
    guard.purchase();
    guard.purchased(1);
    guard.trigger();
    guard.contract({ contract_id: 99, is_sold: 1, profit: -1 });
    guard.contract({ contract_id: 1, is_sold: 0, profit: -1 });
    expect(guard.getSnapshot().losses).toBe(0);
    guard.contract({ contract_id: 1, is_sold: 1, profit: 0.12 });
    expect(guard.purchase()).toBe(false);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
});
it('manual stop prevents more recovery purchases and a stale stop callback cannot stop a new run', async () => {
    const guard = new ScannerExitGuard(),
        stop = jest.fn();
    guard.begin(stop);
    settle(guard, 1, -0.35);
    guard.trigger();
    guard.cancel();
    expect(guard.purchase()).toBe(false);
    guard.begin(stop);
    guard.trigger();
    guard.begin(stop);
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    expect(guard.purchase()).toBe(true);
});
it('an unknown settlement blocks recovery without inventing a loss count', async () => {
    const guard = new ScannerExitGuard(),
        stop = jest.fn();
    guard.begin(stop);
    guard.purchase();
    guard.purchased(1);
    guard.trigger();
    guard.contract({ contract_id: 1, is_sold: 1 });
    expect(guard.purchase()).toBe(false);
    expect(guard.getSnapshot().losses).toBe(0);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
});
it('does not count rejected purchases as losses during recovery', () => {
    const guard = new ScannerExitGuard();
    guard.begin(jest.fn());
    settle(guard, 1, -0.35);
    guard.trigger();
    expect(guard.purchase()).toBe(true);
    guard.purchaseFailed();
    expect(guard.getSnapshot()).toMatchObject({ phase: 'recovering', losses: 1 });
    expect(guard.purchase()).toBe(true);
});
it('stops conservatively if a pre-trigger settlement has an unknown result', async () => {
    const guard = new ScannerExitGuard(),
        stop = jest.fn();
    guard.begin(stop);
    guard.purchase();
    guard.purchased(1);
    guard.contract({ contract_id: 1, is_sold: 1 });
    guard.trigger();
    expect(guard.purchase()).toBe(false);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
});
