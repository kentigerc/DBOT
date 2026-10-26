import { BotRunLifecycle } from '../bot-run-lifecycle';
afterEach(() => jest.useRealTimers());
it('keeps a new run waiting until the old interpreter and tick cleanup are both finished', async () => {
    const lifecycle = new BotRunLifecycle();
    let finishStop!: () => void, finishTicks!: () => void;
    const interpreter = new Promise<void>(resolve => {
        finishStop = resolve;
    });
    const ticks = new Promise<void>(resolve => {
        finishTicks = resolve;
    });
    const stop = lifecycle.stop(async () => {
        await interpreter;
        await ticks;
    });
    expect(lifecycle.stopping).toBe(true);
    let ready = false;
    const waiting = lifecycle.waitUntilStopped().then(() => {
        ready = true;
    });
    finishStop();
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(lifecycle.stopping).toBe(true);
    finishTicks();
    await stop;
    await waiting;
    expect(ready).toBe(true);
    expect(lifecycle.stopping).toBe(false);
});
it('deduplicates overlapping stop calls instead of replacing an interpreter twice', async () => {
    const lifecycle = new BotRunLifecycle();
    let release!: () => void;
    const operation = jest.fn(
        () =>
            new Promise<void>(resolve => {
                release = resolve;
            })
    );
    const first = lifecycle.stop(operation),
        second = lifecycle.stop(operation);
    expect(first).toBe(second);
    expect(operation).toHaveBeenCalledTimes(1);
    release();
    await first;
});
it('a cleanup timeout refuses a new run without clearing the still-active stop guard', async () => {
    jest.useFakeTimers();
    const lifecycle = new BotRunLifecycle();
    let release!: () => void;
    const stop = lifecycle.stop(
        () =>
            new Promise<void>(resolve => {
                release = resolve;
            })
    );
    const refusal = expect(lifecycle.waitUntilStopped(100)).rejects.toThrow('previous XML run is still stopping');
    await jest.advanceTimersByTimeAsync(100);
    await refusal;
    expect(lifecycle.stopping).toBe(true);
    release();
    await stop;
    expect(lifecycle.stopping).toBe(false);
});
it('reports cleanup errors and releases its state even when the operation throws immediately', async () => {
    const lifecycle = new BotRunLifecycle();
    await expect(
        lifecycle.stop(() => {
            throw new Error('Cleanup failed');
        })
    ).rejects.toThrow('Cleanup failed');
    expect(lifecycle.stopping).toBe(false);
    await expect(lifecycle.waitUntilStopped()).resolves.toBeUndefined();
});
