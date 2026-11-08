const { watchSessionExpiry } = require('./session-expiry.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DigitStrategyEngine, empty } = require('../.server-build/engine');
const { DEFAULT_SETTINGS, validateSettings, cents } = require('../.server-build/strategy');
const { createBroker } = require('./strategy-broker.cjs');
const { createTradingStateStorage } = require('./trading-state.cjs');
const { createAccountLocks, DEFINITIVE } = require('./account-locks.cjs');
const { randomUUID } = require('node:crypto');
const { createDemoPause } = require('./demo-pause.cjs');

function fileStorage(directory) {
    const filename = key => path.join(directory, createHash('sha256').update(key).digest('hex') + '.json');
    return {
        getItem(key) {
            try {
                return fs.readFileSync(filename(key), 'utf8');
            } catch (e) {
                if (e.code === 'ENOENT') return null;
                throw e;
            }
        },
        setItem(key, value) {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            const target = filename(key),
                temporary = target + '.tmp';
            const fd = fs.openSync(temporary, 'w', 0o600);
            try {
                fs.writeFileSync(fd, value);
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(temporary, target);
            const parent = fs.openSync(directory, 'r');
            try {
                fs.fsyncSync(parent);
            } finally {
                fs.closeSync(parent);
            }
        },
    };
}
function createAnalysisService(
    auth,
    {
        dispatcher,
        onTrade = () => {},
        storage = createTradingStateStorage({
            legacyStorage: fileStorage(
                process.env.NETO_ANALYSIS_STATE_DIR || path.join(__dirname, '../.analysis-state')
            ),
        }),
        brokerFactory = url => createBroker(url, dispatcher),
        Engine = DigitStrategyEngine,
        onOperationalEvent = () => {},
        locks = createAccountLocks({ onFailure: onOperationalEvent }),
    } = {}
) {
    const sessions = new Map();
    const builderBuys = new Map();
    const builderOrders = new Map();
    const epochs = new Map();
    let closing = false;
    const key = id => `neto.digit-strategy.v1.${id}`;
    const prepareAccount = async id => {
        await storage.load?.(key(id));
    };
    let demoPauses;
    const sessionBusy = id => {
        const session = sessions.get(id);
        if (!session) {
            const saved = storage.getItem(`neto.digit-strategy.v1.${id}`);
            if (saved) {
                const state = JSON.parse(saved);
                if (state.pending || (storage.mode === 'postgres' && state.liveUntil > Date.now())) return true;
            }
        }
        const state = session?.engine.getSnapshot();
        return !!(
            session?.starting ||
            state?.active ||
            state?.pending ||
            (storage.mode === 'postgres' && state?.liveUntil > Date.now())
        );
    };
    const busy = id => sessionBusy(id) || !!demoPauses?.busy(id);
    const settleLease = value => {
        if (
            !value.lease ||
            value.starting ||
            value.engine.getSnapshot().active ||
            demoPauses?.busy(value.account.account_id)
        )
            return;
        const lease = value.lease;
        lease.held = false;
        if (!value.engine.getSnapshot().pending)
            void (async () => {
                await storage.flush?.(key(value.account.account_id));
                if (
                    value.lease === lease &&
                    !value.starting &&
                    !value.engine.getSnapshot().active &&
                    !demoPauses?.busy(value.account.account_id)
                )
                    await locks.release(lease);
            })().catch(() => {});
    };
    demoPauses = createDemoPause({
        auth,
        storage,
        locks,
        brokerFactory,
        busy: async id => {
            await prepareAccount(id);
            return sessionBusy(id) || (builderBuys.get(id)?.size || 0) > 0;
        },
        onTrade: (account, sourceTool, packet) => onTrade(account, { sourceTool, settings: {} }, packet),
    });
    const entry = account => {
        let value = sessions.get(account.account_id);
        if (!value) {
            value = { account, starting: false, request: undefined };
            const epoch = randomUUID();
            epochs.set(account.account_id, epoch);
            const checkEpoch = () => {
                if (epochs.get(account.account_id) !== epoch) throw new Error('This trading run was replaced.');
            };
            const engineStorage = {
                ...storage,
                getItem: key => {
                    checkEpoch();
                    return storage.getItem(key);
                },
                setItem: (key, text) => {
                    checkEpoch();
                    storage.setItem(key, text);
                },
                flush: async key => {
                    checkEpoch();
                    await storage.flush?.(key);
                    checkEpoch();
                },
            };
            const brokerForRun = async () => {
                // The runner outlives the HTTP start command; keep its verified
                // request for later revocation checks after startup completes.
                const request = value.request;
                const lease = value.lease;
                const broker = await brokerFactory(await auth.connectionUrl(request, account.account_id));
                broker.connection?.addEventListener(
                    'close',
                    () => {
                        if (value.engine.getSnapshot().active && value.engine.getSnapshot().wantsRun)
                            onOperationalEvent('trading_connection_lost');
                    },
                    { once: true }
                );
                const send = broker.send.bind(broker);
                broker.send = async body => {
                    const pending = value.engine.getSnapshot().pending;
                    if (body.buy) {
                        await auth.verifySession?.(request);
                        try {
                            await locks.protect(lease, body.passthrough.neto_order_id);
                        } catch (error) {
                            if (error.status === 409) throw { code: 'NetoPurchaseCancelled' };
                            throw error;
                        }
                        if (value.cancelled || !value.engine.getSnapshot().wantsRun) {
                            await locks.cancel(lease, body.passthrough.neto_order_id);
                            throw { code: 'NetoPurchaseCancelled' };
                        }
                    }
                    try {
                        const result = await send(body);
                        if (body.buy && result.buy?.contract_id)
                            await locks.acknowledge(lease, body.passthrough.neto_order_id, result.buy.contract_id);
                        if (body.proposal_open_contract && pending && result.proposal_open_contract) {
                            value.engine.validateContract(result.proposal_open_contract, pending, body.contract_id);
                            await locks.acknowledge(lease, pending.nonce, body.contract_id, true);
                            if ([1, true].includes(result.proposal_open_contract.is_sold))
                                await locks.settled(account.account_id, body.contract_id);
                        }
                        return result;
                    } catch (error) {
                        const code = error.error?.code || error.code;
                        if (body.buy && DEFINITIVE.has(code)) await locks.cancel(lease, body.passthrough.neto_order_id);
                        throw error;
                    }
                };
                const reporting = broker.onMessage?.().subscribe(({ data }) => {
                    const packet = data.buy?.contract_id
                        ? data.buy
                        : [true, 1].includes(data.proposal_open_contract?.is_sold)
                          ? data.proposal_open_contract
                          : undefined;
                    if (packet) {
                        if ([1, true].includes(packet.is_sold))
                            void locks.settled(account.account_id, packet.contract_id).catch(() => {});
                        try {
                            onTrade(value.account, value.engine.getSnapshot(), packet);
                        } catch {
                            /* Reporting never interrupts trading. */
                        }
                    }
                });
                broker.connection?.addEventListener('close', () => reporting?.unsubscribe(), { once: true });
                return broker;
            };

            value.engine = new Engine({
                account: () => value.account,
                builderRunning: () => (builderBuys.get(account.account_id)?.size || 0) > 0,
                storage: engineStorage,
                createApi: brokerForRun,
                runDemoPause: (spec, options) =>
                    demoPauses
                        .run(value.runRequest || value.request, value.account, spec, {
                            ...options,
                            parentLease: value.lease,
                            sourceTool:
                                value.engine.getSnapshot().settings.strategy === 'momentum-70'
                                    ? 'momentum_70'
                                    : value.engine.getSnapshot().settings.strategy === 'even-odd'
                                      ? 'even_odd'
                                      : value.engine.getSnapshot().settings.strategy === 'over2-under7'
                                        ? 'hit_and_run'
                                        : 'analysis_tool',
                        })
                        .finally(() => settleLease(value)),
            });
            value.engine.selectAccount(account);
            value.engine.subscribe?.(() => settleLease(value));
            // A restart never continues entries automatically.
            const state = value.engine.getSnapshot();
            // Database runs retain an unexpired prior-process lease. A manual
            // restart can proceed once it expires; no run resumes itself.
            if (storage.mode !== 'postgres' && (state.liveUntil || state.owner)) {
                const key = `neto.digit-strategy.v1.${account.account_id}`;
                const saved = JSON.parse(storage.getItem(key));
                storage.setItem(key, JSON.stringify({ ...saved, liveUntil: 0, owner: '' }));
                value.engine = new Engine({
                    account: () => value.account,
                    builderRunning: () => (builderBuys.get(account.account_id)?.size || 0) > 0,
                    storage: engineStorage,
                    createApi: brokerForRun,
                    runDemoPause: (spec, options) =>
                        demoPauses
                            .run(value.runRequest || value.request, value.account, spec, {
                                ...options,
                                parentLease: value.lease,
                                sourceTool:
                                    value.engine.getSnapshot().settings.strategy === 'momentum-70'
                                        ? 'momentum_70'
                                        : value.engine.getSnapshot().settings.strategy === 'even-odd'
                                          ? 'even_odd'
                                          : value.engine.getSnapshot().settings.strategy === 'over2-under7'
                                            ? 'hit_and_run'
                                            : 'analysis_tool',
                            })
                            .finally(() => settleLease(value)),
                });
                value.engine.selectAccount(account);
            }
            sessions.set(account.account_id, value);
        }
        return value;
    };
    const fail = (status, message) => Object.assign(new Error(message), { status });
    async function handle(req, res) {
        const json = (status, value) => {
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(value));
        };
        try {
            const url = new URL(req.url, auth.publicOrigin);
            if (req.method !== 'GET' && req.method !== 'POST') throw fail(405, 'Method not allowed.');
            if (req.method === 'POST' && req.headers.origin !== auth.publicOrigin)
                throw fail(403, 'Invalid request origin.');
            const id = url.searchParams.get('account_id');
            if (!id || id.length > 128) throw fail(400, 'Select a trading account.');
            const account = await auth.authorizeAccount(req, id);
            if (req.method === 'GET' && url.searchParams.has('demo_pause')) {
                const trigger = Number(url.searchParams.get('demo_pause'));
                if (!Number.isSafeInteger(trigger) || trigger <= 0) throw fail(400, 'Invalid demo pause reference.');
                return json(200, { demoPause: await demoPauses.status(id, trigger) });
            }
            await prepareAccount(id);
            let value = entry(account);
            if (req.method === 'GET' && !value.starting && !value.engine.getSnapshot().active && storage.peek) {
                const saved = await storage.peek(key(id));
                if (saved) {
                    const state = JSON.parse(saved);
                    const holder = await locks.current(id);
                    const live =
                        state.active && state.liveUntil > Date.now() && holder.active && holder.mode === 'analysis';
                    return json(200, {
                        ...state,
                        active: !!live,
                        wantsRun: !!live && state.wantsRun,
                        markets: [],
                        serverExecution: true,
                        demoOnly: false,
                    });
                }
            }
            if (req.method === 'POST') {
                if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'JSON required.');
                let raw = '';
                for await (const chunk of req) {
                    raw += chunk;
                    if (Buffer.byteLength(raw) > 8192) throw fail(413, 'Request too large.');
                }
                let body;
                try {
                    body = JSON.parse(raw);
                } catch {
                    throw fail(400, 'Invalid JSON.');
                }
                if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Invalid command.');
                if (closing && body.action !== 'stop') throw fail(503, 'The server is shutting down.');
                if (value.starting && body.action !== 'stop')
                    throw fail(409, 'This account is already processing a trading command.');
                if (demoPauses.busy(id) && body.action !== 'stop')
                    throw fail(409, 'A demo recovery pause is active. Stop and settle it before changing tools.');
                if (body.action === 'demo-break') {
                    auth.requireTerms?.(req);
                    if (busy(id) || (builderBuys.get(id)?.size || 0) > 0)
                        throw fail(409, 'Settle the real trade before starting the demo pause.');
                    const controller = new AbortController();
                    const cancelled = () => {
                        if (!res.writableEnded) controller.abort();
                    };
                    res.once('close', cancelled);
                    try {
                        const demoPause = await demoPauses.run(req, account, body.spec, {
                            signal: controller.signal,
                            sourceTool: 'bot_builder',
                        });
                        if (!res.destroyed) return json(200, { demoPause });
                        return;
                    } finally {
                        res.removeListener('close', cancelled);
                    }
                } else if (body.action === 'import-browser') {
                    if (
                        (typeof body.legacy?.pending?.nonce === 'string' &&
                            value.engine.getSnapshot().pending?.nonce === body.legacy.pending.nonce) ||
                        value.engine.getSnapshot().trades.some(trade => trade.id === body.legacy?.pending?.nonce)
                    )
                        return json(200, {
                            ...value.engine.getSnapshot(),
                            serverExecution: true,
                            demoOnly: false,
                        });
                    if (busy(id) || value.engine.getSnapshot().trades.length)
                        throw fail(409, 'Resolve the current server session before importing a browser purchase.');
                    const legacy = body.legacy;
                    const settings = { ...DEFAULT_SETTINGS, ...legacy?.settings };
                    validateSettings(settings);
                    const pending = legacy?.pending;
                    const directions = ['DIGITOVER', 'DIGITUNDER', 'DIGITDIFF', 'DIGITEVEN', 'DIGITODD'];
                    if (
                        !pending ||
                        typeof pending.nonce !== 'string' ||
                        !pending.nonce ||
                        pending.nonce.length > 200 ||
                        !Number.isSafeInteger(pending.stake) ||
                        pending.stake < 35 ||
                        !Number.isSafeInteger(pending.payout) ||
                        pending.payout < pending.stake ||
                        !Number.isSafeInteger(pending.sentAt) ||
                        (pending.contractId !== undefined &&
                            (!Number.isSafeInteger(pending.contractId) || pending.contractId <= 0)) ||
                        !directions.includes(pending.signal?.direction) ||
                        !/^[A-Z0-9_]{1,50}$/.test(pending.signal?.symbol || '') ||
                        !Number.isSafeInteger(pending.signal?.epoch) ||
                        (pending.signal.barrier !== undefined && !/^[0-9]$/.test(pending.signal.barrier))
                    )
                        throw fail(400, 'Invalid saved browser purchase. Check Deriv history before continuing.');
                    const restored = {
                        ...empty(),
                        accountId: id,
                        settings,
                        pending,
                        stake: cents(settings.stake),
                        version: 1,
                    };
                    for (const key of [
                        'pnl',
                        'streak',
                        'stake',
                        'wins',
                        'losses',
                        'voids',
                        'maxDrawdown',
                        'peak',
                        'highestStake',
                        'recoveryLosses',
                        'batch',
                    ]) {
                        if (!Number.isSafeInteger(legacy[key]) || (key !== 'pnl' && legacy[key] < 0))
                            throw fail(400, 'Invalid browser session counters.');
                        restored[key] = legacy[key];
                    }
                    restored.recovery = { ...restored.recovery, ...legacy.recovery, streak: restored.streak };
                    if (pending.contractId)
                        restored.trades = [
                            {
                                id: pending.nonce,
                                contractId: pending.contractId,
                                market: pending.signal.symbol,
                                direction: pending.signal.direction,
                                barrier: pending.signal.barrier,
                                recovery: !!pending.signal.recovery,
                                stake: pending.stake,
                                payout: pending.payout,
                                status: 'Open',
                                at: pending.sentAt,
                            },
                        ];
                    value.starting = true;
                    let lease;
                    try {
                        lease = await locks.claim(id, { mode: 'analysis' });
                        storage.setItem(`neto.digit-strategy.v1.${id}`, JSON.stringify(restored));
                        sessions.delete(id);
                        value = entry(account);
                        value.lease = lease;
                        await storage.flush?.(key(id));
                        return json(200, { ...value.engine.getSnapshot(), serverExecution: true, demoOnly: false });
                    } finally {
                        value.starting = false;
                        if (lease) await locks.release(lease);
                    }
                } else if (body.action === 'start') {
                    auth.requireTerms?.(req);
                    if (demoPauses.busy(id))
                        throw fail(409, 'A demo recovery pause is active. Stop it before starting another tool.');
                    if (value.engine.getSnapshot().active)
                        throw fail(409, 'This account already has an Analysis Tool running.');
                    if (locks.mode !== 'postgres' && (builderBuys.get(id)?.size || 0) > 0)
                        throw fail(409, 'A Builder purchase is open or unconfirmed. Settle it before starting.');
                    value.starting = true;
                    value.cancelled = false;
                    value.account = account;
                    value.request = req;
                    value.runRequest = req;
                    value.expiry?.();
                    value.expiry = watchSessionExpiry(
                        () => auth.sessionExpires(req),
                        () => {
                            value.cancelled = true;
                            value.engine.stop('Deriv login expired. No new entries.');
                        }
                    );
                    // Respond before market discovery completes; every device observes its progress.
                    value.task = (async () => {
                        let check;
                        try {
                            const fresh = storage.peek ? await storage.peek(key(id)) : storage.getItem(key(id));
                            const pending = fresh && JSON.parse(fresh).pending;
                            value.lease = await locks.claim(id, {
                                mode: 'analysis',
                                reconcile: pending?.nonce ? [pending.nonce] : [],
                            });
                            locks.hold(value.lease, {
                                onLost: () => {
                                    onOperationalEvent('account_lock_lost');
                                    value.cancelled = true;
                                    value.engine.stop('Account lock lost. No new entries.');
                                },
                                onStop: () => {
                                    value.cancelled = true;
                                    value.engine.stop('Stop requested from another device.');
                                },
                            });
                            if (storage.reload) {
                                await storage.reload(key(id));
                                const old = value;
                                sessions.delete(id);
                                const restored = entry(account);
                                Object.assign(restored, {
                                    starting: true,
                                    cancelled: old.cancelled,
                                    request: req,
                                    runRequest: req,
                                    lease: old.lease,
                                    expiry: old.expiry,
                                });
                                restored.task = old.task;
                                value = restored;
                            }
                            // A prior journal failure cannot be bypassed by
                            // starting another tool in this process.
                            await storage.flush?.(key(id));
                            if (value.cancelled) throw new Error('Start cancelled.');
                            if (!value.engine.getSnapshot().pending) {
                                check = await brokerFactory(await auth.connectionUrl(req, id));
                                const result = await Promise.race([
                                    check.send({ portfolio: 1 }),
                                    new Promise((_, reject) => {
                                        const t = setTimeout(
                                            () => reject(new Error('Portfolio check timed out.')),
                                            12000
                                        );
                                        t.unref?.();
                                    }),
                                ]);
                                if (!Array.isArray(result.portfolio?.contracts))
                                    throw new Error('Unable to verify open contracts.');
                                if (result.portfolio.contracts.length)
                                    throw new Error('Settle existing Deriv contracts before starting Analysis Tool.');
                                check.disconnect();
                                check = undefined;
                            }
                            if (value.cancelled) throw new Error('Start cancelled.');
                            await value.engine.start(body.settings, body.reconcileId);
                            value.commandError = '';
                        } catch (error) {
                            value.commandError = error.message || 'Unable to start server trading.';
                        } finally {
                            check?.disconnect();
                            value.starting = false;
                            value.request = undefined;
                            settleLease(value);
                        }
                    })();
                } else if (body.action === 'stop') {
                    demoPauses.stop(id);
                    value.cancelled = true;
                    if (value.engine.getSnapshot().active) value.engine.stop();
                    await locks.requestStop(id);
                    if (locks.mode === 'postgres' && !value.engine.getSnapshot().active && storage.peek) {
                        const saved = await storage.peek(key(id));
                        return json(200, {
                            ...(saved ? JSON.parse(saved) : value.engine.getSnapshot()),
                            wantsRun: false,
                            markets: [],
                            phase: 'Stop requested. An open contract may still settle.',
                            serverExecution: true,
                            demoOnly: false,
                        });
                    }
                    if (!storage.peek) value.engine.stop();
                } else if (body.action === 'reset') {
                    if (value.engine.getSnapshot().active || value.engine.getSnapshot().pending)
                        throw fail(409, 'Stop and settle the current session before resetting.');
                    value.starting = true;
                    try {
                        const lease = await locks.claim(id, { mode: 'analysis' });
                        if (storage.reload) {
                            await storage.reload(key(id));
                            value.expiry?.();
                            sessions.delete(id);
                            value = entry(account);
                        }
                        value.lease = lease;
                        value.engine.reset();
                        value.commandError = '';
                    } finally {
                        value.starting = false;
                        settleLease(value);
                    }
                } else throw fail(400, 'Unknown trading command.');
                await storage.flush?.(key(id));
                settleLease(value);
            }
            return json(200, {
                ...value.engine.getSnapshot(),
                starting: value.starting,
                commandError: value.commandError || '',
                serverExecution: true,
                demoOnly: false,
            });
        } catch (error) {
            return json(error.status || 400, {
                error: error.status ? error.message : 'Unable to process the trading session.',
            });
        }
    }
    return {
        handle,
        busy,
        prepareAccount,
        async authorizeBuilderBuy(id, body, clientKey) {
            if (!Number.isSafeInteger(body.req_id) || body.req_id < 0)
                throw fail(400, 'A valid purchase request identifier is required.');
            if (builderOrders.has(`${id}:${clientKey}:${body.req_id}`))
                throw fail(409, 'This purchase request is already pending.');
            builderOrders.set(`${id}:${clientKey}:${body.req_id}`, { preparing: true });
            let lease, nonce;
            try {
                await this.prepareBuilder(id);
                this.beforeBuilder(id, body, clientKey);
                lease = await locks.claim(id, { mode: 'builder' });
                const shared = storage.peek ? await storage.peek(key(id)) : null;
                if (shared) {
                    const state = JSON.parse(shared);
                    if (state.pending || (state.active && state.liveUntil > Date.now()))
                        throw fail(409, 'Stop and settle the server tool before buying from Bot Builder.');
                }
                nonce = randomUUID();
                await locks.protect(lease, nonce);
                builderOrders.set(`${id}:${clientKey}:${body.req_id}`, { lease, nonce });
                return { ...body, passthrough: { ...(body.passthrough || {}), neto_lock_order: nonce } };
            } catch (error) {
                builderBuys.get(id)?.delete(`request:${clientKey}:${body.req_id}`);
                builderOrders.delete(`${id}:${clientKey}:${body.req_id}`);
                if (lease) await locks.release(lease).catch(() => {});
                throw error;
            }
        },
        async cancelBuilderBuy(id, body, clientKey) {
            const order = builderOrders.get(`${id}:${clientKey}:${body.req_id}`);
            if (order?.lease) await locks.cancel(order.lease, order.nonce);
            builderOrders.delete(`${id}:${clientKey}:${body.req_id}`);
            builderBuys.get(id)?.delete(`request:${clientKey}:${body.req_id}`);
        },
        async observeBuilder(id, data, clientKey) {
            const order = builderOrders.get(`${id}:${clientKey}:${data.req_id}`);
            if (order?.lease && data.buy?.contract_id) {
                await locks.acknowledge(order.lease, order.nonce, Number(data.buy.contract_id));
                builderOrders.delete(`${id}:${clientKey}:${data.req_id}`);
            } else if (order?.lease && data.error && DEFINITIVE.has(data.error.code)) {
                await locks.cancel(order.lease, order.nonce);
                builderOrders.delete(`${id}:${clientKey}:${data.req_id}`);
            }
            if ([1, true].includes(data.proposal_open_contract?.is_sold))
                await locks.settled(id, Number(data.proposal_open_contract.contract_id));
            this.builderResponse(id, data, clientKey);
        },
        async prepareBuilder(id) {
            await prepareAccount(id);
            await storage.flush?.(key(id));
        },
        beforeBuilder(id, body, clientKey = 'default') {
            if (!body.buy) return;
            if (closing) throw new Error('The server is shutting down. No new purchases are allowed.');
            if (busy(id)) throw new Error('Stop and settle the server Analysis Tool before buying from Bot Builder.');
            if (!builderBuys.has(id)) builderBuys.set(id, new Set());
            builderBuys.get(id).add(`request:${clientKey}:${body.req_id}`);
        },
        builderResponse(id, data, clientKey = 'default') {
            const tracked = builderBuys.get(id);
            if (!tracked) return;
            if (data.echo_req?.buy || data.buy || (data.error && tracked.has(`request:${clientKey}:${data.req_id}`))) {
                tracked.delete(`request:${clientKey}:${data.req_id}`);
                if (data.buy?.contract_id) tracked.add(data.buy.contract_id);
            }
            if (data.proposal_open_contract?.is_sold) tracked.delete(data.proposal_open_contract.contract_id);
            if (!tracked.size) builderBuys.delete(id);
        },
        stopAll() {
            closing = true;
            demoPauses.stopAll();
            for (const value of sessions.values()) {
                value.cancelled = true;
                value.expiry?.();
                value.engine.stop('Server shutting down; no new entries.');
            }
        },
        async close() {
            this.stopAll();
            await demoPauses.close();
            // Start commands may be suspended at the portfolio or journal
            // checkpoint. Cancellation is checked again before any purchase.
            await Promise.allSettled([...sessions.values()].map(value => value.task));
            await Promise.allSettled(
                [...sessions.values()].map(async value => {
                    await storage.flush?.(key(value.account.account_id));
                    if (!value.engine.getSnapshot().pending) await locks.release(value.lease);
                })
            );
            await locks.close();
            await storage.close?.();
        },
        storageMode: storage.mode || 'custom',
        async health() {
            const [journal, protection] = await Promise.all([
                storage.probe?.() || { mode: storage.mode || 'custom', failedAccounts: 0 },
                locks.probe(),
            ]);
            return {
                journal,
                protection,
                locks: await locks.summary(),
                active: [...sessions.values()].filter(value => value.engine.getSnapshot().active).length,
            };
        },
        sessions,
    };
}
module.exports = { createAnalysisService, fileStorage };
