import { scanDigits, type ScanSide } from '@/pages/digit-analysis/scanner';

export function risingScannerDigits(baseline: number[], current: number[], side: ScanSide, sampleSize: number) {
    if (baseline.length !== 10 || current.length !== 10 || ![100, 500, 1000].includes(sampleSize)) return [];
    return scanDigits(side).filter(
        digit =>
            Number.isFinite(baseline[digit]) &&
            Number.isFinite(current[digit]) &&
            (current[digit] - baseline[digit]) * 100 >= sampleSize
    );
}

type Phase = 'idle' | 'monitoring' | 'settling' | 'recovering' | 'stopped';
type Snapshot = { triggered: boolean; phase: Phase; losses: number };
export class ScannerExitGuard {
    private active = false;
    private pending = false;
    private contractId?: number;
    private settled = new Set<number>();
    private stop?: () => void;
    private generation = 0;
    private stopQueued = false;
    private uncertain = false;
    private snapshot: Snapshot = { triggered: false, phase: 'idle', losses: 0 };
    private listeners = new Set<() => void>();
    getSnapshot = () => this.snapshot;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    private update(value: Partial<Snapshot>) {
        this.snapshot = { ...this.snapshot, ...value };
        this.listeners.forEach(listener => listener());
    }
    begin(stop: () => void) {
        this.generation++;
        this.active = true;
        this.pending = false;
        this.contractId = undefined;
        this.settled.clear();
        this.stopQueued = false;
        this.uncertain = false;
        this.stop = stop;
        this.update({ triggered: false, phase: 'monitoring', losses: 0 });
    }
    cancel() {
        this.active = false;
        this.update({ phase: 'stopped' });
    }
    trigger() {
        if (!this.active || this.snapshot.triggered) return;
        this.update({ triggered: true });
        this.decide();
    }
    private decide() {
        if (!this.snapshot.triggered || !this.active) return;
        if (this.uncertain || this.snapshot.losses >= 4 || (!this.pending && this.snapshot.losses === 0)) {
            this.finish();
        } else this.update({ phase: this.pending ? 'settling' : 'recovering' });
    }
    private finish() {
        this.update({ phase: 'stopped' });
        if (!this.stopQueued) {
            this.stopQueued = true;
            const generation = this.generation;
            queueMicrotask(() => {
                if (generation === this.generation && this.active) this.stop?.();
            });
        }
    }
    purchase() {
        if (this.snapshot.triggered && (!this.active || this.snapshot.phase === 'stopped' || this.pending))
            return false;
        if (this.active) this.pending = true;
        return true;
    }
    purchased(id: number) {
        if (!this.active || !Number.isSafeInteger(id)) return;
        this.contractId = id;
        this.pending = true;
    }
    purchaseFailed() {
        if (!this.active) return;
        this.pending = false;
        this.contractId = undefined;
        this.decide();
    }
    contract(value: { contract_id?: number; is_sold?: number | boolean; profit?: number | string }) {
        const id = value.contract_id;
        if (
            !this.active ||
            id !== this.contractId ||
            !(value.is_sold === true || value.is_sold === 1) ||
            id === undefined ||
            this.settled.has(id)
        )
            return;
        if (
            value.profit === undefined ||
            value.profit === null ||
            value.profit === '' ||
            !Number.isFinite(Number(value.profit))
        ) {
            // Unknown settlement cannot safely establish a recovery-loss budget.
            this.uncertain = true;
            this.pending = false;
            if (this.snapshot.triggered) this.finish();
            return;
        }
        this.settled.add(id);
        this.pending = false;
        this.contractId = undefined;
        const profit = Number(value.profit);
        if (profit > 0) this.uncertain = false;
        this.update({ losses: profit < 0 ? this.snapshot.losses + 1 : profit > 0 ? 0 : this.snapshot.losses });
        this.decide();
    }
}
export const scannerExitGuard = new ScannerExitGuard();
