const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createHigherLowerService, validateSettings, signal, quotePair, DEFAULTS } = require('./higher-lower.cjs');
const { createAccountLocks } = require('./account-locks.cjs');
const prices = () => {
    const p = [100];
    for (let i = 1; i <= 100; i++) p.push(p.at(-1) + (i > 80 ? (i % 2 ? 1 : -1) : 0.01));
    return p;
};
const spin = async fn => {
    for (let i = 0; i < 100; i++) {
        if (fn()) return;
        await new Promise(r => setImmediate(r));
    }
    throw new Error('Condition did not complete');
};
async function fixture(t, options = {}) {
    const records = options.records || new Map(),
        listeners = new Set(),
        requests = [],
        timers = [],
        notifications = [];
    const locks = createAccountLocks({ databaseUrl: undefined });
    const connection = new EventTarget();
    const auth = {
        publicOrigin: 'https://neto.example',
        sessionIdentity: () => options.sid,
        authorizeAccount: async () => {
            if (options.blockAccountRead) throw Object.assign(new Error('Provider cooldown'), { status: 429 });
            return { account_id: 'DOT_TEST', account_type: options.real ? 'real' : 'demo', currency: 'USD' };
        },
        verifySession: async () => {
            if (options.verify) await options.verify();
            if (options.revoked) throw Object.assign(new Error('Logged out'), { status: 401 });
        },
        requireTerms() {},
        sessionExpires: () => Date.now() + 3600000,
        connectionUrl: async () => 'mock-only-url',
    };
    const broker = {
        connection,
        disconnect() {},
        onMessage: () => ({
            subscribe: fn => {
                listeners.add(fn);
                return { unsubscribe: () => listeners.delete(fn) };
            },
        }),
        async send(body) {
            requests.push(body);
            if (options.intercept) {
                const value = await options.intercept(body);
                if (value !== undefined) return value;
            }
            if (body.portfolio) return { portfolio: { contracts: [] } };
            if (body.active_symbols)
                return {
                    active_symbols: [
                        { symbol: 'R_100', exchange_is_open: 1 },
                        { symbol: 'CRASH500', exchange_is_open: 1 },
                    ],
                };
            if (body.contracts_for)
                return {
                    contracts_for: {
                        available: options.newTypes
                            ? [
                                  {
                                      contract_type: 'HIGHER',
                                      barriers: 1,
                                      min_contract_duration: '5t',
                                      max_contract_duration: '10t',
                                  },
                                  {
                                      contract_type: 'LOWER',
                                      barriers: 1,
                                      min_contract_duration: '5t',
                                      max_contract_duration: '10t',
                                  },
                              ]
                            : [{ contract_type: 'CALL' }, { contract_type: 'PUT' }],
                    },
                };
            if (body.ticks_history) return { history: { prices: prices(), times: [Date.now() / 1000] } };
            if (body.proposal)
                return {
                    subscription: { id: body.contract_type },
                    proposal: {
                        id: body.contract_type,
                        ask_price: body.amount,
                        payout: options.badPayout ? 0.5 : 0.9,
                        spot_time: options.stale ? Date.now() / 1000 - 10 : Date.now() / 1000,
                    },
                };
            if (body.forget) return { forget: body.forget };
            if (body.balance) return { balance: { balance: options.lowBalance ? 0.4 : 1000, currency: 'USD' } };
            if (body.buy) {
                if (body.buy === 'PUT' && options.failure) throw options.failure;
                return { buy: { contract_id: ['CALL', 'HIGHER'].includes(body.buy) ? 101 : 102, buy_price: 0.35 } };
            }
            if (body.proposal_open_contract)
                return { proposal_open_contract: { contract_id: body.contract_id, is_sold: 0 } };
            throw new Error('Unexpected request');
        },
    };
    const storage = {
        getItem: k => records.get(k) || null,
        setItem(k, v) {
            records.set(k, v);
        },
        flush: async () => {
            if (options.storageFails) throw new Error('Storage down');
        },
    };
    const service = createHigherLowerService(auth, {
        locks,
        storage,
        brokerFactory: async () => broker,
        sleep: async () => {},
        schedule: fn => {
            timers.push(fn);
            return { unref() {} };
        },
        onTrade: (id, packet) => notifications.push(packet),
    });
    t.after(async () => {
        options.storageFails = false;
        await service.close();
        await locks.close();
    });
    async function request(
        command,
        source = 'analysis',
        method = command ? 'POST' : 'GET',
        requestOrigin = auth.publicOrigin,
        attempt
    ) {
        const req = Readable.from(
            command ? [JSON.stringify({ command, settings: DEFAULTS, ...(attempt ? { attempt } : {}) })] : []
        );
        req.url = `/api/higher-lower?account_id=DOT_TEST&source=${source}`;
        req.method = method;
        req.headers = { origin: requestOrigin };
        let status, value;
        const res = {
            writeHead: s => {
                status = s;
            },
            end: body => {
                value = JSON.parse(body);
            },
        };
        await service.handle(req, res);
        return { status, value };
    }
    const state = source => service.entries.get(`DOT_TEST:${source || 'analysis'}`)?.state;
    const emit = async packet => {
        for (const listener of listeners) listener({ data: packet });
        await service.entries.get('DOT_TEST:analysis')?.events;
    };
    const start = async () => {
        await request('start');
        await service.entries.get('DOT_TEST:analysis').startTask;
    };
    const scan = async () => {
        timers.at(-1)();
        await service.entries.get('DOT_TEST:analysis').task;
    };
    return { request, state, emit, start, scan, requests, locks, records, options, auth, service, notifications };
}
test('validates real price expansion, settings and quote viability without promising a guaranteed hedge', () => {
    assert(signal(prices(), 5) > 0);
    assert.equal(signal(Array(101).fill(100), 5), 0);
    assert.equal(signal([1, 2], 5), 0);
    assert.throws(() => validateSettings({ stake: 5, stopLoss: 9 }));
    assert.throws(() => validateSettings({ duration: 1 }));
    assert.throws(() => validateSettings({ stake: Infinity }));
    assert.deepEqual(validateSettings(), DEFAULTS);
    assert.throws(() =>
        quotePair([{ proposal: { id: 'a', ask_price: 0.35, payout: 0.5, spot_time: Date.now() / 1000 } }], DEFAULTS)
    );
});
test('blocks real accounts and foreign origins before opening a broker', async t => {
    const f = await fixture(t, { real: true });
    assert.equal((await f.request('start')).status, 403);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.request('start', 'analysis', 'POST', 'https://foreign.example')).status, 403);
});
test('places two separately priced demo legs, holds the shared account lock and counts settlement once', async t => {
    const f = await fixture(t);
    await f.start();
    await f.scan();
    const buys = f.requests.filter(r => r.buy);
    assert.equal(buys.length, 2);
    assert.deepEqual(
        buys.map(r => r.buy),
        ['CALL', 'PUT']
    );
    assert.deepEqual(
        f.requests.filter(r => r.proposal).map(r => [r.barrier, r.duration]),
        [
            ['+1', 5],
            ['-1', 5],
        ]
    );
    assert.equal((await f.locks.summary()).pending, 1);
    await assert.rejects(f.locks.claim('DOT_TEST', { mode: 'analysis' }));
    const win = { proposal_open_contract: { contract_id: 101, is_sold: 1, profit: 0.55 } };
    await f.emit(win);
    await f.emit(win);
    assert(f.state().pending);
    await f.emit({ proposal_open_contract: { contract_id: 102, is_sold: 1, profit: -0.35 } });
    assert.equal(f.state().pending, undefined);
    assert.equal(f.state().pnl, 20);
    assert.equal(f.state().pairs, 1);
    await f.scan();
    assert.equal(f.requests.filter(r => r.buy).length, 2, 'no repeat entry from the same tick');
});
test('a rejected second leg stops further entries while the bought leg remains tracked', async t => {
    const f = await fixture(t, { failure: { error: { code: 'InsufficientBalance' } } });
    await f.start();
    await f.scan();
    assert.equal(f.state().active, false);
    assert.deepEqual(
        f.state().pending.legs.map(l => l.status),
        ['open', 'rejected']
    );
    await f.emit({ proposal_open_contract: { contract_id: 101, is_sold: 1, profit: -0.35 } });
    assert.equal(f.state().pnl, -35);
    assert.equal(f.state().pending, undefined);
});
test('uncertain purchases stay journaled and block restarts; a late receipt can be reconciled', async t => {
    const f = await fixture(t, { failure: new Error('Request timed out') });
    await f.start();
    await f.scan();
    assert.equal(f.state().pending.legs[1].status, 'unknown');
    assert.equal((await f.request('start')).status, 409);
    const nonce = f.state().pending.nonce;
    await f.emit({
        buy: { contract_id: 102, buy_price: 0.35 },
        echo_req: { passthrough: { neto_pair: nonce, neto_leg: 1 } },
    });
    await spin(() => f.state().pending.legs[1].status === 'open');
    await f.emit({ proposal_open_contract: { contract_id: 101, is_sold: 1, profit: -0.35 } });
    await f.emit({ proposal_open_contract: { contract_id: 102, is_sold: 1, profit: 0.55 } });
    assert.equal(f.state().pending, undefined);
    assert.equal(f.state().active, false);
});
for (const option of ['stale', 'badPayout', 'lowBalance'])
    test(`${option} prevents both purchases`, async t => {
        const f = await fixture(t, { [option]: true });
        await f.start();
        await f.scan();
        assert.equal(f.requests.filter(r => r.buy).length, 0);
    });
