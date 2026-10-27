import { startApiKeepalive } from '../api-keepalive';
const setup = () => ({
    connection: Object.assign(new EventTarget(), { readyState: 1 }),
    ping: jest.fn().mockResolvedValue({ ping: 'pong' }),
});
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it('sends standard API pings every 25 seconds without issuing any trade', async () => {
    const api = setup();
    const stop = startApiKeepalive(api);
    await jest.advanceTimersByTimeAsync(25000);
    expect(api.ping).toHaveBeenCalledWith({ ping: 1 });
    await jest.advanceTimersByTimeAsync(25000);
    expect(api.ping).toHaveBeenCalledTimes(2);
    stop();
});
it('waits for the connection to open and stops after socket closure', async () => {
    const api = setup();
    api.connection.readyState = 0;
    startApiKeepalive(api);
    await jest.advanceTimersByTimeAsync(25000);
    expect(api.ping).not.toHaveBeenCalled();
    api.connection.readyState = 1;
    await jest.advanceTimersByTimeAsync(25000);
    expect(api.ping).toHaveBeenCalledTimes(1);
    api.connection.readyState = 3;
    api.connection.dispatchEvent(new Event('close'));
    await jest.advanceTimersByTimeAsync(50000);
    expect(api.ping).toHaveBeenCalledTimes(1);
});
it('does not accumulate requests while a ping is unanswered', async () => {
    const api = setup();
    api.ping.mockReturnValue(new Promise(() => {}));
    const stop = startApiKeepalive(api);
    await jest.advanceTimersByTimeAsync(100000);
    expect(api.ping).toHaveBeenCalledTimes(1);
    stop();
});
it('handles a rejected ping without restarting trading and can send the next heartbeat', async () => {
    const api = setup();
    api.ping.mockRejectedValueOnce(new Error('Connection failed'));
    const stop = startApiKeepalive(api);
    await jest.advanceTimersByTimeAsync(50000);
    expect(api.ping).toHaveBeenCalledTimes(2);
    stop();
});
