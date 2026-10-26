type TickApi = {
    connection: EventTarget & { readyState: number };
    forgetAll: (type: string) => Promise<unknown>;
};
// Closing a socket removes its subscriptions at the provider. Do not wait for
// forget acknowledgements that can no longer arrive, or touch a replacement API.
export function stopTickSubscriptions(api?: TickApi): Promise<void> {
    if (!api || api.connection.readyState >= 2) return Promise.resolve();
    const connection = api.connection;
    return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (error?: unknown) => {
            if (finished) return;
            finished = true;
            connection.removeEventListener('close', closed);
            if (error) reject(error);
            else resolve();
        };
        const closed = () => finish();
        connection.addEventListener('close', closed);
        if (connection.readyState >= 2) {
            finish();
            return;
        }
        void (async () => {
            try {
                for (const type of ['ticks', 'candles']) {
                    if (finished || connection.readyState >= 2) {
                        finish();
                        return;
                    }
                    await api.forgetAll(type);
                }
                finish();
            } catch (error) {
                finish(connection.readyState >= 2 ? undefined : error);
            }
        })();
    });
}
