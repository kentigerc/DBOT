import { getDerivAccount } from '../deriv-session';
import { XmlScannerCycle } from '../xml-scanner-cycle';

jest.mock('../deriv-session', () => ({ getDerivAccount: jest.fn() }));
const account = jest.mocked(getDerivAccount);
const originalFetch = global.fetch;
const counts = [9, 9, 9, 8, 10, 10, 11, 11, 11, 12];
let cycles: XmlScannerCycle[] = [];
beforeEach(() => {
    account.mockReturnValue({
        account_id: 'REAL1',
        account_type: 'real',
        currency: 'USD',
        status: 'active',
        balance: 1000,
    });
    global.fetch = jest.fn();
});
afterEach(() => {
    cycles.forEach(cycle => cycle.stop());
    cycles = [];
    global.fetch = originalFetch;
});
function setup() {
    const cycle = new XmlScannerCycle();
    cycles.push(cycle);
    cycle.start('REAL1', 100, jest.fn(), undefined, { stake: 0.35, stopLoss: 100, takeProfit: 10, multiplier: 2 });
    const generation = cycle.claim({
        symbol: 'R_100',
        side: 'over',
        name: 'Over Punisher',
        submarket: 'random_index',
        sampleSize: 100,
        baselineCounts: counts,
    })!;
    cycle.loaded(generation, { takeProfit: 1000, stopLoss: 10000 });
    cycle.runStarted();
    return { cycle, generation };
}
async function lose(cycle: XmlScannerCycle, id: number, amount: number) {
    const digits = counts.flatMap((n, digit) => Array<number>(n).fill(digit));
    digits.splice(digits.indexOf(1), 1);
    digits.push(1);
    cycle.market('R_100', digits, Date.now() / 1000);
    expect(await cycle.beforePurchase('R_100')).toBe(true);
    expect(cycle.purchase('REAL1')).toBe(true);
    cycle.purchased(id);
    cycle.contract({ contract_id: id, is_sold: 1, profit: -amount });
}
const parameters = { symbol: 'R_50', contract_type: 'DIGITEVEN', duration: 2, amount: 5.6 };
const completed = {
    triggerContractId: 4,
    completed: 2,
    status: 'done',
    demoAccountId: 'DEMO1',
    trades: [
        { contractId: 51, profit: -35 },
        { contractId: 52, profit: -35 },
    ],
};
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response;

it('counts only recovery losses, pauses before the fourth recovery and retains real P/L and stake after two demo losses', async () => {
    const { cycle, generation } = setup();
    for (const [index, amount] of [0.35, 0.7, 1.4].entries()) {
        await lose(cycle, index + 1, amount);
        expect(await cycle.runDemoPause(parameters, generation)).toBe(true);
    }
    expect(global.fetch).not.toHaveBeenCalled();
    await lose(cycle, 4, 2.8);
    const before = cycle.getSnapshot();
    expect(cycle.recoveryStake(2.8)).toBe(5.6);
    let resolve!: (value: Response) => void;
    jest.mocked(global.fetch).mockImplementation(
        () =>
            new Promise(done => {
                resolve = done;
            })
    );
    const pending = cycle.runDemoPause(parameters, generation);
    expect(cycle.canPurchase('REAL1')).toBe(false);
    expect(cycle.getSnapshot().demoPause).toMatchObject({ completed: 0, heldStake: 560 });
    const [url, options] = jest.mocked(global.fetch).mock.calls[0];
    expect(url).toBe('/api/analysis?account_id=REAL1');
    expect(JSON.parse(options!.body as string)).toEqual({
        action: 'demo-break',
        spec: {
            triggerContractId: 4,
            symbol: 'R_50',
            direction: 'DIGITEVEN',
            duration: 2,
            stake: 0.35,
        },
    });
    resolve(response({ demoPause: completed }));
    expect(await pending).toBe(true);
    expect(cycle.getSnapshot()).toMatchObject({ pnl: before.pnl, losses: 4, deficit: before.deficit });
    expect(cycle.recoveryStake(2.8)).toBe(5.6);
    expect(await cycle.runDemoPause(parameters, generation)).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // A subsequent group of three real recovery losses requires another pause.
    for (const [index, amount] of [5.6, 11.2, 22.4].entries()) await lose(cycle, index + 5, amount);
    jest.mocked(global.fetch).mockResolvedValue(response({ demoPause: { ...completed, triggerContractId: 7 } }));
    expect(await cycle.runDemoPause(parameters, generation)).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
});

it('does not detour a demo-only session', async () => {
    account.mockReturnValue({
        account_id: 'REAL1',
        account_type: 'demo',
        currency: 'USD',
        status: 'active',
        balance: 1000,
    });
    const { cycle, generation } = setup();
    for (let id = 1; id <= 4; id++) await lose(cycle, id, 0.35);
    expect(await cycle.runDemoPause(parameters, generation)).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
});

it('cannot resume after STOP even if the demo request responds late', async () => {
    const { cycle, generation } = setup();
    for (let id = 1; id <= 4; id++) await lose(cycle, id, 0.35);
    let resolve!: (value: Response) => void;
    jest.mocked(global.fetch).mockImplementation(
        () =>
            new Promise(done => {
                resolve = done;
            })
    );
    const pending = cycle.runDemoPause(parameters, generation);
    const signal = jest.mocked(global.fetch).mock.calls[0][1]!.signal!;
    cycle.stop();
    expect(signal.aborted).toBe(true);
    resolve(response({ demoPause: completed }));
    expect(await pending).toBe(false);
    expect(cycle.canPurchase('REAL1')).toBe(false);
});

it('stops real recovery when demo execution is unavailable or incomplete', async () => {
    for (const result of [
        response({ error: 'Demo account unavailable' }, false),
        response({ demoPause: { ...completed, completed: 1 } }),
    ]) {
        const { cycle, generation } = setup();
        for (let id = 1; id <= 4; id++) await lose(cycle, id, 0.35);
        jest.mocked(global.fetch).mockResolvedValue(result);
        expect(await cycle.runDemoPause(parameters, generation)).toBe(false);
        expect(cycle.getSnapshot().enabled).toBe(false);
        expect(cycle.canPurchase('REAL1')).toBe(false);
    }
});
