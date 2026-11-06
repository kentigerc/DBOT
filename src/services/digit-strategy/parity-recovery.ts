export type ParityDirection = 'DIGITEVEN' | 'DIGITODD';
export type ParityReading = { percentage: number; change: number; run: number; armed: boolean; epoch: number };
export function advanceParityRecovery(
    old: ParityReading,
    direction: ParityDirection,
    digit: number,
    percentage: number,
    change: number,
    epoch: number,
    live: boolean
): ParityReading {
    let armed = old.armed;
    let run = old.run;
    if (!live || percentage < 52 || change < 0) {
        armed = false;
        run = 0;
    } else {
        if (!armed && change > 0) armed = true;
        run = armed && digit % 2 === (direction === 'DIGITEVEN' ? 0 : 1) ? Math.min(3, run + 1) : 0;
    }
    return { percentage, change, armed, run, epoch };
}
export const parityRecoveryReady = (reading: ParityReading) =>
    reading.armed && reading.percentage >= 52 && reading.change > 0 && reading.run >= 3;

// Browser snapshot adapter for the same calculation used by the server's tick feeds.
export class ParityRecoveryEntries {
    readings: Record<ParityDirection, ParityReading> = {
        DIGITEVEN: { percentage: 0, change: 0, run: 0, armed: false, epoch: 0 },
        DIGITODD: { percentage: 0, change: 0, run: 0, armed: false, epoch: 0 },
    };
    private even = 0;
    private size = 0;
    private epoch = 0;
    observe(digits: number[], epoch: number, live = true) {
        if (!Number.isFinite(epoch) || epoch <= this.epoch) return;
        const size = digits.length;
        const even = digits.reduce((n, d) => n + (d % 2 === 0 ? 1 : 0), 0);
        const continuous = live && size > 0 && size === this.size && epoch - this.epoch <= 6;
        for (const direction of ['DIGITEVEN', 'DIGITODD'] as const) {
            const count = direction === 'DIGITEVEN' ? even : size - even;
            const previous = direction === 'DIGITEVEN' ? this.even : this.size - this.even;
            this.readings[direction] = advanceParityRecovery(
                this.readings[direction],
                direction,
                digits[size - 1],
                size ? (count * 100) / size : 0,
                continuous ? ((count - previous) * 100) / size : 0,
                epoch,
                continuous
            );
        }
        this.even = even;
        this.size = size;
        this.epoch = epoch;
    }
    reset() {
        for (const reading of Object.values(this.readings)) {
            reading.armed = false;
            reading.run = 0;
        }
    }
}
