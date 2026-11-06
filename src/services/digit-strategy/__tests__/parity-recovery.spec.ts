import { DigitMarket } from '../strategy';
import { ParityRecoveryEntries, parityRecoveryReady } from '../parity-recovery';

it.each([false, true])('uses identical server and browser recovery readings (Odd=%s)', odd => {
    const m = new DigitMarket('1HZ10V', 2, 'Volatility 10 (1s) Index');
    const entries = new ParityRecoveryEntries();
    const seed = [...Array<number>(480).fill(1), ...Array<number>(520).fill(2)].map(d => (odd ? 9 - d : d));
    seed.forEach((digit, i) => m.add(100 + digit / 100, i + 1));
    entries.observe(seed, 1000, false);
    const direction = odd ? 'DIGITODD' : 'DIGITEVEN';
    const pattern = [2, 4, 6, 2, 4, 6, 1, 2, 4, 6].map(d => (odd ? 9 - d : d));
    pattern.forEach((digit, i) => {
        const epoch = 1001 + i;
        m.add(100 + digit / 100, epoch, epoch * 1000);
        entries.observe(m.digits, epoch, m.ready(epoch * 1000));
        if (m.ready(epoch * 1000)) expect(entries.readings[direction]).toEqual(m.parityMomentum[direction]);
        else expect(parityRecoveryReady(entries.readings[direction])).toBe(false);
        if (i === 3) expect(parityRecoveryReady(entries.readings[direction])).toBe(false);
        if (i === 4) expect(parityRecoveryReady(entries.readings[direction])).toBe(true);
        if (i === 6) expect(parityRecoveryReady(entries.readings[direction])).toBe(false);
    });
    entries.reset();
    expect(parityRecoveryReady(entries.readings[direction])).toBe(false);
    entries.observe(m.digits, 1030);
    expect(entries.readings[direction].armed).toBe(false);
});
