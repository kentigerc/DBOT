export type ScannerWatch = {
    symbol: string;
    side: 'over' | 'under';
    sampleSize: number;
    name: string;
    baselineCounts?: number[];
    automatic?: boolean;
};
const storageKey = 'neto.scanner-watch';
export function readScannerWatch(): ScannerWatch | null {
    try {
        const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
        return value &&
            /^(R_\d+|1HZ\d+V)$/.test(value.symbol) &&
            ['over', 'under'].includes(value.side) &&
            [100, 500, 1000].includes(value.sampleSize) &&
            (value.automatic === undefined || typeof value.automatic === 'boolean') &&
            typeof value.name === 'string' &&
            value.name.length <= 120 &&
            (value.baselineCounts === undefined ||
                (Array.isArray(value.baselineCounts) &&
                    value.baselineCounts.length === 10 &&
                    value.baselineCounts.every(
                        (count: number) => Number.isInteger(count) && count >= 0 && count <= value.sampleSize
                    )))
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

// A scanner-origin workspace must retain its batch controller when Run is clicked.
// Legacy scanner links are recognized by their saved baseline; Free Bots have none.
export function automaticScannerWatch() {
    const current = getScannerWatch();
    if (!current || current.automatic === false || !current.baselineCounts) return null;
    const workspace = (
        window as unknown as { Blockly?: { derivWorkspace?: { getAllBlocks: () => { data?: string }[] } } }
    ).Blockly?.derivWorkspace;
    const marker = `netoacademy:hosted-bot:${current.side}-punisher.xml`;
    return workspace?.getAllBlocks().some(block => block.data === marker) ? current : null;
}
