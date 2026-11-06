export type OverUnderDirection = 'DIGITOVER' | 'DIGITUNDER';
export type EntryReading = { percentage: number; change: number; armed: boolean; run: number; epoch: number };
const key = (direction: OverUnderDirection, barrier: number) => `${direction}:${barrier}`;
// Stateful, live-only formation tracking, shared by server strategies and the browser XML scanner.
export class OverUnderEntries {
    readings: Record<string, EntryReading> = {};
    private previous?: number[];
    private size = 0;
    private epoch = 0;
    observe(digits: number[], epoch: number, live = true) {
        if (!Number.isFinite(epoch) || epoch <= 0 || epoch <= this.epoch) return;
        const counts = Array<number>(10).fill(0);
        for (const digit of digits) if (Number.isInteger(digit) && digit >= 0 && digit <= 9) counts[digit]++;
        const size = counts.reduce((sum, count) => sum + count, 0);
        const continuous = !!this.previous && size === this.size && epoch - this.epoch <= 6 && live;
        const latest = digits[digits.length - 1];
        for (const direction of ['DIGITOVER', 'DIGITUNDER'] as const)
            for (let barrier = 0; barrier <= 9; barrier++) {
                const accepts = (digit: number) => (direction === 'DIGITOVER' ? digit > barrier : digit < barrier);
                const count = counts.reduce((sum, n, digit) => sum + (accepts(digit) ? n : 0), 0);
                const previous = this.previous?.reduce((sum, n, digit) => sum + (accepts(digit) ? n : 0), 0) || 0;
                const percentage = size ? (count * 100) / size : 0;
                const change = continuous && size ? ((count - previous) * 100) / size : 0;
                const old = this.readings[key(direction, barrier)];
                let armed = !!old?.armed,
                    run = old?.run || 0;
                if (!continuous || percentage < 70 || change < 0) {
                    armed = false;
                    run = 0;
                } else if (!armed && change > 0) {
                    armed = true;
                    run = 0;
                } else if (armed) run = latest !== undefined && accepts(latest) ? Math.min(2, run + 1) : 0;
                this.readings[key(direction, barrier)] = { percentage, change, armed, run, epoch };
            }
        this.previous = counts;
        this.size = size;
        this.epoch = epoch;
    }
    ready(direction: OverUnderDirection, barrier: number) {
        const reading = this.readings[key(direction, barrier)];
        return !!reading && reading.percentage >= 70 && reading.change > 0 && reading.armed && reading.run >= 2;
    }
    reset() {
        for (const reading of Object.values(this.readings)) {
            reading.armed = false;
            reading.run = 0;
        }
    }
}
