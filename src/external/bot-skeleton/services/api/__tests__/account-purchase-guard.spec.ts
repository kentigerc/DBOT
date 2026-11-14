import { accountPurchaseGuard } from '../appId';
import { builderDemoPause } from '@/utils/builder-demo-pause';
import { manualTraderGate } from '@/utils/manual-trader-gate';
import { scannerExitGuard } from '@/utils/scanner-exit-guard';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';

jest.mock('@deriv/deriv-api/dist/DerivAPIBasic', () => jest.fn());
jest.mock('../api-middleware', () => jest.fn());
jest.mock('@/utils/api-keepalive', () => ({ startApiKeepalive: jest.fn() }));
jest.mock('@/utils/deriv-session', () => ({ getDerivAccount: jest.fn(), getDerivSession: jest.fn() }));
jest.mock('@/utils/builder-demo-pause', () => ({ builderDemoPause: { canPurchase: jest.fn() } }));
jest.mock('@/utils/manual-trader-gate', () => ({
    manualTraderGate: { allowsPurchase: jest.fn(), canPurchase: jest.fn() },
}));
jest.mock('@/utils/scanner-exit-guard', () => ({ scannerExitGuard: { purchase: jest.fn() } }));
jest.mock('@/utils/xml-scanner-cycle', () => ({
    xmlScannerCycle: { canPurchase: jest.fn(), purchase: jest.fn() },
}));

it('leaves no phantom browser purchase when Manual Trader rejects before wire submission', () => {
    let allowed = false;
    let scannerReserved = false;
    let xmlReserved = false;
    jest.mocked(builderDemoPause.canPurchase).mockReturnValue(true);
    jest.mocked(xmlScannerCycle.canPurchase).mockReturnValue(true);
    jest.mocked(manualTraderGate.allowsPurchase).mockImplementation(() => allowed);
    jest.mocked(manualTraderGate.canPurchase).mockImplementation(() => allowed);
    jest.mocked(scannerExitGuard.purchase).mockImplementation(() => {
        scannerReserved = true;
        return true;
    });
    jest.mocked(xmlScannerCycle.purchase).mockImplementation(() => {
        xmlReserved = true;
        return true;
    });
    const guard = accountPurchaseGuard('TEST');
    expect(guard.purchase()).toBe(false);
    expect(scannerReserved).toBe(false);
    expect(xmlReserved).toBe(false);
    allowed = true;
    expect(guard.purchase()).toBe(true);
    expect(scannerReserved).toBe(true);
    expect(xmlReserved).toBe(true);
});
