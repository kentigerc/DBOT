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
