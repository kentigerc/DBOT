import { readScannerWatch, setScannerWatch } from '../scanner-watch';
afterEach(() => setScannerWatch(null));
it('persists the monitor link across page reloads and removes it on clear', () => {
    const watch = { symbol: 'R_100', side: 'over' as const, sampleSize: 1000, name: 'Over Punisher' };
    setScannerWatch(watch);
    expect(readScannerWatch()).toEqual(watch);
    setScannerWatch(null);
    expect(readScannerWatch()).toBeNull();
});
it('rejects corrupt or unsupported stored monitor settings', () => {
    for (const value of [
        'bad json',
        JSON.stringify({ symbol: 'R_100', side: 'over', sampleSize: -1, name: 'x' }),
        JSON.stringify({ symbol: 'invalid', side: 'over', sampleSize: 1000, name: 'x' }),
    ]) {
        sessionStorage.setItem('neto.scanner-watch', value);
        expect(readScannerWatch()).toBeNull();
    }
});
