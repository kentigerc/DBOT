import { manualTraderGate } from '@/utils/manual-trader-gate';
import * as session from '@/utils/deriv-session';
import { scannerExitGuard } from '@/utils/scanner-exit-guard';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import { accountPurchaseGuard } from '../appId';
jest.mock('@deriv/deriv-api/dist/DerivAPIBasic', () => jest.fn());
jest.mock('../api-middleware', () => jest.fn());
afterEach(() => {
    manualTraderGate.configure();
    jest.restoreAllMocks();
    xmlScannerCycle.stop();
    xmlScannerCycle.manualRun();
    scannerExitGuard.cancel();
});
it('a percentage-guard rejection must not leave an XML purchase reserved or unconfirmed', async () => {
    const counts = [9, 9, 9, 8, 10, 10, 11, 11, 11, 12];
    xmlScannerCycle.start('TEST', 100, jest.fn());
    const token = xmlScannerCycle.claim({
        symbol: 'R_100',
        side: 'over',
        name: 'Over Punisher',
        submarket: 'random_index',
        sampleSize: 100,
        baselineCounts: counts,
    })!;
    xmlScannerCycle.loaded(token, { takeProfit: 1000, stopLoss: 10000 });
    xmlScannerCycle.runStarted();
    const digits = counts.flatMap((n, d) => Array<number>(n).fill(d));
    digits.splice(digits.indexOf(1), 1);
    digits.push(1);
    xmlScannerCycle.market('R_100', digits, Date.now() / 1000);
    expect(await xmlScannerCycle.beforePurchase('R_100')).toBe(true);
    scannerExitGuard.begin(jest.fn());
    scannerExitGuard.trigger();
    expect(accountPurchaseGuard('TEST').purchase()).toBe(false);
    xmlScannerCycle.stop();
    expect(() => xmlScannerCycle.start('TEST', 100, jest.fn())).not.toThrow();
});

it('a Manual Trader rejection must not reserve scanner or XML state before wire submission', async () => {
    jest.spyOn(session, 'getDerivAccount').mockReturnValue({
        account_id: 'TEST', account_type: 'demo', currency: 'USD', status: 'active', balance: 1000,
    });
    manualTraderGate.configure({
        accountId: 'TEST', symbol: 'R_100', side: 'over',
        fileName: 'over-1-over-0.xml', name: 'Over Switcher',
    });
    const workspace = {
        getAllBlocks: () => [
            { type: 'notify', data: 'netoacademy:hosted-bot:over-1-over-0.xml', getFieldValue: () => '' },
            { type: 'trade_definition_market', getFieldValue: () => 'R_100' },
        ],
    };
    const counts = [9, 9, 9, 8, 10, 10, 11, 11, 11, 12];
    xmlScannerCycle.start('TEST', 100, jest.fn());
    const token = xmlScannerCycle.claim({
        symbol: 'R_100', side: 'over', name: 'Over Punisher', submarket: 'random_index',
        sampleSize: 100, baselineCounts: counts,
    })!;
    xmlScannerCycle.loaded(token, { takeProfit: 1000, stopLoss: 10000 });
    xmlScannerCycle.runStarted();
    const digits = counts.flatMap((n, digit) => Array<number>(n).fill(digit));
    digits.splice(digits.indexOf(1), 1);
    digits.push(1);
    xmlScannerCycle.market('R_100', digits, Date.now() / 1000);
    expect(await xmlScannerCycle.beforePurchase('R_100')).toBe(true);
    scannerExitGuard.begin(jest.fn());
    const guard = accountPurchaseGuard('TEST');
    expect(guard.purchase()).toBe(false); // The Manual Trader plan has not received RUN.
    expect(xmlScannerCycle.canPurchase('TEST')).toBe(true);
    scannerExitGuard.trigger();
    expect(scannerExitGuard.getSnapshot().phase).toBe('stopped'); // No phantom pending contract.
    scannerExitGuard.begin(jest.fn());
    manualTraderGate.begin(workspace, jest.fn());
    expect(guard.purchase()).toBe(true);
    xmlScannerCycle.purchaseFailed(); // The test never submits a wire order.
});
