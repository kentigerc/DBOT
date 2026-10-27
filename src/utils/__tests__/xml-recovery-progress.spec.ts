import { startXmlRecoveryProgress } from '../xml-recovery-progress';
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it('journals the latest waiting state every 15 seconds instead of every market or tick', () => {
    let message = 'Searching recovery markets · R_10';
    const write = jest.fn();
    const progress = startXmlRecoveryProgress(
        () => message,
        write,
        () => true
    );
    expect(write).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    message = 'Searching recovery markets · R_50';
    progress.update();
    expect(write).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(14000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(expect.stringContaining('R_50 · 15s elapsed'));
    progress.stop();
});
it('announces an entry once without repeating the critical message every second', () => {
    let message = 'Searching recovery markets · R_10';
    const write = jest.fn();
    const progress = startXmlRecoveryProgress(
        () => message,
        write,
        () => true
    );
    message = 'Recovery entry ready · R_10';
    progress.update();
    expect(write).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(3000);
    expect(write).toHaveBeenCalledTimes(2);
    progress.stop();
});
it('stops publishing when recovery is no longer active and never rearms after STOP', () => {
    let active = true;
    const write = jest.fn();
    const progress = startXmlRecoveryProgress(
        () => 'Waiting for recovery entry · R_10',
        write,
        () => active
    );
    active = false;
    jest.advanceTimersByTime(30000);
    active = true;
    progress.update();
    jest.advanceTimersByTime(30000);
    expect(write).toHaveBeenCalledTimes(1);
});
it('logging errors do not interrupt recovery protection', () => {
    const progress = startXmlRecoveryProgress(
        () => 'Preparing recovery.',
        () => {
            throw new Error('Journal unavailable');
        },
        () => true
    );
    expect(() => jest.advanceTimersByTime(15000)).not.toThrow();
    progress.stop();
});
