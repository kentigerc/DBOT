const { WebSocket } = require('undici');
const { toNewApiRequest, fromNewApiResponse } = require('../.server-build/transport');
async function createBroker(
    url,
    dispatcher,
    createSocket = target => new WebSocket(target, { ...(dispatcher ? { dispatcher } : {}) })
) {
    const socket = createSocket(url);
    const listeners = new Set();
    const pending = new Map();
    const streams = new Map();
    const connection = new EventTarget();
    let sequence = 0;
    let ping, failed = false;
    const fail = (reason = 'trading_connection_lost') => {
        if (failed) return;
        failed = true;
        clearInterval(ping);
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error('Deriv connection closed.'));
        }
        pending.clear();
        connection.dispatchEvent(Object.assign(new Event('close'), { reason }));
    };
    socket.addEventListener('close', () => fail());
    socket.addEventListener('error', () => fail());
    socket.addEventListener('message', event => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch {
            return;
        }
        const request = pending.get(data.req_id);
        const original = request?.body || streams.get(data.subscription?.id);
        if (original && data.subscription?.id) streams.set(data.subscription.id, original);
        const packet = fromNewApiResponse(data, original);
        if (request) clearTimeout(request.timer);
        pending.delete(data.req_id);
        if (request) data.error ? request.reject({ error: data.error }) : request.resolve(packet);
        if (!data.error) for (const listener of listeners) listener({ data: packet });
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error('Deriv connection timed out.'));
        }, 15000);
        socket.addEventListener(
            'open',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true }
        );
        socket.addEventListener(
            'error',
            () => {
                clearTimeout(timer);
                reject(new Error('Unable to open Deriv connection.'));
            },
            { once: true }
        );
    });
    const broker = {
        connection,
        onMessage: () => ({
            subscribe: fn => {
                listeners.add(fn);
                return { unsubscribe: () => listeners.delete(fn) };
            },
        }),
        send(body) {
            if (failed || socket.readyState !== 1) return Promise.reject(new Error('Deriv connection is closed.'));
            const req_id = ++sequence;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(req_id);
                    reject(new Error('Deriv request timed out.'));
                }, 15000);
                timer.unref?.();
                pending.set(req_id, { body, resolve, reject, timer });
                try {
                    socket.send(JSON.stringify({ ...toNewApiRequest(body), req_id }));
                } catch (error) {
                    clearTimeout(timer);
                    pending.delete(req_id);
                    reject(error);
                }
            });
        },
        disconnect() {
            clearInterval(ping);
            socket.close();
        },
    };
    ping = setInterval(() => {
        void broker.send({ ping: 1 }).then(packet => {
            if (packet.ping !== 'pong') throw new Error('Deriv heartbeat response mismatch.');
        }).catch(() => {
            if (failed || socket.readyState !== 1) return;
            fail('trading_pong_timeout');
            socket.close();
        });
    }, 30000);
    ping.unref?.();
    return broker;
}
module.exports = { createBroker };
