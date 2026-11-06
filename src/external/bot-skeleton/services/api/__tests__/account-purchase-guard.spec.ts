import { scannerExitGuard } from '@/utils/scanner-exit-guard';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import { accountPurchaseGuard } from '../appId';
jest.mock('@deriv/deriv-api/dist/DerivAPIBasic', () => jest.fn());
jest.mock('../api-middleware', () => jest.fn());
afterEach(() => {
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
