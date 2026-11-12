import { BuilderDemoPause } from '../builder-demo-pause';
import { getDerivAccount } from '../deriv-session';
jest.mock('../deriv-session', () => ({ getDerivAccount: jest.fn() }));
const real = { account_id: 'REAL1', account_type: 'real' as const, currency: 'USD', balance: 1000, status: 'active' };
const parameters = {
    symbol: '1HZ50V',
    contract_type: 'DIGITUNDER',
    barrier: '8',
    duration: 2,
    duration_unit: 't',
    amount: 6.85,
};
const originalFetch = global.fetch;
let guard: BuilderDemoPause;
let stop: jest.Mock;
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response;
const won = { triggerContractId: 4, completed: 3, wins: 1, status: 'done', demoAccountId: 'DEMO1' };
beforeEach(() => {
    jest.mocked(getDerivAccount).mockReturnValue(real);
    guard = new BuilderDemoPause();
    stop = jest.fn();
    guard.begin(real, false, stop, jest.fn());
    global.fetch = jest.fn();
});
afterEach(() => {
    guard.stop();
    global.fetch = originalFetch;
    jest.useRealTimers();
});
const settle = (id: number, profit: number, stake = 0.35) => {
    guard.purchased(real.account_id, id, stake);
    guard.contract(real.account_id, { contract_id: id, is_sold: 1 }, profit);
};
async function threeRecoveryLosses() {
    for (let id = 1; id <= 3; id++) {
        settle(id, -0.35);
        expect(await guard.beforePurchase(real.account_id, parameters, 6.85)).toBe(true);
    }
    expect(global.fetch).not.toHaveBeenCalled();
    settle(4, -0.35);
}
it('holds the original real order through demo losses and resumes after a win at the unchanged stake', async () => {
    jest.useFakeTimers();
    await threeRecoveryLosses();
    let finish!: (response: Response) => void;
    jest.mocked(global.fetch).mockImplementation((_url, options) =>
        options?.method === 'POST'
            ? new Promise(resolve => {
                  finish = resolve;
              })
            : Promise.resolve(response({ demoPause: { ...won, status: 'running', wins: 0, completed: 2 } }))
    );
    const original = { ...parameters };
    const pending = guard.beforePurchase(real.account_id, parameters, 6.85);
    expect(guard.canPurchase(real.account_id)).toBe(false);
    const sent = JSON.parse(jest.mocked(global.fetch).mock.calls[0][1]!.body as string);
    expect(sent.spec).toEqual({
        triggerContractId: 4,
        stake: 0.35,
        contract: {
            symbol: '1HZ50V',
            contract_type: 'DIGITUNDER',
            barrier: '8',
            duration: 2,
            duration_unit: 't',
        },
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(guard.getSnapshot().demoPause).toMatchObject({ completed: 2, wins: 0, heldStake: 685 });
    expect(guard.canPurchase(real.account_id)).toBe(false);
    finish(response({ demoPause: won }));
    expect(await pending).toBe(true);
    expect(guard.canPurchase(real.account_id)).toBe(true);
    expect(parameters).toEqual(original);
    for (const id of [5, 6, 7]) settle(id, -0.35);
    jest.mocked(global.fetch).mockResolvedValue(
        response({ demoPause: { ...won, triggerContractId: 7, completed: 1 } })
    );
    expect(await guard.beforePurchase(real.account_id, parameters, 60.44)).toBe(true);
    expect(
        JSON.parse(
            jest.mocked(global.fetch).mock.calls[jest.mocked(global.fetch).mock.calls.length - 1][1]!.body as string
        ).spec.triggerContractId
    ).toBe(7);
});
it('does not layer another pause over XML Auto or a demo-only bot', async () => {
    for (const [account, automatic] of [
        [real, true],
        [{ ...real, account_type: 'demo' as const }, false],
    ] as const) {
        guard.begin(account, automatic, stop, jest.fn());
        for (let id = 1; id < 8; id++) settle(id, -0.35);
        expect(await guard.beforePurchase(real.account_id, parameters, 6.85)).toBe(true);
    }
    expect(global.fetch).not.toHaveBeenCalled();
});
it('ignores duplicate settlements and resets the loss sequence on a real win', async () => {
    settle(1, -0.35);
    for (let n = 0; n < 5; n++) guard.contract(real.account_id, { contract_id: 1, is_sold: 1 }, -0.35);
    settle(2, 0.32);
    for (let id = 3; id < 6; id++) settle(id, -0.35);
    expect(await guard.beforePurchase(real.account_id, parameters, 6.85)).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
});
it('blocks real resumption on an incomplete or failed demo job', async () => {
    for (const value of [
        response({ demoPause: { ...won, completed: 2, wins: 0 } }),
        response({ error: 'Demo unavailable' }, false),
    ]) {
        guard.begin(real, false, stop, jest.fn());
        await threeRecoveryLosses();
        jest.mocked(global.fetch).mockResolvedValue(value);
        expect(await guard.beforePurchase(real.account_id, parameters, 6.85)).toBe(false);
        expect(guard.getSnapshot().enabled).toBe(false);
        expect(stop).toHaveBeenCalled();
        jest.mocked(global.fetch).mockReset();
    }
});
it('STOP aborts the demo request and a late winning result cannot release the held real order', async () => {
    await threeRecoveryLosses();
    let finish!: (response: Response) => void;
    jest.mocked(global.fetch).mockImplementation(
        () =>
            new Promise(resolve => {
                finish = resolve;
            })
    );
    const pending = guard.beforePurchase(real.account_id, parameters, 6.85);
    const signal = jest.mocked(global.fetch).mock.calls[0][1]!.signal!;
    guard.stop();
    expect(signal.aborted).toBe(true);
    finish(response({ demoPause: won }));
    expect(await pending).toBe(false);
});
