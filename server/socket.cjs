const { watchSessionExpiry } = require('./session-expiry.cjs');
const { randomUUID } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { WebSocket } = require('undici');

function attachSockets(
    server,
    auth,
    dispatcher,
    {
        analysis,
        onTrade = () => {},
        onConnection = () => {},
        createUpstream = url => new WebSocket(url, { ...(dispatcher ? { dispatcher } : {}) }),
    } = {}
) {
    // A background Builder socket also subscribes to every account contract.
    // Only receipts from purchases on Builder sockets establish Builder ownership.
    // Share this bounded set across sockets so reconnects can report known settlements.
    const builderContracts = new Set();
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    server.on('upgrade', async (req, socket, head) => {
        const reject = (status = 403) => {
            if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
        };
        if (req.headers.origin !== auth.publicOrigin) return reject();
        let upstream;
        try {
            const url = new URL(req.url, auth.publicOrigin);
            if (url.pathname !== '/api/socket') return reject(404);
            const account = url.searchParams.get('account_id');
            const expires = account ? auth.sessionExpires(req) : null;
            const target = account
                ? await auth.connectionUrl(req, account)
                : 'wss://api.derivws.com/trading/v1/options/ws/public';
            if (socket.destroyed) return;
            upstream = createUpstream(target);
            const timeout = setTimeout(() => {
                reject(504);
                upstream.close();
            }, 15000);
            socket.once('close', () => {
                clearTimeout(timeout);
                upstream.close();
            });
            upstream.addEventListener(
                'error',
                () => {
                    clearTimeout(timeout);
                    reject(502);
                },
                { once: true }
            );
            upstream.addEventListener(
                'open',
                () => {
                    clearTimeout(timeout);
                    if (socket.destroyed) {
                        upstream.close();
                        return;
                    }
                    if (expires && expires <= Date.now()) {
                        reject(401);
                        upstream.close();
                        return;
                    }
                    sockets.handleUpgrade(req, socket, head, client => {
                        const clientKey = randomUUID();
                        if (account) {
                            try {
                                onConnection(account, clientKey, true);
                            } catch {}
                        }
                        const stopExpiry = account
                            ? watchSessionExpiry(
                                  () => auth.sessionExpires(req),
                                  () => client.close(1008, 'Session expired. Log in again.')
                              )
                            : () => {};
                        const heartbeat = setInterval(() => {
                            if (!client.isAlive) return client.terminate();
                            client.isAlive = false;
                            client.ping();
                        }, 30000);
                        client.isAlive = true;
                        client.on('pong', () => {
                            client.isAlive = true;
                        });
                        client.on('message', (data, binary) => {
                            if (binary || upstream.readyState !== 1) {
                                client.close(1003, 'Text API messages required.');
                                return;
                            }
                            if (upstream.bufferedAmount > 1024 * 1024) {
                                client.close(1013, 'Connection is busy.');
                                return;
                            }
                            let body;
                            try {
                                body = JSON.parse(data.toString());
                                if (account) analysis?.beforeBuilder(account, body, clientKey);
                            } catch (error) {
                                client.send(
                                    JSON.stringify({
                                        error: { code: 'AnalysisToolRunning', message: error.message },
                                        req_id: body?.req_id,
                                        echo_req: body,
                                    })
                                );
                                return;
                            }
                            upstream.send(data.toString());
                        });
                        upstream.addEventListener('message', event => {
                            if (client.readyState === 1) {
                                if (client.bufferedAmount > 1024 * 1024) {
                                    client.close(1013, 'Connection is busy.');
                                    return;
                                }
                                try {
                                    if (account) {
                                        const packet = JSON.parse(event.data);
                                        analysis?.builderResponse(account, packet, clientKey);
                                        if (packet.buy?.contract_id) {
                                            builderContracts.add(`${account}:${packet.buy.contract_id}`);
                                            if (builderContracts.size > 20000)
                                                builderContracts.delete(builderContracts.values().next().value);
                                            onTrade(account, packet.buy);
                                        }
                                        const contract = packet.proposal_open_contract;
                                        if (
                                            [true, 1].includes(contract?.is_sold) &&
                                            builderContracts.has(`${account}:${contract.contract_id}`)
                                        )
                                            onTrade(account, contract);
                                    }
                                } catch {
                                    /* invalid upstream packet */
                                }
                                client.send(event.data);
                            }
                        });
                        upstream.addEventListener('close', () => client.close(1000, 'Deriv connection closed.'));
                        upstream.addEventListener('error', () => client.close(1011, 'Deriv connection failed.'));
                        client.on('close', () => {
                            if (account) {
                                try {
                                    onConnection(account, clientKey, false);
                                } catch {}
                            }
                            clearInterval(heartbeat);
                            stopExpiry();
                            upstream.close();
                        });
                        client.on('error', () => {
                            if (account) {
                                try {
                                    onConnection(account, clientKey, false);
                                } catch {}
                            }
                            clearInterval(heartbeat);
                            stopExpiry();
                            upstream.close();
                        });
                    });
                },
                { once: true }
            );
        } catch (error) {
            upstream?.close();
            reject(error.status || 502);
        }
    });
    return sockets;
}
module.exports = { attachSockets };
