type KeepaliveApi = {
    connection: EventTarget & { readyState: number };
    ping: (request: { ping: number }) => Promise<unknown>;
};
// A standard API request traverses browser -> site -> Deriv -> site -> browser.
// Let DerivAPIBasic allocate request IDs and match replies; never send trading requests.
export function startApiKeepalive(api: KeepaliveApi) {
    let stopped = false;
    let pending = false;
    const stop = () => {
        stopped = true;
        clearInterval(timer);
        api.connection.removeEventListener('close', stop);
    };
    const timer = setInterval(() => {
        if (stopped || pending || api.connection.readyState !== 1) return;
        pending = true;
        void (async () => {
            try {
                await api.ping({ ping: 1 });
            } catch {
                // Socket reconnect/stop handlers own failures; never restart a bot here.
            } finally {
                pending = false;
            }
        })();
    }, 25000);
    api.connection.addEventListener('close', stop, { once: true });
    if (api.connection.readyState >= 2) stop();
    return stop;
}
