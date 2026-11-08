import { getDerivAccount } from '../deriv-session';
import { ManualTraderGate } from '../manual-trader-gate';
import { SWITCHERS, watchManualMarkets, type ManualMarket, type ManualSide } from '../manual-trader-markets';
jest.mock('../deriv-session', () => ({ getDerivAccount: jest.fn() }));
jest.mock('../manual-trader-markets', () => ({
    ...jest.requireActual('../manual-trader-markets'),
    watchManualMarkets: jest.fn(),
}));
let publish: (market: ManualMarket) => void;
const factory = jest.fn();
const note = jest.fn();
const reading = (): ManualMarket => ({
    symbol: 'R_100',
    name: 'Volatility 100',
    submarket: 'random_index',
    epoch: Date.now() / 1000,
    checkedAt: Date.now(),
    ready: true,
    count: 1000,
    latest: 3,
    digits: [],
    over: { percentage: 80, change: 0.1, armed: true, run: 2, epoch: Date.now() / 1000 },
    under: { percentage: 80, change: 0.1, armed: true, run: 2, epoch: Date.now() / 1000 },
});
function setup(side: ManualSide = 'over') {
    const gate = new ManualTraderGate();
    gate.configure({ accountId: 'TEST', symbol: 'R_100', side, ...SWITCHERS[side] });
    const workspace = {
        getAllBlocks: () => [
            { type: 'notify', data: `netoacademy:hosted-bot:${SWITCHERS[side].fileName}`, getFieldValue: () => '' },
            { type: 'trade_definition_market', getFieldValue: () => 'R_100' },
        ],
    };
    return { gate, workspace };
}
beforeEach(() => {
    sessionStorage.clear();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(1000000);
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'TEST' });
    (watchManualMarkets as jest.Mock).mockImplementation((_api, _signal, update) => {
        publish = update;
        return Promise.resolve();
    });
});
afterEach(() => jest.useRealTimers());
it.each(['over', 'under'] as const)(
    'loads %s without authorizing purchases, then waits for RUN and a live entry',
    async side => {
        const { gate, workspace } = setup(side);
        expect(watchManualMarkets).not.toHaveBeenCalled();
        expect(await gate.beforePurchase('R_100', SWITCHERS[side].direction)).toBe(false);
        expect(gate.canPurchase('TEST')).toBe(false);
        gate.begin(workspace, factory, note);
        let released = false;
        const waiting = gate.beforePurchase('R_100', SWITCHERS[side].direction).then(value => {
            released = value;
            return value;
        });
        await Promise.resolve();
        expect(released).toBe(false);
        const flat = reading();
        flat[side].change = 0;
        publish(flat);
        await Promise.resolve();
        expect(released).toBe(false);
        publish(reading());
        expect(await waiting).toBe(true);
        expect(gate.canPurchase('TEST')).toBe(true);
        expect(gate.canPurchase('TEST')).toBe(false);
        gate.stop();
    }
);
it('leaves XML recovery contracts unchanged after a loss and requires a new entry after the recovery win', async () => {
    const { gate, workspace } = setup();
    gate.begin(workspace, factory, note);
    publish(reading());
    expect(gate.canPurchase('TEST')).toBe(true);
    gate.purchased(101);
    gate.contract({ contract_id: 101, is_sold: 1, profit: -0.35 });
    expect(await gate.beforePurchase('R_100', 'DIGITUNDER')).toBe(true);
    expect(gate.canPurchase('TEST')).toBe(true);
    gate.purchased(102);
    gate.contract({ contract_id: 102, is_sold: 1, profit: 0.63 });
    expect(gate.canPurchase('TEST')).toBe(false);
    let settled = false;
    const next = gate.beforePurchase('R_100', 'DIGITOVER').then(value => {
        settled = value;
        return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    publish(reading());
    expect(await next).toBe(true);
    gate.stop();
});
it('STOP cancels a waiting entry and late market callbacks cannot restart trading', async () => {
    const { gate, workspace } = setup();
    gate.begin(workspace, factory, note);
    const pending = gate.beforePurchase('R_100', 'DIGITOVER');
    gate.stop();
    expect(await pending).toBe(false);
    publish(reading());
    expect(gate.canPurchase('TEST')).toBe(false);
    expect(gate.getSnapshot().active).toBe(false);
});
it('blocks stale entries, altered markets, wrong contracts and different accounts', async () => {
    const { gate, workspace } = setup();
    gate.begin(workspace, factory, note);
    publish(reading());
    jest.advanceTimersByTime(3501);
    expect(gate.canPurchase('TEST')).toBe(false);
    expect(await gate.beforePurchase('R_50', 'DIGITOVER')).toBe(false);
    expect(await gate.beforePurchase('R_100', 'DIGITUNDER')).toBe(false);
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'OTHER' });
    expect(await gate.beforePurchase('R_100', 'DIGITOVER')).toBe(false);
    gate.stop();
});
it('requires fresh manual RUN after reload and releases unrelated personal workspaces', async () => {
    setup();
    const restored = new ManualTraderGate();
    expect(restored.getSnapshot().plan?.name).toBe('Over Switcher');
    expect(restored.getSnapshot().active).toBe(false);
    restored.begin({ getAllBlocks: () => [] }, factory, note);
    expect(restored.getSnapshot().plan).toBeUndefined();
    expect(await restored.beforePurchase('R_50', 'DIGITOVER')).toBe(true);
    expect(watchManualMarkets).not.toHaveBeenCalled();
});
