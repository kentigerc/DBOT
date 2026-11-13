// Compare provider epochs with provider time, independently of the device's date/time setting.
// A bounded monotonic anchor also expires after sleep or failed synchronization.
export class MarketClock {
    private anchor = NaN;
    private received = NaN;

    now = () => {
        const elapsed = performance.now() - this.received;
        return elapsed >= 0 && elapsed <= 90000 ? this.anchor + elapsed : NaN;
    };

    synchronize(time: unknown, sent: number, received: number) {
        const elapsed = received - sent;
        if (!Number.isInteger(time) || Number(time) <= 0 || elapsed < 0 || elapsed > 2000)
            throw new Error('Deriv clock synchronization is unavailable.');
        this.anchor = Number(time) * 1000 + elapsed / 2;
        this.received = received;
    }
}