test('logout after durable protection prevents dispatch and cancels only the unsent pair intent', async t => {
    const options = {};
    const f = await fixture(t, options);
    await f.start();
    const original = f.locks.protect.bind(f.locks);
    f.locks.protect = async (...args) => {
        await original(...args);
        options.revoked = true;
    };
    await f.scan();
    assert.equal(f.requests.filter(r => r.buy).length, 0);
    assert.equal((await f.locks.summary()).pending, 0);
});
test('STOP during startup cannot be overwritten by a late portfolio response', async t => {
    let release;
    const held = new Promise(r => {
        release = r;
    });
    const f = await fixture(t, { intercept: async b => (b.portfolio ? held : undefined) });
    await f.request('start');
    await spin(() => f.requests.some(r => r.portfolio));
    await f.request('stop');
    release({ portfolio: { contracts: [] } });
    await f.service.entries.get('DOT_TEST:analysis').startTask;
    assert.equal(f.state().active, false);
    assert.equal(f.requests.filter(r => r.buy).length, 0);
});
test('XML and analysis settings/history remain separate and cannot trade the account concurrently', async t => {
    const f = await fixture(t);
    await f.start();
    const xml = await f.request(undefined, 'xml');
    assert.equal(xml.value.source, 'xml');
    assert.equal(xml.value.active, false);
    assert.deepEqual(xml.value.history, []);
    await f.request('start', 'xml');
    await f.service.entries.get('DOT_TEST:xml').startTask;
    assert.equal(f.state('xml').active, false);
    assert.equal(f.state().active, true);
});
test('storage failure prevents both orders', async t => {
    const f = await fixture(t);
    await f.start();
    f.options.storageFails = true;
    await f.scan();
    assert.equal(f.requests.filter(r => r.buy).length, 0);
    assert.equal(f.state().active, false);
});

