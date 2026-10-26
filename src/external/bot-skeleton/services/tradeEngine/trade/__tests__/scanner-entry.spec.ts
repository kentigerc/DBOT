import Purchase from '../Purchase';
import { BEFORE_PURCHASE } from '../state/constants';
import { api_base } from '../../../api/api-base';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
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
    tradeOptions = { symbol: 'R_100', amount: 0.35, prediction: 4 };
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
    // Scanner coordination must not replace XML contract/barrier/recovery choices.
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
