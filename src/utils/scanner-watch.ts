export type ScannerWatch = {
    symbol: string;
    side: 'over' | 'under';
    sampleSize: number;
    name: string;
};
let watch: ScannerWatch | null = null;
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
    listeners.forEach(listener => listener());
}