test('restored pending journals remain stopped and block new starts', async t => {
    const first = await fixture(t);
    await first.start();
    await first.scan();
    await first.service.close();
    const restored = await fixture(t, { records: first.records });
    const snapshot = await restored.request();
    assert.equal(snapshot.value.active, false);
    assert.equal(snapshot.value.pending.legs[0].id, 101);
    assert.equal((await restored.request('start')).status, 409);
    assert.equal(restored.requests.filter(r => r.buy).length, 0);
});

test('the combined pair cost is reserved against the remaining session loss budget before either buy', async t => {
    const f = await fixture(t);
    await f.start();
    f.state().pnl = -950;
    await f.scan();
    assert.equal(f.requests.filter(r => r.buy).length, 0);
    assert.equal(f.state().active, false);
    assert.match(f.state().message, /session stop loss/);
});
test('both legs can lose and the maximum-pair limit stops the next entry', async t => {
    const f = await fixture(t);
    await f.start();
    f.state().settings.maxPairs = 1;
    await f.scan();
    await f.emit({ proposal_open_contract: { contract_id: 101, is_sold: 1, profit: -0.35 } });
    await f.emit({ proposal_open_contract: { contract_id: 102, is_sold: 1, profit: -0.35 } });
    assert.equal(f.state().pnl, -70);
    assert.equal(f.state().pairs, 1);
    assert.equal(f.state().active, false);
    assert.equal(f.state().pending, undefined);
});

