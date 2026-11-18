import { HigherLowerBuilder, pairedWorkspace } from '../higher-lower-builder';
import { getDerivAccount } from '../deriv-session';
jest.mock('../deriv-session', () => ({ getDerivAccount: jest.fn(), sessionRequest: jest.fn() }));
beforeEach(() => {
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'DOT_TEST', account_type: 'demo', currency: 'USD' });
});
it('uses the isolated XML profile and passes normal Builder trade parameters to the server', async () => {
    const request = jest.fn(async (_path: string, body?: any) =>
        body?.command === 'start'
            ? { active: true, busy: false }
            : { active: false, busy: false, pnl: 25, pairs: 1, message: 'Pair limit reached.' }
    );
    const builder = new HigherLowerBuilder(
        request,
        async () => {},
        () => 'attempt-1'
    );
    await builder.run(0.5, 7, 10, 5, 1, 1, 'R_50');
    expect(request).toHaveBeenCalledWith(expect.stringContaining('source=xml'), {
        command: 'start',
        attempt: 'attempt-1',
        settings: { stake: 0.5, duration: 7, stopLoss: 10, takeProfit: 5, maxPairs: 1, symbol: 'R_50' },
    });
    expect(builder.getSnapshot()).toMatchObject({ running: false, pnl: 25, pairs: 1 });
});
it('STOP during delayed startup cancels the same attempt before and after its response', async () => {
    let resolve!: (state: any) => void;
    const request = jest.fn((_path: string, body?: any) =>
        body?.command === 'start'
            ? new Promise(r => {
                  resolve = r;
              })
            : Promise.resolve({ active: false, busy: false })
    );
    const builder = new HigherLowerBuilder(
        request,
        async () => {},
        () => 'cancel-me'
    );
    const running = builder.run(0.35, 5, 10, 5, 10, 1, 'R_100');
    await builder.stop();
    resolve({ active: true, busy: true });
    await running;
    expect(request.mock.calls.filter(c => c[1]?.command === 'stop')).toHaveLength(2);
    expect(request.mock.calls.filter(c => c[1]?.command === 'stop').every(c => c[1].attempt === 'cancel-me')).toBe(
        true
    );
    expect(builder.getSnapshot().running).toBe(false);
});
it('refuses real accounts and changed barrier values before any request', async () => {
    const request = jest.fn();
    const builder = new HigherLowerBuilder(request);
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'CR_TEST', account_type: 'real', currency: 'USD' });
    await expect(builder.run(0.35, 5, 10, 5, 10)).rejects.toThrow('demo');
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'DOT_TEST', account_type: 'demo', currency: 'USD' });
    await expect(builder.run(0.35, 5, 10, 5, 10, 2)).rejects.toThrow('barrier');
    expect(request).not.toHaveBeenCalled();
});
it('keeps ordinary XML unchanged and rejects mixed or misplaced paired purchase blocks', () => {
    expect(pairedWorkspace({ getAllBlocks: () => [] })).toBe(false);
    const pair = { type: 'neto_higher_lower_pair', getParent: () => ({ type: 'before_purchase' }) };
    expect(pairedWorkspace({ getAllBlocks: () => [pair] })).toBe(true);
    expect(() => pairedWorkspace({ getAllBlocks: () => [pair, { type: 'purchase' }] })).toThrow('ordinary Purchase');
    expect(() => pairedWorkspace({ getAllBlocks: () => [{ type: 'neto_higher_lower_pair' }] })).toThrow(
        'Purchase conditions'
    );
});
it('keeps reading known open contracts after entries stop without issuing another trade command', async () => {
    jest.useFakeTimers();
    const pending = { symbol: 'R_100', legs: [{ type: 'CALL', status: 'open', id: 101 }] };
    const request = jest
        .fn()
        .mockResolvedValueOnce({ active: false, busy: false, pending })
        .mockResolvedValueOnce({ active: false, busy: false, pending })
        .mockResolvedValue({ active: false, busy: false, pending: undefined, pairs: 1, pnl: 20 });
    const builder = new HigherLowerBuilder(
        request,
        async () => {},
        () => 'read-only'
    );
    try {
        await builder.run(0.35, 5, 10, 5, 1);
        expect(builder.getSnapshot().running).toBe(false);
        await jest.advanceTimersByTimeAsync(2000);
        expect(builder.getSnapshot()).toMatchObject({ pairs: 1, pnl: 20, pending: undefined });
        expect(request.mock.calls.filter(c => c[1])).toHaveLength(1);
        expect(request.mock.calls.filter(c => c[1])[0][1].command).toBe('start');
    } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
    }
});
it('ignores a delayed status reply after switching accounts', async () => {
    let release!: (value: any) => void;
    const request = jest
        .fn()
        .mockResolvedValueOnce({ active: false, busy: false })
        .mockResolvedValueOnce({ active: false, busy: false, pnl: 0 })
        .mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    release = resolve;
                })
        );
    const builder = new HigherLowerBuilder(
        request,
        async () => {},
        () => 'status-fence'
    );
    await builder.run(0.35, 5, 10, 5, 1);
    const reading = builder.readStatus();
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'DOT_OTHER', account_type: 'demo', currency: 'USD' });
    release({ pnl: 999, history: [{ symbol: 'R_100', legs: [] }] });
    await reading;
    expect(builder.getSnapshot().pnl).toBe(0);
});
it('restores server history read-only after reload and never starts orders', async () => {
    const request = jest.fn(async () => ({
        accountId: 'DOT_TEST',
        active: false,
        history: [{ symbol: 'R_100', at: 1, profit: 20, legs: [] }],
        pnl: 20,
        pairs: 1,
    }));
    const builder = new HigherLowerBuilder(request);
    await builder.restore('DOT_TEST');
    expect(builder.getSnapshot()).toMatchObject({ running: false, pairs: 1, pnl: 20 });
    expect(request).toHaveBeenCalledWith(expect.stringContaining('source=xml'));
    expect(request.mock.calls.every(call => call.length === 1)).toBe(true);
});
it('restored active sessions can be explicitly stopped without starting a new run', async () => {
    jest.useFakeTimers();
    const request = jest.fn(async (_url: string, body?: any) =>
        body?.command === 'stop' ? { active: false } : { active: true }
    );
    const builder = new HigherLowerBuilder(request);
    try {
        await builder.restore('DOT_TEST');
        expect(builder.getSnapshot().running).toBe(false);
        await builder.stopRestored();
        expect(request.mock.calls.filter(c => c[1]).map(c => c[1])).toEqual([{ command: 'stop' }]);
        expect(builder.getSnapshot().active).toBe(false);
    } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
    }
});
it('passive contract reads honor provider cooldowns and never dispatch purchases', async () => {
    jest.useFakeTimers();
    const request = jest
        .fn()
        .mockResolvedValueOnce({
            active: false,
            pending: { symbol: 'R_100', legs: [{ id: 101, type: 'CALL', status: 'open' }] },
        })
        .mockRejectedValueOnce(Object.assign(new Error('cooldown'), { retryAfter: 30 }))
        .mockResolvedValue({ active: false, pending: undefined });
    const builder = new HigherLowerBuilder(request);
    try {
        await builder.restore('DOT_TEST');
        await jest.advanceTimersByTimeAsync(2000);
        expect(request).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(29999);
        expect(request).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(1);
        expect(request).toHaveBeenCalledTimes(3);
        expect(request.mock.calls.every(c => c.length === 1)).toBe(true);
    } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
    }
});
