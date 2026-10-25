export type ScannerWatch = {
    symbol: string;
    side: 'over' | 'under';
    sampleSize: number;
    name: string;
};
const storageKey = 'neto.scanner-watch';
export function readScannerWatch(): ScannerWatch | null {
    try {
        const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
        return value &&
            /^(R_\d+|1HZ\d+V)$/.test(value.symbol) &&
            ['over', 'under'].includes(value.side) &&
            [100, 500, 1000].includes(value.sampleSize) &&
            typeof value.name === 'string' &&
            value.name.length <= 120
            ? value
            : null;
    } catch {
        return null;
    }
}
let watch: ScannerWatch | null = readScannerWatch();
const listeners = new Set<() => void>();
export const getScannerWatch = () => watch;
export const subscribeScannerWatch = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
export function setScannerWatch(next: ScannerWatch | null) {
    watch = next;
    try {
        if (next) sessionStorage.setItem(storageKey, JSON.stringify(next));
        else sessionStorage.removeItem(storageKey);
    } catch {
        /* Monitoring still works when browser storage is unavailable. */
    }
    listeners.forEach(listener => listener());
}
