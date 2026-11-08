import { getDerivAccount } from '../deriv-session';
import { ManualTraderGate } from '../manual-trader-gate';
import { SWITCHERS, type ManualSide } from '../manual-trader-markets';
jest.mock('../deriv-session', () => ({ getDerivAccount: jest.fn() }));
const note = jest.fn();

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
});
afterEach(() => jest.useRealTimers());
it.each(['over', 'under'] as const)(
    'requires manual RUN for %s, then trades without further scanner entries',
    async side => {
        const { gate, workspace } = setup(side);
        expect(await gate.beforePurchase('R_100', SWITCHERS[side].direction)).toBe(false);
        expect(gate.canPurchase('TEST')).toBe(false);
        gate.begin(workspace, note);
        for (let i = 0; i < 5; i++) {
            expect(await gate.beforePurchase('R_100', SWITCHERS[side].direction)).toBe(true);
            expect(gate.canPurchase('TEST')).toBe(true);
            expect(gate.canPurchase('TEST')).toBe(false);
            gate.purchased(101 + i);
            gate.contract({ contract_id: 101 + i, is_sold: 1, profit: 0.12 });
            jest.advanceTimersByTime(60000); // Scanning data is not required after RUN.
        }
        expect(gate.getSnapshot().active).toBe(true);
        expect(gate.getSnapshot().phase).toMatch(/Trading continuously/);
        gate.stop();
        expect(await gate.beforePurchase('R_100', SWITCHERS[side].direction)).toBe(false);
        expect(gate.canPurchase('TEST')).toBe(false);
    }
);
it('retains XML recovery contracts and resumes normal trading immediately after a recovery win', async () => {
    const { gate, workspace } = setup();
    gate.begin(workspace, note);
    expect(gate.canPurchase('TEST')).toBe(true);
    gate.purchased(101);
    gate.contract({ contract_id: 101, is_sold: 1, profit: -0.35 });
    expect(await gate.beforePurchase('R_100', 'DIGITUNDER')).toBe(true);
    expect(gate.canPurchase('TEST')).toBe(true);
    gate.purchased(102);
    gate.contract({ contract_id: 102, is_sold: 1, profit: 0.63 });
    expect(await gate.beforePurchase('R_100', 'DIGITOVER')).toBe(true);
    expect(gate.canPurchase('TEST')).toBe(true);
    gate.stop();
});
it('STOP blocks late purchases and settlement messages cannot restart trading; manual RUN can resume', async () => {
    const { gate, workspace } = setup();
    gate.begin(workspace, note);
    expect(gate.canPurchase('TEST')).toBe(true);
    gate.purchased(101);
    gate.stop();
    gate.contract({ contract_id: 101, is_sold: 1, profit: 0.12 });
    expect(await gate.beforePurchase('R_100', 'DIGITOVER')).toBe(false);
    expect(gate.canPurchase('TEST')).toBe(false);
    expect(gate.getSnapshot().active).toBe(false);
    gate.begin(workspace, note);
    expect(await gate.beforePurchase('R_100', 'DIGITOVER')).toBe(true);
    gate.stop();
});
it('blocks altered markets, wrong contracts and different accounts', async () => {
    const { gate, workspace } = setup();
    gate.begin(workspace, note);
    expect(gate.canPurchase('OTHER')).toBe(false);
    expect(await gate.beforePurchase('R_50', 'DIGITOVER')).toBe(false);
    expect(await gate.beforePurchase('R_100', 'DIGITUNDER')).toBe(false);
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'OTHER' });
    expect(await gate.beforePurchase('R_100', 'DIGITOVER')).toBe(false);
    expect(() => gate.begin(workspace, note)).toThrow(/selection changed/);
    gate.stop();
});
it('requires fresh manual RUN after reload and releases unrelated personal workspaces', async () => {
    setup();
    const restored = new ManualTraderGate();
    expect(restored.getSnapshot().plan?.name).toBe('Over Switcher');
    expect(restored.getSnapshot().active).toBe(false);
    restored.begin({ getAllBlocks: () => [] }, note);
    expect(restored.getSnapshot().plan).toBeUndefined();
    expect(await restored.beforePurchase('R_50', 'DIGITOVER')).toBe(true);
});
