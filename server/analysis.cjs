const { watchSessionExpiry } = require('./session-expiry.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DigitStrategyEngine, empty } = require('../.server-build/engine');
const { DEFAULT_SETTINGS, validateSettings, cents } = require('../.server-build/strategy');
const { createBroker } = require('./strategy-broker.cjs');

function fileStorage(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
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
        storage = fileStorage(process.env.NETO_ANALYSIS_STATE_DIR || path.join(__dirname, '../.analysis-state')),
        brokerFactory = url => createBroker(url, dispatcher),
        Engine = DigitStrategyEngine,
        allowReal = process.env.NETO_ANALYSIS_ALLOW_REAL === 'true',
    } = {}
) {
    const sessions = new Map();
    const builderBuys = new Map();
    const busy = id => {
        const session = sessions.get(id);
        if (!session) {
            const saved = storage.getItem(`neto.digit-strategy.v1.${id}`);
            if (saved && JSON.parse(saved).pending) return true;
        }
        return !!(session?.starting || session?.engine.getSnapshot().active || session?.engine.getSnapshot().pending);
    };
    const entry = account => {
        let value = sessions.get(account.account_id);
        if (!value) {
            value = { account, starting: false, request: undefined };
            value.engine = new Engine({
                account: () => value.account,
                builderRunning: () => (builderBuys.get(account.account_id)?.size || 0) > 0,
                storage,
                createApi: async () => {
                    const url = await auth.connectionUrl(value.request, account.account_id);
                    return brokerFactory(url);
                },
            });
            value.engine.selectAccount(account);
            // A restart never continues entries automatically. Clear an expired process lease.
            const state = value.engine.getSnapshot();
            if (state.liveUntil || state.owner) {
                const key = `neto.digit-strategy.v1.${account.account_id}`;
                const saved = JSON.parse(storage.getItem(key));
                storage.setItem(key, JSON.stringify({ ...saved, liveUntil: 0, owner: '' }));
                value.engine = new Engine({
                    account: () => value.account,
                    builderRunning: () => (builderBuys.get(account.account_id)?.size || 0) > 0,
                    storage,
                    createApi: async () => brokerFactory(await auth.connectionUrl(value.request, account.account_id)),
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
            const value = entry(account);
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
                if (value.starting && body.action !== 'stop')
                    throw fail(409, 'This account is already processing a trading command.');
                if (body.action === 'import-browser') {
                    if (
                        (typeof body.legacy?.pending?.nonce === 'string' &&
                            value.engine.getSnapshot().pending?.nonce === body.legacy.pending.nonce) ||
                        value.engine.getSnapshot().trades.some(trade => trade.id === body.legacy?.pending?.nonce)
                    )
                        return json(200, {
                            ...value.engine.getSnapshot(),
                            serverExecution: true,
                            demoOnly: !allowReal,
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
                    storage.setItem(`neto.digit-strategy.v1.${id}`, JSON.stringify(restored));
                    sessions.delete(id);
                    const imported = entry(account);
                    return json(200, { ...imported.engine.getSnapshot(), serverExecution: true, demoOnly: !allowReal });
                } else if (body.action === 'start') {
                    if (account.account_type !== 'demo' && !allowReal) {
                        const pending = value.engine.getSnapshot().pending;
                        if (!pending)
                            throw fail(
                                403,
                                'Server trading preview supports demo accounts. Select a USD demo account.'
                            );
                        body.reconcileId = pending.contractId || body.reconcileId;
                        if (!Number.isSafeInteger(body.reconcileId) || body.reconcileId <= 0)
                            throw fail(
                                400,
                                'Enter the pending contract ID to reconcile this purchase. New real entries are disabled.'
                            );
                    }
                    if (value.engine.getSnapshot().active)
                        throw fail(409, 'This account already has an Analysis Tool running.');
                    if ((builderBuys.get(id)?.size || 0) > 0)
                        throw fail(409, 'A Builder purchase is open or unconfirmed. Settle it before starting.');
                    value.starting = true;
                    value.cancelled = false;
                    value.account = account;
                    value.request = req;
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
                        }
                    })();
                } else if (body.action === 'stop') {
                    value.cancelled = true;
                    value.engine.stop();
                } else if (body.action === 'reset') {
                    value.engine.reset();
                    value.commandError = '';
                } else throw fail(400, 'Unknown trading command.');
            }
            return json(200, {
                ...value.engine.getSnapshot(),
                starting: value.starting,
                commandError: value.commandError || '',
                serverExecution: true,
                demoOnly: !allowReal,
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
        beforeBuilder(id, body, clientKey = 'default') {
            if (!body.buy) return;
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
            for (const value of sessions.values()) {
                value.cancelled = true;
                value.expiry?.();
                value.engine.stop('Server shutting down; no new entries.');
            }
        },
        sessions,
    };
}
module.exports = { createAnalysisService, fileStorage };
