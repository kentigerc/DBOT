const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAnalysisService, fileStorage } = require('./analysis.cjs');
const { empty } = require('../.server-build/engine');
const { DEFAULT_SETTINGS } = require('../.server-build/strategy');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
class ControlledEngine {
    static starts = 0;
    constructor(deps) {
        this.deps = deps;
        this.state = empty();
    }
    selectAccount(account) {
        this.state.accountId = account.account_id;
    }
    getSnapshot() {
        return this.state;
    }
    async start(settings) {
        ControlledEngine.starts++;
        this.state = { ...this.state, settings, active: true, wantsRun: true, phase: 'Running', pnl: 42 };
    }
    stop() {
        this.state = { ...this.state, active: false, wantsRun: false, phase: 'Stopped' };
    }
    reset() {
        if (this.state.active || this.state.pending) throw new Error('Settle first');
        this.state = { ...empty(), accountId: this.state.accountId };
    }
}
async function fixture(t, options = {}) {
    const saved = new Map();
    const storage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
    const auth = {
        publicOrigin: 'http://localhost',
        requireTerms: () => {
            if (options.termsDenied) throw Object.assign(new Error('Accept terms first'), { status: 403 });
        },
        sessionExpires: () => Date.now() + 60000,
        authorizeAccount: async (req, id) => {
            if (!['device=phone', 'device=laptop'].includes(req.headers.cookie))
                throw Object.assign(new Error('Login required'), { status: 401 });
            if (id !== 'demo') throw Object.assign(new Error('Account denied'), { status: 403 });
            return { account_id: id, currency: 'USD', account_type: options.real ? 'real' : 'demo', status: 'active' };
        },
        connectionUrl: async () => 'wss://example.invalid/private',
    };
    const service = createAnalysisService(auth, {
        storage,
        Engine: ControlledEngine,
        brokerFactory: async () => ({
            send: async () => ({ portfolio: { contracts: options.open ? [{}] : [] } }),
            disconnect() {},
        }),
        ...options,
    });
    const server = http.createServer(service.handle);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/analysis?account_id=`;
    t.after(() => {
        for (const value of service.sessions.values()) clearTimeout(value.expiry);
        service.stopAll();
        server.closeAllConnections();
        server.close();
    });
    async function request(device, body, id = 'demo', origin = 'http://localhost') {
        const response = await fetch(base + id, {
            headers: { cookie: `device=${device}`, origin, 'content-type': 'application/json' },
            ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, data: await response.json() };
    }
    return { request, service, saved };
}
test('two independent device sessions see one runner and either device can stop it', async t => {
    ControlledEngine.starts = 0;
    const { request, service } = await fixture(t);
    const command = { action: 'start', settings: { ...DEFAULT_SETTINGS, multiplier: 3 } };
    const result = await Promise.all([request('phone', command), request('laptop', command)]);
    assert.deepEqual(result.map(r => r.status).sort(), [200, 409]);
    await service.sessions.get('demo').task;
    assert.equal(ControlledEngine.starts, 1);
    const phone = await request('phone'),
        laptop = await request('laptop');
    assert.equal(phone.data.active, true);
    assert.equal(laptop.data.pnl, 42);
    assert.equal(laptop.data.settings.multiplier, 3);
    assert.equal((await request('laptop', { action: 'start', settings: DEFAULT_SETTINGS })).status, 409);
    assert.throws(() => service.beforeBuilder('demo', { buy: 1, req_id: 1 }), /Analysis Tool/);
    await request('laptop', { action: 'stop' });
    assert.equal((await request('phone')).data.active, false);
});
test('account authorization and origin checks protect status and commands', async t => {
    const { request } = await fixture(t);
    assert.equal((await request('stranger')).status, 401);
    assert.equal((await request('phone', undefined, 'another-account')).status, 403);
    assert.equal((await request('phone', { action: 'start' }, 'demo', 'https://attacker.invalid')).status, 403);
});
for (const real of [false, true]) {
    for (const [tool, configuration] of [
        ['Analysis Tool', {}],
        ['HIT AND RUN', { strategy: 'over2-under7' }],
        ['Even / Odd', { strategy: 'even-odd' }],
        ['Momentum', { strategy: 'momentum-70', recoveryMode: 'same_contract' }],
    ]) {
        test(`${tool} accepts an authorized active ${real ? 'real' : 'demo'} USD account`, async t => {
            const previous = process.env.NETO_ANALYSIS_ALLOW_REAL;
            process.env.NETO_ANALYSIS_ALLOW_REAL = 'false';
            t.after(() => {
                if (previous === undefined) delete process.env.NETO_ANALYSIS_ALLOW_REAL;
                else process.env.NETO_ANALYSIS_ALLOW_REAL = previous;
            });
            const { request, service } = await fixture(t, { real });
            const settings = { ...DEFAULT_SETTINGS, ...configuration };
            const result = await request('phone', { action: 'start', settings });
            assert.equal(result.status, 200);
            await service.sessions.get('demo').task;
            const state = (await request('laptop')).data;
            assert.equal(state.active, true);
            assert.equal(state.commandError, '');
            assert.equal(state.demoOnly, false);
            assert.equal(state.settings.strategy, settings.strategy);
            assert.equal((await request('stranger', { action: 'start', settings })).status, 401);
            assert.equal((await request('phone', { action: 'start', settings }, 'another-account')).status, 403);
            await request('laptop', { action: 'stop' });
            assert.equal((await request('phone')).data.active, false);
        });
    }
}
test('fresh starts still reject existing open contracts', async t => {
    const open = await fixture(t, { open: true });
    await open.request('phone', { action: 'start', settings: DEFAULT_SETTINGS });
    await open.service.sessions.get('demo').task;
    assert.match((await open.request('laptop')).data.commandError, /existing Deriv contracts/);
    assert.equal((await open.request('laptop')).data.active, false);
});
test('STOP cancels a start while its portfolio check is in flight', async t => {
    let release;
    const { request, service } = await fixture(t, {
        brokerFactory: async () => ({
            send: () =>
                new Promise(resolve => {
                    release = resolve;
                }),
            disconnect() {},
        }),
    });
    const before = ControlledEngine.starts;
    await request('phone', { action: 'start', settings: DEFAULT_SETTINGS });
    await request('laptop', { action: 'stop' });
    release({ portfolio: { contracts: [] } });
    await service.sessions.get('demo').task;
    assert.equal(ControlledEngine.starts, before);
    assert.equal((await request('phone')).data.active, false);
});
test('file journal survives reconstruction and corruption fails closed', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neto-analysis-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const first = fileStorage(directory);
    first.setItem('session', JSON.stringify({ pending: { contractId: 123 } }));
    assert.equal(JSON.parse(fileStorage(directory).getItem('session')).pending.contractId, 123);
    assert.equal(first.getItem('missing'), null);
    assert.equal(fs.readdirSync(directory).length, 1);
});
test('restart restores unresolved intent without connecting or placing orders', async t => {
    const { DigitStrategyEngine } = require('../.server-build/engine');
    let connections = 0;
    const { request, service, saved } = await fixture(t, {
        Engine: DigitStrategyEngine,
        brokerFactory: async () => {
            connections++;
            throw new Error('Should not connect automatically');
        },
    });
    const pending = {
        nonce: 'saved-order',
        contractId: 123,
        stake: 35,
        payout: 67,
        sentAt: Date.now(),
        signal: { symbol: 'R_100', direction: 'DIGITUNDER', barrier: '5', epoch: 100, recovery: true },
    };
    saved.set(
        'neto.digit-strategy.v1.demo',
        JSON.stringify({
            ...empty(),
            version: 1,
            accountId: 'demo',
            active: true,
            owner: 'old-process',
            liveUntil: Date.now() + 15000,
            pending,
        })
    );
    assert.equal(service.busy('demo'), true);
    const response = await request('laptop');
    assert.equal(response.data.active, false);
    assert.equal(response.data.pending.contractId, 123);
    assert.equal(connections, 0);
    assert.equal((await request('phone', { action: 'reset' })).status, 400);
    assert.equal(service.busy('demo'), true);
});
test('imports a prior browser purchase once and preserves its multiplier and counters', async t => {
    const { DigitStrategyEngine } = require('../.server-build/engine');
    const { request } = await fixture(t, { Engine: DigitStrategyEngine });
    const legacy = {
        ...empty(),
        pnl: -35,
        losses: 1,
        streak: 1,
        stake: 105,
        settings: { ...DEFAULT_SETTINGS, multiplier: 3 },
        pending: {
            nonce: 'browser-order',
            contractId: 123,
            stake: 105,
            payout: 200,
            sentAt: Date.now(),
            signal: { symbol: 'R_100', direction: 'DIGITUNDER', barrier: '5', epoch: 100, recovery: true },
        },
    };
    const imported = await request('phone', { action: 'import-browser', legacy });
    assert.equal(imported.status, 200);
    assert.equal(imported.data.settings.multiplier, 3);
    assert.equal(imported.data.pnl, -35);
    assert.equal(imported.data.pending.contractId, 123);
    assert.equal(imported.data.active, false);
    assert.equal((await request('laptop', { action: 'import-browser', legacy })).status, 200);
});
test('Builder requests from different devices retain independent purchase locks', async t => {
    const { service, request } = await fixture(t);
    service.beforeBuilder('demo', { buy: 1, req_id: 1 }, 'phone');
    service.beforeBuilder('demo', { buy: 1, req_id: 1 }, 'laptop');
    service.builderResponse('demo', { req_id: 1, error: { code: 'Rejected' } }, 'phone');
    assert.equal((await request('phone', { action: 'start', settings: DEFAULT_SETTINGS })).status, 409);
    service.builderResponse('demo', { req_id: 1, error: { code: 'Rejected' } }, 'laptop');
    assert.equal((await request('phone', { action: 'start', settings: DEFAULT_SETTINGS })).status, 200);
    await service.sessions.get('demo').task;
});
test('explicit real-account reconciliation settles a prior purchase without placing new entries', async t => {
    const { DigitStrategyEngine } = require('../.server-build/engine');
    const calls = [];
    const { saved, service, request } = await fixture(t, {
        real: true,
        Engine: DigitStrategyEngine,
        brokerFactory: async () => ({
            connection: new EventTarget(),
            onMessage: () => ({ subscribe: () => ({ unsubscribe() {} }) }),
            disconnect() {},
            send: async body => {
                calls.push(body);
                return {
                    proposal_open_contract: {
                        contract_id: 123,
                        underlying: 'R_100',
                        contract_type: 'DIGITUNDER',
                        barrier: '5',
                        currency: 'USD',
                        buy_price: 0.35,
                        payout: 0.67,
                        tick_count: 1,
                        is_sold: 1,
                        profit: -0.35,
                    },
                };
            },
        }),
    });
    saved.set(
        'neto.digit-strategy.v1.demo',
        JSON.stringify({
            ...empty(),
            settings: { ...DEFAULT_SETTINGS, duration: 1 },
            version: 1,
            accountId: 'demo',
            pending: {
                nonce: 'prior-real',
                contractId: 123,
                stake: 35,
                payout: 67,
                sentAt: Date.now(),
                signal: { symbol: 'R_100', direction: 'DIGITUNDER', barrier: '5', epoch: 100, recovery: false },
            },
        })
    );
    assert.equal(
        (await request('phone', { action: 'start', settings: { ...DEFAULT_SETTINGS, duration: 1 }, reconcileId: 123 }))
            .status,
        200
    );
    await service.sessions.get('demo').task;
    const state = (await request('laptop')).data;
    assert.equal(state.active, false);
    assert.equal(state.pending, undefined);
    assert.equal(state.losses, 1);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(body => body.proposal_open_contract));
});
test('HIT AND RUN shares the account runner and keeps Builder locked while active', async t => {
    const { request, service } = await fixture(t);
    const settings = { ...DEFAULT_SETTINGS, strategy: 'over2-under7' };
    assert.equal((await request('phone', { action: 'start', settings })).status, 200);
    await service.sessions.get('demo').task;
    const state = (await request('laptop')).data;
    assert.equal(state.settings.strategy, 'over2-under7');
    assert.equal(state.settings.duration, 1);
    assert.equal(state.active, true);
    assert.throws(() => service.beforeBuilder('demo', { buy: 1, req_id: 1 }), /Stop and settle/);
    await request('laptop', { action: 'stop' });
    assert.equal((await request('phone')).data.active, false);
});

test('analytics observes only provider purchase/settlement packets rather than imported strategy counters', async t => {
    const listeners = new Set(),
        observed = [];
    const { request, service } = await fixture(t, {
        onTrade: (...args) => observed.push(args),
        brokerFactory: async () => ({
            send: async () => ({ portfolio: { contracts: [] } }),
            disconnect() {},
            connection: new EventTarget(),
            onMessage: () => ({
                subscribe: listener => {
                    listeners.add(listener);
                    return { unsubscribe: () => listeners.delete(listener) };
                },
            }),
        }),
    });
    await request('phone', { action: 'start', settings: { ...DEFAULT_SETTINGS, strategy: 'over2-under7' } });
    const value = service.sessions.get('demo');
    await value.task;
    await value.engine.deps.createApi();
    assert.equal(observed.length, 0);
    for (const listener of listeners) listener({ data: { buy: { contract_id: 123, buy_price: 0.35 } } });
    for (const listener of listeners)
        listener({ data: { proposal_open_contract: { contract_id: 123, is_sold: 0, profit: -0.35 } } });
    for (const listener of listeners)
        listener({ data: { proposal_open_contract: { contract_id: 123, is_sold: 1, buy_price: 0.35, profit: 0.12 } } });
    assert.equal(observed.length, 2);
    assert.equal(observed[0][0].account_id, 'demo');
    assert.equal(observed[0][1].settings.strategy, 'over2-under7');
    assert.equal(observed[1][2].profit, 0.12);
});

for (const real of [false, true]) {
    test(`compiled strategy refuses an unfunded ${real ? 'real' : 'demo'} account before discovering markets`, async t => {
        const { DigitStrategyEngine } = require('../.server-build/engine');
        const calls = [];
        const { request, service } = await fixture(t, {
            real,
            Engine: DigitStrategyEngine,
            brokerFactory: async () => ({
                connection: new EventTarget(),
                onMessage: () => ({ subscribe: () => ({ unsubscribe() {} }) }),
                disconnect() {},
                send: async body => {
                    calls.push(body);
                    if (body.portfolio) return { portfolio: { contracts: [] } };
                    if (body.balance) return { balance: { balance: 0.1, currency: 'USD' } };
                    throw new Error('No market or purchase request should be sent');
                },
            }),
        });
        assert.equal((await request('phone', { action: 'start', settings: DEFAULT_SETTINGS })).status, 200);
        await service.sessions.get('demo').task;
        const state = (await request('laptop')).data;
        assert.equal(state.active, false);
        assert.match(state.phase, /Insufficient balance/);
        assert.equal(state.pending, undefined);
        assert.ok(calls.some(body => body.balance));
        assert.ok(calls.every(body => body.portfolio || body.balance));
    });
}

test('terms gate blocks new starts but never blocks session status or STOP', async t => {
    const { request } = await fixture(t, { termsDenied: true });
    const before = ControlledEngine.starts;
    assert.equal((await request('phone', { action: 'start', settings: DEFAULT_SETTINGS })).status, 403);
    assert.equal(ControlledEngine.starts, before);
    assert.equal((await request('phone')).status, 200);
    assert.equal((await request('phone', { action: 'stop' })).status, 200);
});
