const { randomUUID } = require('node:crypto');
const { createBroker } = require('./strategy-broker.cjs');
const { DEFINITIVE } = require('./account-locks.cjs');
const { watchSessionExpiry } = require('./session-expiry.cjs');

const DEFAULTS = Object.freeze({ stake: 0.35, duration: 5, stopLoss: 10, takeProfit: 5, maxPairs: 10 });
function validateSettings(value = {}) {
    const s = Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, value[k] ?? DEFAULTS[k]]));
    const money = n =>
        Number.isFinite(n) &&
        n > 0 &&
        Number.isSafeInteger(Math.round(n * 100)) &&
        Math.abs(n * 100 - Math.round(n * 100)) < 1e-7;
    if (
        !money(s.stake) ||
        s.stake < 0.35 ||
        !money(s.stopLoss) ||
        s.stopLoss < s.stake * 2 ||
        !money(s.takeProfit) ||
        !Number.isInteger(s.duration) ||
        s.duration < 5 ||
        s.duration > 10 ||
        !Number.isInteger(s.maxPairs) ||
        s.maxPairs < 1 ||
        s.maxPairs > 100
    )
        throw Object.assign(
            new Error(
                'Use a stake of at least $0.35, a loss budget covering both stakes, 5–10 ticks, and 1–100 pairs.'
            ),
            { status: 400 }
        );
    if (value.symbol !== undefined) {
        if (typeof value.symbol !== 'string' || !/^(R_\d+|1HZ\d+V)$/.test(value.symbol))
            throw Object.assign(new Error('Invalid paired XML market.'), { status: 400 });
        s.symbol = value.symbol;
    }
    return s;
}
function signal(prices, duration = 5) {
    if (prices.length < 101 || prices.some(p => !Number.isFinite(p))) return 0;
    const changes = prices.slice(1).map((p, i) => p - prices[i]);
    const rms = xs => Math.sqrt(xs.reduce((n, x) => n + x * x, 0) / xs.length);
    const recent = rms(changes.slice(-20)),
        baseline = rms(changes.slice(0, -20));
    // A fixed one-point barrier needs actual price movement, not digit percentages.
    return recent > baseline * 1.2 && recent * Math.sqrt(duration) > 1.25 && Math.abs(changes.at(-1)) >= recent * 0.8
        ? recent
        : 0;
}
function quotePair(responses, settings, now = Date.now()) {
    const invalid = message => Object.assign(new Error(message), { code: 'PairQuoteUnavailable' });
    if (!Array.isArray(responses) || responses.length !== 2) throw invalid('Exactly two fresh quotes are required.');
    if (responses.some(r => typeof r.subscription?.id !== 'string' || !r.subscription.id))
        throw invalid('Streaming quotes are required.');
    const quotes = responses.map(r => r?.proposal);
    if (
        quotes.some(
            q =>
                !q ||
                typeof q.id !== 'string' ||
                !q.id ||
                !Number.isFinite(Number(q.ask_price)) ||
                Number(q.ask_price) <= 0 ||
                Math.round(Number(q.ask_price) * 100) !== Math.round(settings.stake * 100) ||
                !Number.isFinite(Number(q.payout)) ||
                !Number.isFinite(Number(q.spot_time)) ||
                now / 1000 - Number(q.spot_time) > 3 ||
                Number(q.spot_time) > now / 1000 + 2
        )
    )
        throw invalid('Both fresh stake quotes are required before buying a pair.');
    if (quotes[0].id === quotes[1].id) throw invalid('Distinct quotes are required for the two legs.');
    if (quotes[0].id === quotes[1].id) throw invalid('Distinct proposal IDs are required for both legs.');
    const cost = quotes.reduce((n, q) => n + Math.round(Number(q.ask_price) * 100), 0);
    if (quotes.some(q => Math.round(Number(q.payout) * 100) <= cost))
        throw invalid('A single winning payout would not cover both stakes. No pair purchased.');
    return { quotes, cost, minimumWinningNet: Math.min(...quotes.map(q => Math.round(Number(q.payout) * 100))) - cost };
}
function contractDisplay(previous, packet) {
    const view = { ...(previous || {}) };
    for (const key of [
        'contract_id',
        'contract_type',
        'shortcode',
        'underlying',
        'currency',
        'buy_price',
        'sell_price',
        'date_start',
        'date_expiry',
        'entry_tick_display_value',
        'entry_tick_time',
        'exit_tick_display_value',
        'exit_tick_time',
        'barrier',
        'high_barrier',
        'low_barrier',
        'tick_count',
    ]) {
        const value = packet[key];
        if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) view[key] = value;
    }
    if (packet.transaction_ids && typeof packet.transaction_ids === 'object') {
        view.transaction_ids = { ...view.transaction_ids };
        for (const key of ['buy', 'sell'])
            if (Number.isSafeInteger(packet.transaction_ids[key]) && packet.transaction_ids[key] > 0)
                view.transaction_ids[key] = packet.transaction_ids[key];
    }
    return view;
}
function pairedContractTypes(available, duration) {
    const supports = c => {
        if (c.barriers !== undefined && Number(c.barriers) !== 1) return false;
        if (
            c.min_contract_duration &&
            (!/^\d+t$/.test(c.min_contract_duration) || Number(c.min_contract_duration.slice(0, -1)) > duration)
        )
            return false;
        if (
            c.max_contract_duration &&
            /^\d+t$/.test(c.max_contract_duration) &&
            Number(c.max_contract_duration.slice(0, -1)) < duration
        )
            return false;
        return true;
    };
    return [
        ['HIGHER', 'CALL'],
        ['LOWER', 'PUT'],
    ].map(codes => codes.find(type => available.some(c => c.contract_type === type && supports(c))));
}
function createHigherLowerService(
    auth,
    {
        locks,
        storage,
        dispatcher,
        brokerFactory = url => createBroker(url, dispatcher),
        onTrade = () => {},
        onConnection = () => {},
        now = Date.now,
        schedule = setInterval,
        sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    } = {}
) {
    const entries = new Map();
    let closing = false;
    const key = (id, source = 'analysis') => `neto.${source === 'xml' ? 'higher-lower-xml' : 'higher-lower'}.v1.${id}`;
    const stateKey = e => key(e.state.accountId, e.state.source);
    const save = async e => {
        storage.setItem(stateKey(e), JSON.stringify(e.state));
        await storage.flush?.(stateKey(e));
    };
    const notify = (e, value) => {
        try {
            onTrade(e.state.accountId, value, e.state.source);
        } catch {}
    };
    async function entry(id, source) {
        const entryKey = id + ':' + source;
        if (entries.has(entryKey)) return entries.get(entryKey);
        if (entries.size >= 200) throw Object.assign(new Error('Higher/Lower capacity reached.'), { status: 503 });
        const e = {
            state: {
                version: 1,
                accountId: id,
                source,
                settings: { ...DEFAULTS },
                active: false,
                pnl: 0,
                pairs: 0,
                history: [],
                message: 'Ready. Demo accounts only.',
            },
            feeds: new Map(),
            busy: false,
            commands: Promise.resolve(),
        };
        entries.set(entryKey, e);
        e.ready = (async () => {
            await storage.load?.(key(id, source));
            const saved = storage.getItem(key(id, source));
            if (saved)
                e.state = {
                    ...JSON.parse(saved),
                    source,
                    active: false,
                    starting: false,
                    message: 'Stopped after reload. Refresh any pending contract status before starting.',
                };
        })();
        return e;
    }
    function halt(e, message) {
        e.cancelled = true;
        e.state.active = false;
        e.state.starting = false;
        e.state.message = message;
        clearInterval(e.timer);
        void save(e).catch(() => {});
        if (!e.busy && !e.state.pending) void cleanup(e);
    }
    async function cleanup(e) {
        e.expiry?.();
        e.expiry = undefined;
        e.subscription?.unsubscribe();
        e.subscription = undefined;
        if (e.broker) {
            const broker = e.broker;
            e.broker = undefined;
            broker.disconnect();
        }
        if (e.connectionKey) {
            try {
                onConnection(e.state.accountId, e.connectionKey, false);
            } catch {}
            e.connectionKey = undefined;
        }
        if (e.lease) {
            const lease = e.lease;
            e.lease = undefined;
            await locks.release(lease);
        }
    }
    async function finish(e) {
        const p = e.state.pending;
        if (!p || p.legs.some(l => !['settled', 'rejected'].includes(l.status))) return;
        if (!p.complete) {
            const profit = p.legs.reduce((n, l) => n + (l.profit || 0), 0);
            e.state.pnl += profit;
            e.state.pairs++;
            e.state.history = [
                {
                    symbol: p.symbol,
                    at: p.at,
                    profit,
                    legs: p.legs.map(l => ({
                        type: l.type,
                        id: l.id,
                        status: l.status,
                        profit: l.profit,
                        buyPrice: l.buyPrice,
                        payout: l.payout,
                        contract: l.contract,
                        tickCount: l.tickCount,
                        currentTick: l.currentTick,
                    })),
                },
                ...e.state.history,
            ].slice(0, 100);
            // Keep the durable group intent until both outcomes are known and saved.
            p.complete = true;
            await save(e);
        }
        if (e.lease) await locks.cancel(e.lease, p.nonce);
        else await locks.settledGroup(e.state.accountId, p.nonce);
        e.state.pending = undefined;
        if (
            e.state.pnl <= -Math.round(e.state.settings.stopLoss * 100) ||
            e.state.pnl >= Math.round(e.state.settings.takeProfit * 100) ||
            e.state.pairs >= e.state.settings.maxPairs
        )
            halt(e, 'Session risk or pair limit reached.');
        else if (e.state.active) e.state.message = 'Pair settled. Waiting for a fresh volatility expansion.';
        await save(e);
        if (!e.state.active && !e.busy) await cleanup(e);
    }
    async function contract(e, packet) {
        const p = e.state.pending;
        if (!p || p.complete) return;
        const c = packet.proposal_open_contract;
        const leg = c && p.legs.find(l => l.id === Number(c.contract_id));
        if (!leg || leg.status === 'settled') return;
        const before = JSON.stringify(leg);
        leg.contract = contractDisplay(leg.contract, c);
        if (Array.isArray(c.tick_stream)) {
            const epochs = new Set(
                c.tick_stream
                    .slice(-20)
                    .map(t => Number(t.epoch))
                    .filter(Number.isFinite)
            );
            const tick = Math.max(0, epochs.size - 1);
            leg.currentTick = Math.min(leg.tickCount || 10, Math.max(leg.currentTick || 0, tick));
        }
        if (![true, 1].includes(c.is_sold)) {
            if (JSON.stringify(leg) !== before) await save(e);
            return;
        }
        if (c.profit === undefined || c.profit === null || c.profit === '' || !Number.isFinite(Number(c.profit))) {
            halt(e, 'Settlement is unconfirmed. Refresh contract status in Reports.');
            return;
        }
        leg.status = 'settled';
        leg.profit = Math.round(Number(c.profit) * 100);
        if (
            leg.buyPrice === undefined &&
            c.buy_price !== undefined &&
            c.buy_price !== null &&
            Number.isFinite(Number(c.buy_price)) &&
            Number.isSafeInteger(Math.round(Number(c.buy_price) * 100)) &&
            Number(c.buy_price) >= 0
        )
            leg.buyPrice = Math.round(Number(c.buy_price) * 100);
        if (
            c.sell_price !== undefined &&
            c.sell_price !== null &&
            Number.isFinite(Number(c.sell_price)) &&
            Number.isSafeInteger(Math.round(Number(c.sell_price) * 100)) &&
            Number(c.sell_price) >= 0
        )
            leg.payout = Math.round(Number(c.sell_price) * 100);
        else if (
            leg.buyPrice !== undefined &&
            Number.isSafeInteger(leg.buyPrice + leg.profit) &&
            leg.buyPrice + leg.profit >= 0
        )
            leg.payout = leg.buyPrice + leg.profit;
        await save(e);
        notify(e, c);
        await finish(e);
    }
    function queue(e, action) {
        const task = (e.events = (e.events || Promise.resolve()).then(action));
        e.events = task.catch(() => {
            halt(e, 'Contract journal unavailable. No new entries; check Reports.');
        });
        return task;
    }
    async function receipt(e, data, index, nonce) {
        let monitor;
        const id = Number(data.buy?.contract_id);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Unconfirmed purchase');
        await queue(e, async () => {
            const p = e.state.pending;
            if (!p || p.nonce !== nonce || ![0, 1].includes(index)) return;
            const leg = p.legs[index];
            if (leg.id) {
                if (leg.id !== id) throw new Error('Conflicting purchase receipt');
                return;
            }
            leg.id = id;
            leg.status = 'open';
            leg.contract = contractDisplay(leg.contract, {
                contract_id: id,
                buy_price: data.buy.buy_price,
                date_start: data.buy.start_time,
                transaction_ids: { buy: data.buy.transaction_id },
            });
            const paid = Number(data.buy.buy_price);
            if (
                data.buy.buy_price !== undefined &&
                Number.isFinite(paid) &&
                paid >= 0 &&
                Number.isSafeInteger(Math.round(paid * 100))
            )
                leg.buyPrice = Math.round(paid * 100);
            await save(e);
            notify(e, data.buy);
            monitor = e.broker;
        });
        if (monitor) {
            const packet = await monitor.send({ proposal_open_contract: 1, contract_id: id, subscribe: 1 });
            await queue(e, () => contract(e, packet));
        }
    }
    async function connect(e, req) {
        const b = await brokerFactory(await auth.connectionUrl(req, e.state.accountId));
        e.broker = b;
        e.connectionKey = randomUUID();
        try {
            onConnection(e.state.accountId, e.connectionKey, true);
        } catch {}
        const connectionKey = e.connectionKey;
        b.connection?.addEventListener('close', () => {
            try {
                onConnection(e.state.accountId, connectionKey, false);
            } catch {}
            if (e.connectionKey === connectionKey) e.connectionKey = undefined;
            if (e.broker === b) {
                e.broker = undefined;
                e.subscription?.unsubscribe();
                e.subscription = undefined;
                halt(e, 'Connection lost. No new entries. Refresh pending contracts before restarting.');
            }
        });
        e.subscription = b.onMessage().subscribe(({ data }) => {
            if (data.tick && e.feeds.has(data.tick.symbol)) {
                const f = e.feeds.get(data.tick.symbol),
                    epoch = Number(data.tick.epoch),
                    price = Number(data.tick.quote);
                if (epoch > f.epoch && Number.isFinite(price)) {
                    f.prices = [...f.prices, price].slice(-101);
                    f.epoch = epoch;
                }
            }
            const meta = data.echo_req?.passthrough || data.passthrough;
            if (data.buy && meta?.neto_pair)
                void receipt(e, data, meta.neto_leg, meta.neto_pair).catch(() =>
                    halt(e, 'Purchase receipt needs reconciliation. Check Reports.')
                );
            if (data.proposal_open_contract) void queue(e, () => contract(e, data)).catch(() => {});
        });
        return b;
    }
    async function pair(e, req, market) {
        if (e.busy || !e.state.active || e.state.pending) return;
        e.busy = true;
        let protectedNonce,
            sent = false;
        const quoteSubscriptions = [];
        const quoteBroker = e.broker;
        try {
            const s = e.state.settings,
                b = e.broker;
            let types = e.feeds.get(market.symbol)?.types;
            if (!types) {
                const discovered = await b.send({ contracts_for: market.symbol });
                types = pairedContractTypes(discovered.contracts_for?.available || [], s.duration);
                const feed = e.feeds.get(market.symbol);
                if (types.some(type => !type)) {
                    if (feed) feed.supported = false;
                    if (s.symbol)
                        halt(
                            e,
                            'The selected market does not support these paired contracts and duration. Choose another market.'
                        );
                    else
                        e.state.message = `Skipped ${market.symbol}: this duration is unavailable. Checking other live markets.`;
                    return;
                }
                if (feed) {
                    feed.types = types;
                    feed.supported = true;
                }
            }
            const quoted = await Promise.allSettled(
                types.map((type, i) =>
                    b
                        .send({
                            proposal: 1,
                            subscribe: 1,
                            amount: s.stake,
                            basis: 'stake',
                            currency: 'USD',
                            contract_type: type,
                            symbol: market.symbol,
                            duration: s.duration,
                            duration_unit: 't',
                            barrier: i ? '-1' : '+1',
                        })
                        .then(response => {
                            if (response.subscription?.id) quoteSubscriptions.push(response.subscription.id);
                            return response;
                        })
                )
            );
            const failedQuote = quoted.find(r => r.status === 'rejected');
            if (failedQuote) throw failedQuote.reason;
            const replies = quoted.map(r => r.value);
            const quotes = quotePair(replies, s, now());
            if (e.state.pnl - quotes.cost < -Math.round(s.stopLoss * 100)) {
                halt(e, 'The next pair would exceed the session stop loss.');
                return;
            }
            const balance = await b.send({ balance: 1 });
            if (
                balance.balance?.currency !== 'USD' ||
                !Number.isFinite(Number(balance.balance?.balance)) ||
                Math.round(Number(balance.balance.balance) * 100) < quotes.cost
            ) {
                halt(e, 'Available balance cannot cover both stakes.');
                return;
            }
            if (!e.state.active || closing) return;
            await auth.verifySession(req);
            if (!e.state.active || closing || e.cancelled) return;
            auth.requireTerms(req);
            const qualifies = () => {
                const feed = e.feeds.get(market.symbol);
                return (
                    feed &&
                    feed.epoch <= now() / 1000 + 2 &&
                    now() / 1000 - feed.epoch <= 6 &&
                    signal(feed.prices, s.duration) > 0
                );
            };
            if (!qualifies()) return;
            const nonce = randomUUID();
            await locks.protect(e.lease, nonce);
            protectedNonce = nonce;
            e.state.pending = {
                nonce,
                symbol: market.symbol,
                at: now(),
                cost: quotes.cost,
                minimumWinningNet: quotes.minimumWinningNet,
                legs: types.map(type => ({ type, status: 'intent', tickCount: s.duration })),
            };
            await save(e);
            await locks.heartbeat();
            await auth.verifySession(req);
            if (!e.state.active || closing || e.lease.lost || !qualifies()) return;
            quotePair(replies, s, now());
            // No await between dispatches. The broker still processes two separate orders.
            sent = true;
            e.lastEntries.set(market.symbol, market.epoch);
            e.state.message = 'Pair submitted. Waiting for both purchase confirmations.';
            const results = await Promise.allSettled(
                quotes.quotes.map((q, i) =>
                    b
                        .send({ buy: q.id, price: Number(q.ask_price), passthrough: { neto_pair: nonce, neto_leg: i } })
                        .then(response => receipt(e, response, i, nonce))
                )
            );
            await queue(e, async () => {
                const p = e.state.pending;
                if (!p) return;
                results.forEach((result, i) => {
                    if (result.status === 'rejected' && p.legs[i].status === 'intent')
                        p.legs[i].status = DEFINITIVE.has(result.reason?.error?.code) ? 'rejected' : 'unknown';
                });
                if (results.some(r => r.status === 'rejected'))
                    halt(
                        e,
                        'One or both legs failed or are uncertain. New entries stopped; check both contracts in Reports.'
                    );
                await save(e);
                await finish(e);
            });
        } catch (error) {
            if (
                !sent &&
                !protectedNonce &&
                ![401, 403].includes(error.status) &&
                !['RateLimit', 'TooManyRequests', 'AuthorizationRequired', 'InvalidToken', 'PermissionDenied'].includes(
                    error.error?.code
                ) &&
                e.state.active &&
                (error.code === 'PairQuoteUnavailable' ||
                    [
                        'InvalidContractProposal',
                        'ContractCreationFailure',
                        'InputValidationFailed',
                        'InvalidContractType',
                    ].includes(error.error?.code))
            ) {
                const feed = e.feeds.get(market.symbol);
                if (feed) feed.retryAt = now() + 30000;
                e.state.message = `Skipped ${market.symbol}: compatible fresh pair quotes are unavailable. Scanning other markets.`;
            } else
                halt(
                    e,
                    sent
                        ? 'Pair outcome uncertain. Check Reports and refresh contract status; purchases will not be retried.'
                        : 'Pair preflight failed or this market does not support these quotes. No orders submitted.'
                );
        } finally {
            await Promise.allSettled(quoteSubscriptions.map(id => quoteBroker.send({ forget: id })));
            if (!sent && protectedNonce) {
                await locks.cancel(e.lease, protectedNonce).catch(() => {});
                e.state.pending = undefined;
                await save(e).catch(() => {});
            }
            e.busy = false;
            if (!e.state.active && !e.state.pending) await cleanup(e);
        }
    }
    async function start(e, req, settings) {
        if (closing || e.busy || e.state.active || e.state.pending)
            throw Object.assign(new Error('Stop and settle the existing session first.'), { status: 409 });
        const s = validateSettings(settings);
        e.busy = true;
        e.bootBusy = true;
        e.cancelled = false;
        e.ownerSid = auth.sessionIdentity?.(req);
        e.state.starting = true;
        try {
            e.lease = await locks.claim(e.state.accountId, {
                mode: e.state.source === 'xml' ? 'higher_lower_xml' : 'higher_lower',
            });
            locks.hold(e.lease, {
                onLost: () => halt(e, 'Account lock lost. No new entries.'),
                onStop: () => halt(e, 'Session stopped.'),
            });
            const b = await connect(e, req);
            const portfolio = await b.send({ portfolio: 1 });
            if (!Array.isArray(portfolio.portfolio?.contracts) || portfolio.portfolio.contracts.length)
                throw new Error('Settle existing account contracts before starting a pair.');
            if (closing || e.cancelled || e.lease.lost) throw new Error('Startup cancelled.');
            await auth.verifySession(req);
            if (closing || e.cancelled || e.lease.lost) throw new Error('Startup cancelled.');
            e.state = {
                ...e.state,
                settings: s,
                starting: false,
                active: true,
                pnl: 0,
                pairs: 0,
                history: [],
                message: 'Subscribing to supported Volatility feeds. No trades until setup completes.',
            };
            await save(e);
            e.expiry = watchSessionExpiry(
                () => auth.sessionExpires(req),
                () => halt(e, 'Authorization expired. No new entries.')
            );
            const discovery = await b.send({ active_symbols: 'brief' });
            const markets = (discovery.active_symbols || [])
                .filter(
                    m =>
                        /^(R_\d+|1HZ\d+V)$/.test(m.symbol) &&
                        m.exchange_is_open &&
                        !m.is_trading_suspended &&
                        (!s.symbol || s.symbol === m.symbol)
                )
                .slice(0, 50);
            e.feeds.clear();
            e.lastEntries = new Map();
            e.state.marketCount = 0;
            e.state.scanTotal = markets.length;
            clearInterval(e.timer);
            e.timer = undefined;
            let scanStarted = false;
            const scan = () => {
                if (!e.state.active || e.busy || e.state.pending) return;
                const ranked = [...e.feeds.values()]
                    .filter(
                        f =>
                            f.supported !== false &&
                            (!e.lastEntries.has(f.symbol) || f.epoch > e.lastEntries.get(f.symbol)) &&
                            (!f.retryAt || f.retryAt <= now()) &&
                            f.epoch <= now() / 1000 + 2 &&
                            now() / 1000 - f.epoch <= 6
                    )
                    .map(f => ({ ...f, score: signal(f.prices, s.duration) }))
                    .filter(f => f.score > 0)
                    .sort((a, b) => b.score - a.score);
                if (ranked[0]) e.task = pair(e, req, ranked[0]).catch(() => halt(e, 'Pair stopped. Check Reports.'));
            };
            let index = 0,
                nextSlot = now();
            const worker = async () => {
                while (index < markets.length && e.state.active) {
                    const market = markets[index++];
                    const pause = Math.max(0, nextSlot - now());
                    nextSlot = Math.max(nextSlot, now()) + 125;
                    if (pause) await sleep(pause);
                    if (!e.state.active) return;
                    let response;
                    try {
                        response = await b.send({
                            ticks_history: market.symbol,
                            count: 101,
                            end: 'latest',
                            style: 'ticks',
                            subscribe: 1,
                        });
                    } catch (error) {
                        if (['MarketIsClosed', 'TradingSuspended', 'InvalidSymbol'].includes(error.error?.code))
                            continue;
                        throw error;
                    }
                    if (!e.state.active || !Array.isArray(response.history?.prices)) continue;
                    e.feeds.set(market.symbol, {
                        symbol: market.symbol,
                        prices: response.history.prices.map(Number).slice(-101),
                        epoch: Number(response.history.times?.at(-1)),
                    });
                    e.state.marketCount = e.feeds.size;
                    if (!scanStarted) {
                        scanStarted = true;
                        if (e.bootBusy) {
                            e.bootBusy = false;
                            e.busy = false;
                        }
                        e.timer = schedule(scan, 250);
                        e.timer.unref?.();
                    }
                    if (!e.state.pending && !e.busy)
                        e.state.message = `Watching live price expansion · ${e.feeds.size}/${markets.length} feeds ready. Quotes are checked only for qualifying candidates.`;
                }
            };
            await Promise.all(Array.from({ length: Math.min(4, markets.length) }, worker));
            if (!e.state.active) return;
            if (!e.feeds.size) throw new Error('No compatible Volatility feeds are available.');
            await save(e);
        } catch (error) {
            halt(e, error.message || 'Startup failed.');
            throw error;
        } finally {
            if (e.bootBusy) {
                e.bootBusy = false;
                e.busy = false;
            }
            if (!e.state.active && !e.state.pending) await cleanup(e);
        }
    }
    async function handle(req, res) {
        const json = (status, value) => {
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(value));
        };
        try {
            if (!['GET', 'POST'].includes(req.method)) return json(405, { error: 'Method not allowed.' });
            if (req.method === 'POST' && req.headers.origin !== auth.publicOrigin)
                return json(403, { error: 'Invalid origin.' });
            const params = new URL(req.url, auth.publicOrigin).searchParams;
            const id = params.get('account_id');
            const source = params.get('source') || 'analysis';
            if (!['analysis', 'xml'].includes(source))
                throw Object.assign(new Error('Invalid runner.'), { status: 400 });
            if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
                throw Object.assign(new Error('Select an account.'), { status: 400 });
            let body;
            if (req.method === 'POST') {
                let raw = '';
                for await (const chunk of req) {
                    raw += chunk;
                    if (Buffer.byteLength(raw) > 8192)
                        throw Object.assign(new Error('Request too large.'), { status: 413 });
                }
                try {
                    body = JSON.parse(raw);
                } catch {
                    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
                }
                if (!body || typeof body !== 'object' || Array.isArray(body))
                    throw Object.assign(new Error('Invalid command.'), { status: 400 });
            }
            const existing = entries.get(id + ':' + source);
            let e;
            if (body?.command === 'stop' && existing?.ownerSid && auth.sessionIdentity?.(req) === existing.ownerSid) {
                // Stop remains available during provider REST cooldowns; signed
                // ownership plus a fresh revocation check is still mandatory.
                await auth.verifySession(req);
                e = existing;
            } else {
                const account = await auth.authorizeAccount(req, id);
                if (account.account_type !== 'demo' || account.currency !== 'USD')
                    return json(403, { error: 'Higher/Lower is available only on USD demo accounts.' });
                e = await entry(id, source);
            }
            await e.ready;
            if (req.method === 'GET') return json(200, { ...e.state, busy: e.busy });
            if (body.command !== 'stop') auth.requireTerms(req);
            // STOP is immediate even when startup or quoting is awaiting the provider.
            if (body.command === 'stop') {
                if (typeof body.attempt === 'string' && body.attempt.length <= 100) {
                    e.cancelledAttempts ||= new Set();
                    e.cancelledAttempts.add(body.attempt);
                    if (e.cancelledAttempts.size > 20)
                        e.cancelledAttempts.delete(e.cancelledAttempts.values().next().value);
                }
                if (body.attempt && (e.state.active || e.state.starting || e.busy) && e.activeAttempt !== body.attempt)
                    return json(200, { ...e.state, busy: e.busy });
                halt(e, 'Stopped. Existing contracts remain monitored.');
                return json(200, { ...e.state, busy: e.busy });
            }
            if (body.command === 'start') {
                if (body.attempt && e.cancelledAttempts?.has(body.attempt))
                    throw Object.assign(new Error('XML startup was cancelled.'), { status: 409 });
                if (e.busy || e.state.active || e.state.pending)
                    throw Object.assign(new Error('Stop and settle the existing session first.'), { status: 409 });
                const settings = validateSettings(body.settings);
                e.activeAttempt = typeof body.attempt === 'string' ? body.attempt : undefined;
                e.startTask = start(e, req, settings).catch(() => {});
                return json(200, { ...e.state, busy: e.busy });
            }
            if (body.command === 'refresh') {
                if (e.busy || e.state.active)
                    throw Object.assign(new Error('Stop the session before reconciliation.'), { status: 409 });
                if (e.state.pending) {
                    e.busy = true;
                    try {
                        const b = e.broker || (await connect(e, req));
                        for (const leg of e.state.pending.legs)
                            if (leg.id && leg.status !== 'settled')
                                await queue(e, async () =>
                                    contract(e, await b.send({ proposal_open_contract: 1, contract_id: leg.id }))
                                );
                        await finish(e);
                        if (e.state.pending)
                            e.state.message =
                                'Pending or unknown purchase remains. Check Reports; no restart or automatic retry is permitted.';
                        await save(e);
                    } finally {
                        e.busy = false;
                        if (!e.state.pending) await cleanup(e);
                    }
                }
                return json(200, { ...e.state, busy: e.busy });
            }
            return json(400, { error: 'Unknown command.' });
        } catch (error) {
            if (error.status === 429 && error.retryAfter) res.setHeader?.('Retry-After', String(error.retryAfter));
            return json(error.status || 400, {
                ...(error.status === 429 && error.retryAfter ? { retryAfter: error.retryAfter } : {}),
                error: error.status
                    ? error.message
                    : 'Higher/Lower request failed. No new entries; check Reports if a purchase was pending.',
            });
        }
    }
    return {
        handle,
        entries,
        async close() {
            closing = true;
            for (const e of entries.values()) {
                halt(e, 'Server shutting down. Check pending contracts before restarting.');
                await e.startTask?.catch(() => {});
                await e.task?.catch(() => {});
                await e.events?.catch(() => {});
                await save(e);
                await cleanup(e);
            }
            await storage.close?.();
        },
    };
}
module.exports = { createHigherLowerService, validateSettings, signal, quotePair, DEFAULTS };
