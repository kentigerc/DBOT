import { scanXmlParityRecovery } from '@/utils/xml-parity-recovery';
jest.mock('@/utils/xml-parity-recovery', () => ({ scanXmlParityRecovery: jest.fn() }));
import Purchase from '../Purchase';
import { BEFORE_PURCHASE } from '../state/constants';
import { api_base } from '../../../api/api-base';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
jest.mock('../../../api/api-helpers', () => ({
    __esModule: true,
    default: { instance: { contracts_for: { getContractsFor: jest.fn() } } },
}));
jest.mock('../../../api/api-base', () => ({ api_base: { api: { send: jest.fn() } } }));
jest.mock('../../utils/broadcast', () => ({ contractStatus: jest.fn(), info: jest.fn(), log: jest.fn() }));
jest.mock('../../../../constants/messages', () => ({ LogTypes: { PURCHASE: 'purchase' } }));
jest.mock('../../utils/helpers', () => ({
    doUntilDone: (action: () => unknown) => action(),
    getUUID: () => 'test',
    recoverFromError: jest.fn(),
    tradeOptionToBuy: (type: string, options: unknown) => ({
        buy: 1,
        parameters: { ...(options as object), contract_type: type },
    }),
}));
jest.mock('../state/actions', () => ({ purchaseSuccessful: () => ({ type: 'purchase' }) }));
class Base {
    store = { getState: () => ({ scope: BEFORE_PURCHASE }), dispatch: jest.fn() };
    tradeOptions = { symbol: 'R_100', amount: 0.35, prediction: 4, currency: 'USD' };
    options = { timeMachineEnabled: false };
    accountInfo = { loginid: 'TEST' };
    updateAndReturnTotalRuns = () => 1;
}
afterEach(() => jest.restoreAllMocks());
it('does not send the XML purchase until the scanner entry gate allows it', async () => {
    let release!: (allow: boolean) => void;
    const gate = jest.spyOn(xmlScannerCycle, 'beforePurchase').mockImplementation(
        () =>
            new Promise(resolve => {
                release = resolve;
            })
    );
    (api_base.api.send as jest.Mock).mockResolvedValue({
        buy: { contract_id: 123, transaction_id: 124, buy_price: 0.35 },
    });
    const engine = new (Purchase(Base))();
    const request = engine.purchase('DIGITUNDER');
    expect(gate).toHaveBeenCalledWith('R_100');
    expect(api_base.api.send).not.toHaveBeenCalled();
    release(true);
    await request;
    // Normal XML purchases retain their original contract and prediction.
    expect(api_base.api.send).toHaveBeenCalledWith(
        expect.objectContaining({ parameters: expect.objectContaining({ contract_type: 'DIGITUNDER', prediction: 4 }) })
    );
});
it('STOP while waiting for entry prevents a wire purchase', async () => {
    jest.spyOn(xmlScannerCycle, 'beforePurchase').mockResolvedValue(false);
    const engine = new (Purchase(Base))();
    await engine.purchase('DIGITOVER');
    expect(api_base.api.send).not.toHaveBeenCalled();
});

it('overrides only XML Auto recovery with a 1-tick parity order on the selected market and preserves the normal XML settings', async () => {
    jest.spyOn(xmlScannerCycle, 'beforePurchase').mockResolvedValue(true);
    jest.spyOn(xmlScannerCycle, 'isRecovering').mockReturnValue(true);
    jest.spyOn(xmlScannerCycle, 'valid').mockReturnValue(true);
    jest.spyOn(xmlScannerCycle, 'recoveryStake').mockReturnValue(0.7);
    (scanXmlParityRecovery as jest.Mock).mockResolvedValue({
        symbol: '1HZ50V',
        direction: 'DIGITEVEN',
        epoch: Date.now() / 1000,
    });
    (api_base.api.send as jest.Mock).mockResolvedValue({
        buy: { contract_id: 124, transaction_id: 125, buy_price: 0.7 },
    });
    const engine = new (Purchase(Base))();
    engine.xmlLastPurchaseStake = 0.35;
    await engine.purchase('DIGITUNDER');
    expect(api_base.api.send).toHaveBeenCalledWith(
        expect.objectContaining({
            parameters: {
                symbol: '1HZ50V',
                amount: 0.7,
                basis: 'stake',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                contract_type: 'DIGITEVEN',
                app_markup_percentage: undefined,
            },
        })
    );
    expect(engine.tradeOptions).toMatchObject({ symbol: 'R_100', amount: 0.35, prediction: 4 });
    expect(engine.xmlLastPurchaseStake).toBe(0.7);
});
it('STOP cancels parity selection before any recovery purchase is submitted', async () => {
    let active = true;
    let changed!: () => void;
    jest.spyOn(xmlScannerCycle, 'beforePurchase').mockResolvedValue(true);
    jest.spyOn(xmlScannerCycle, 'isRecovering').mockImplementation(() => active);
    jest.spyOn(xmlScannerCycle, 'valid').mockImplementation(() => active);
    jest.spyOn(xmlScannerCycle, 'recoveryStake').mockReturnValue(0.7);
    jest.spyOn(xmlScannerCycle, 'subscribe').mockImplementation(listener => {
        changed = listener;
        return () => {};
    });
    (scanXmlParityRecovery as jest.Mock).mockImplementation(
        (_api, _size, signal: AbortSignal) =>
            new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }))
    );
    const engine = new (Purchase(Base))();
    engine.xmlLastPurchaseStake = 0.35;
    const pending = engine.purchase('DIGITOVER');
    await Promise.resolve();
    active = false;
    changed();
    await pending;
    expect(api_base.api.send).not.toHaveBeenCalled();
});
