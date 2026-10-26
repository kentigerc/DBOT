import { BotRunLifecycle } from '../bot-run-lifecycle';
import { stopTickSubscriptions } from '../stop-tick-subscriptions';
const setup = () => {
    const connection = Object.assign(new EventTarget(), { readyState: 1 });
    const api = { connection, forgetAll: jest.fn().mockResolvedValue({}) };
    return { api, connection };
};
it('does not send forget requests on a closed or closing connection', async () => {
    const { api, connection } = setup();
    for (const state of [2, 3]) {
        connection.readyState = state;
        await stopTickSubscriptions(api);
    }
    expect(api.forgetAll).not.toHaveBeenCalled();
});
it('releases cleanup when the socket closes during an unanswered forget request', async () => {
    const { api, connection } = setup();
    api.forgetAll.mockReturnValue(new Promise(() => {}));
    const stopping = stopTickSubscriptions(api);
    expect(api.forgetAll).toHaveBeenCalledWith('ticks');
    connection.readyState = 3;
    connection.dispatchEvent(new Event('close'));
    await expect(stopping).resolves.toBeUndefined();
    expect(api.forgetAll).toHaveBeenCalledTimes(1);
});
it('waits for acknowledgements while the connection is healthy', async () => {
    const { api } = setup();
    let acknowledge!: () => void;
    api.forgetAll.mockImplementationOnce(
        () =>
            new Promise<void>(resolve => {
                acknowledge = resolve;
            })
    );
    let finished = false;
    const stopping = stopTickSubscriptions(api).then(() => {
        finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    acknowledge();
    await stopping;
    expect(api.forgetAll.mock.calls).toEqual([['ticks'], ['candles']]);
});
it('does not issue candle cleanup after the original socket closes, even if its old acknowledgement arrives later', async () => {
    const { api, connection } = setup();
    let acknowledge!: () => void;
    api.forgetAll.mockImplementationOnce(
        () =>
            new Promise<void>(resolve => {
                acknowledge = resolve;
            })
    );
    const stopping = stopTickSubscriptions(api);
    connection.readyState = 3;
    connection.dispatchEvent(new Event('close'));
    await stopping;
    acknowledge();
    await Promise.resolve();
    expect(api.forgetAll).toHaveBeenCalledTimes(1);
});
it('reports unsubscribe errors from a healthy connection', async () => {
    const { api } = setup();
    api.forgetAll.mockRejectedValue(new Error('Provider rejected unsubscribe'));
    await expect(stopTickSubscriptions(api)).rejects.toThrow('Provider rejected unsubscribe');
});

it('unblocks the next-run lifecycle guard after disconnecting an unacknowledged cleanup request', async () => {
    const { api, connection } = setup();
    const lifecycle = new BotRunLifecycle();
    api.forgetAll.mockReturnValue(new Promise(() => {}));
    const stopping = lifecycle.stop(() => stopTickSubscriptions(api));
    expect(lifecycle.stopping).toBe(true);
    connection.readyState = 3;
    connection.dispatchEvent(new Event('close'));
    await lifecycle.waitUntilStopped();
    await stopping;
    expect(lifecycle.stopping).toBe(false);
});
