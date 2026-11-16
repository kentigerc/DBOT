import Total from '../Total';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';

jest.mock('@/components/shared', () => ({ getRoundedNumber: (n: number) => Math.round(n * 100) / 100 }));
jest.mock('@/utils/xml-scanner-cycle', () => ({ xmlScannerCycle: { getSnapshot: jest.fn() } }));
jest.mock('@/utils/builder-demo-pause', () => ({ builderDemoPause: { contract: jest.fn() } }));
jest.mock('@deriv-com/translations', () => ({ localize: (text: string) => text }));
jest.mock('../../../../utils/observer', () => ({ observer: { register: jest.fn() } }));
jest.mock('../../utils/broadcast', () => ({ info: jest.fn(), log: jest.fn() }));

class Base {
    accountInfo = { loginid: 'SCANNER-TEST' };
}
const snapshot = xmlScannerCycle.getSnapshot as jest.Mock;
const Engine = Total(Base);
let engine: InstanceType<typeof Engine>;
beforeEach(() => {
    engine = new Engine();
    engine.clearStatistics();
    snapshot.mockReturnValue({ enabled: false, accountId: '', pnl: 0 });
});

it.each([-25, 40])('excludes earlier account profit of $%s from a fresh XML Auto session', historicalProfit => {
    engine.updateTotals({ buy_price: 50, sell_price: 50 + historicalProfit, currency: 'USD' });
    expect(engine.getTotalProfit(false, 'USD')).toBe(historicalProfit);
    snapshot.mockReturnValue({ enabled: true, accountId: 'SCANNER-TEST', pnl: 0 });
    expect(engine.getTotalProfit(false, 'USD')).toBe(0);
    snapshot.mockReturnValue({ enabled: true, accountId: 'SCANNER-TEST', pnl: -125 });
    expect(engine.getTotalProfit(false, 'USD')).toBe(-1.25);
    expect(engine.getTotalProfit(true, 'USD')).toBe(-1.25);
    // The account summary still retains its full history.
    expect(engine.getAccountStat().totalProfit).toBe(historicalProfit);
});

it('uses cumulative XML Auto profit across fresh Builder batches', () => {
    engine.updateTotals({ buy_price: 1, sell_price: 11, currency: 'USD' });
    snapshot.mockReturnValue({ enabled: true, accountId: 'SCANNER-TEST', pnl: -274 });
    const nextBatch = new Engine();
    expect(nextBatch.getTotalProfit(false, 'USD')).toBe(-2.74);
    expect(nextBatch.getAccountStat().totalProfit).toBe(10);
});

it('keeps ordinary Builder profit behavior when Auto is stopped or belongs to another account', () => {
    engine.updateTotals({ buy_price: 1, sell_price: 3, currency: 'USD' });
    snapshot.mockReturnValue({ enabled: true, accountId: 'OTHER', pnl: -500 });
    expect(engine.getTotalProfit(false, 'USD')).toBe(2);
    snapshot.mockReturnValue({ enabled: false, accountId: 'SCANNER-TEST', pnl: -500 });
    expect(engine.getTotalProfit(false, 'USD')).toBe(2);
});