test('uses the new Higher/Lower codes and streaming proposal IDs when advertised by the provider', async t => {
    const f = await fixture(t, { newTypes: true });
    await f.start();
    await f.scan();
    const proposals = f.requests.filter(r => r.proposal);
    assert.deepEqual(
        proposals.map(r => r.contract_type),
        ['HIGHER', 'LOWER']
    );
    assert(proposals.every(r => r.subscribe === 1));
    assert.deepEqual(
        f.requests.filter(r => r.buy).map(r => r.buy),
        ['HIGHER', 'LOWER']
    );
    assert.equal(f.requests.filter(r => r.forget).length, 2);
});

test('STOP during an awaited authorization check cannot reactivate startup', async t => {
    let release,
        entered = false;
    const held = new Promise(r => {
        release = r;
    });
    const f = await fixture(t, {
        verify: async () => {
            entered = true;
            await held;
        },
    });
    await f.request('start');
    await spin(() => entered);
    await f.request('stop');
    release();
    await f.service.entries.get('DOT_TEST:analysis').startTask;
    assert.equal(f.state().active, false);
    assert.equal(f.requests.filter(r => r.buy).length, 0);
});

test('a cancelled XML attempt cannot start later or stop a newer XML session', async t => {
    const f = await fixture(t);
    await f.request('stop', 'xml', 'POST', f.auth.publicOrigin, 'cancelled');
    assert.equal((await f.request('start', 'xml', 'POST', f.auth.publicOrigin, 'cancelled')).status, 409);
    await f.request('start', 'xml', 'POST', f.auth.publicOrigin, 'current');
    await f.service.entries.get('DOT_TEST:xml').startTask;
    assert.equal(f.state('xml').active, true);
    await f.request('stop', 'xml', 'POST', f.auth.publicOrigin, 'cancelled');
    assert.equal(f.state('xml').active, true);
    await f.request('stop', 'xml', 'POST', f.auth.publicOrigin, 'current');
    assert.equal(f.state('xml').active, false);
});
test('the verified owner session can STOP during provider throttling without bypassing revocations', async t => {
    const options = { sid: 'owner' };
    const f = await fixture(t, options);
    await f.start();
    options.blockAccountRead = true;
    assert.equal((await f.request('stop')).status, 200);
    assert.equal(f.state().active, false);
    options.revoked = true;
    assert.equal((await f.request('stop')).status, 401);
    options.revoked = false;
    options.sid = 'other-session';
    assert.equal((await f.request('stop')).status, 429);
});
test('checks the first ready feed before slower subscriptions and discovers contract types only on demand', async t => {
    let release;
    const slow = new Promise(resolve => {
        release = resolve;
    });
    const f = await fixture(t, {
        intercept: async body => {
            if (body.active_symbols)
                return { active_symbols: ['R_100', 'R_50'].map(symbol => ({ symbol, exchange_is_open: 1 })) };
            if (body.ticks_history === 'R_50') await slow;
        },
    });
    await f.request('start');
    await spin(() => f.state()?.marketCount === 1);
    assert.equal(f.requests.filter(r => r.contracts_for).length, 0);
    await f.scan();
    assert.equal(f.requests.filter(r => r.buy).length, 2);
    assert.deepEqual(
        f.requests.filter(r => r.contracts_for).map(r => r.contracts_for),
        ['R_100']
    );
    release();
    await f.service.entries.get('DOT_TEST:analysis').startTask;
    assert.equal(f.state().marketCount, 2);
    await f.scan();
    assert.equal(f.requests.filter(r => r.buy).length, 2, 'warmup completion must not bypass a pending pair');
});
test('retains actual purchase prices, returns and both winning leg outcomes', async t => {
    const f = await fixture(t);
    await f.start();
    await f.scan();
    for (const contract_id of [101, 102])
        await f.emit({
            proposal_open_contract: { contract_id, is_sold: 1, profit: 0.55, sell_price: 0.9, buy_price: 0.35 },
        });
    const history = f.state().history[0];
    assert.equal(history.profit, 110);
    assert.deepEqual(
        history.legs.map(l => [l.id, l.profit, l.buyPrice, l.payout]),
        [
            [101, 55, 35, 90],
            [102, 55, 35, 90],
        ]
    );
});
