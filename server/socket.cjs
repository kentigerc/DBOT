const { validateSocketMessage } = require('./security.cjs');
const { startUpstreamKeepalive } = require('./upstream-keepalive.cjs');
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
        security,
        onTrade = () => {},
        onConnection = () => {},
        onProviderFailure = () => {},
        createUpstream = url => new WebSocket(url, { ...(dispatcher ? { dispatcher } : {}) }),
    } = {}
) {
    // A background Builder socket also subscribes to every account contract.
    // Only receipts from purchases on Builder sockets establish Builder ownership.
    // Share this bounded set across sockets so reconnects can report known settlements.
    const builderContracts = new Set();
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    server.on('upgrade', async (req, socket, head) => {
        const reject = (status = 403) => {
            if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
        };
        if (req.headers.origin !== auth.publicOrigin) return reject();
        let upstream;
        const release = security?.reserveSocket(req);
        if (security && !release) return reject(429);
        socket.once('close', () => release?.());
        const handshakeTimeout = setTimeout(() => {
            reject(504);
            upstream?.close();
        }, 15000);
        handshakeTimeout.unref?.();
        socket.once('close', () => clearTimeout(handshakeTimeout));
        try {
            const url = new URL(req.url, auth.publicOrigin);
            if (url.pathname !== '/api/socket') return reject(404);
            if (url.searchParams.getAll('account_id').length > 1) return reject(400);
            const account = url.searchParams.get('account_id');
            if (account && !/^[A-Za-z0-9_-]{1,128}$/.test(account)) return reject(400);
            const expires = account ? auth.sessionExpires(req) : null;
            const target = account
                ? await auth.connectionUrl(req, account)
                : 'wss://api.derivws.com/trading/v1/options/ws/public';
            if (socket.destroyed || socket.writableEnded) return;
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
                    clearTimeout(handshakeTimeout);
                    if (socket.destroyed || socket.writableEnded) {
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
                        const upstreamKeepalive = startUpstreamKeepalive(upstream);
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
                        const heartbeat = setInterval(async () => {
                            if (account) {
                                try {
                                    await auth.verifySession?.(req);
                                } catch {
                                    client.close(1008, 'Session is no longer available. Log in again.');
                                    return;
                                }
                            }
                            if (client.readyState !== 1) return;
                            if (!client.isAlive) return client.terminate();
                            client.isAlive = false;
                            client.ping();
                        }, 30000);
                        const allowMessage = security?.messageLimiter() || (() => true);
                        client.isAlive = true;
                        client.on('pong', () => {
                            client.isAlive = true;
                        });
                        client.on('message', async (data, binary) => {
                            if (!allowMessage()) {
                                security?.log('socket_message_limit', req);
                                client.close(1008, 'Message rate limit exceeded.');
                                return;
                            }
                            if (binary || upstream.readyState !== 1) {
                                client.close(1003, 'Text API messages required.');
                                return;
                            }
                            if (upstream.bufferedAmount > 1024 * 1024) {
                                client.close(1013, 'Connection is busy.');
                                return;
                            }
                            let body,
                                outgoing,
                                attempted = false;
                            try {
                                body = JSON.parse(data.toString());
                                validateSocketMessage(body, account);
                                if (account) await auth.verifySession?.(req);
                                if (account && body.buy) auth.requireTerms?.(req);
                                if (account && body.buy && analysis?.authorizeBuilderBuy)
                                    outgoing = await analysis.authorizeBuilderBuy(account, body, clientKey);
                                else if (account && body.buy) await analysis?.prepareBuilder?.(account);
                                // Shared-lock/journal work may outlive a logout or session expiry.
                                // Cancel the unsent permit through the existing error path if authorization changed.
                                if (account && body.buy) await auth.verifySession?.(req);
                                if (client.readyState !== 1 || upstream.readyState !== 1) {
                                    if (outgoing) await analysis.cancelBuilderBuy(account, body, clientKey);
                                    return;
                                }
                                if (account && !outgoing) analysis?.beforeBuilder(account, body, clientKey);
                                attempted = true;
                                upstream.send(outgoing ? JSON.stringify(outgoing) : data.toString());
                            } catch (error) {
                                if (outgoing && !attempted)
                                    await analysis.cancelBuilderBuy(account, body, clientKey).catch(() => {});
                                if (client.readyState !== 1) return;
                                client.send(
                                    JSON.stringify({
                                        error: {
                                            code: error.code || 'InvalidRequest',
                                            message:
                                                error instanceof SyntaxError
                                                    ? 'A valid JSON API object is required.'
                                                    : error.message,
                                        },
                                        req_id: body?.req_id,
                                        echo_req: body,
                                    })
                                );
                                return;
                            }
                        });
                        let incoming = Promise.resolve();
                        let queuedIncoming = 0;
                        upstream.addEventListener('message', event => {
                            if (queuedIncoming >= 256) {
                                client.close(1013, 'Trading messages are delayed. Check Reports before continuing.');
                                upstream.close();
                                return;
                            }
                            queuedIncoming++;
                            incoming = incoming
                                .then(async () => {
                                    try {
                                        if (upstreamKeepalive.consume(JSON.parse(event.data))) return;
                                    } catch {
                                        /* Preserve existing invalid-packet forwarding behavior. */
                                    }
                                    if (client.readyState === 1 || account) {
                                        try {
                                            if (account) {
                                                const packet = JSON.parse(event.data);
                                                if (analysis?.observeBuilder)
                                                    await analysis.observeBuilder(account, packet, clientKey);
                                                else analysis?.builderResponse?.(account, packet, clientKey);
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
                                            client.close(
                                                1011,
                                                'Unable to record the trading outcome. Check Reports before continuing.'
                                            );
                                            return;
                                        }
                                        if (client.readyState === 1) {
                                            if (client.bufferedAmount > 1024 * 1024)
                                                client.close(1013, 'Connection is busy.');
                                            else client.send(event.data);
                                        }
                                    }
                                })
                                .catch(() =>
                                    client.close(1011, 'Trading protection failed. Check Reports before continuing.')
                                )
                                .finally(() => {
                                    queuedIncoming--;
                                });
                        });
                        upstream.addEventListener('close', event => {
                            const code = Number(event.code);
                            if (code !== 1000 && code !== 1001) onProviderFailure();
                            const validCode =
                                Number.isInteger(code) &&
                                ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
                                    (code >= 3000 && code <= 4999));
                            // Preserve provider diagnostics without forwarding URLs or tokens.
                            client.close(
                                validCode ? code : 1011,
                                `Deriv connection closed (upstream ${Number.isInteger(code) ? code : 'unknown'}).`
                            );
                        });
                        upstream.addEventListener('error', () => client.close(1011, 'Deriv connection failed.'));
                        client.on('close', () => {
                            if (account) {
                                try {
                                    onConnection(account, clientKey, false);
                                } catch {}
                            }
                            clearInterval(heartbeat);
                            upstreamKeepalive.stop();
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
                            upstreamKeepalive.stop();
                            stopExpiry();
                            upstream.close();
                        });
                    });
                },
                { once: true }
            );
        } catch (error) {
            clearTimeout(handshakeTimeout);
            upstream?.close();
            reject(error.status || 502);
        }
    });
    return sockets;
}
module.exports = { attachSockets };
