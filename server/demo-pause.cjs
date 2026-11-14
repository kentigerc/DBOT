const { createHash, randomUUID } = require('node:crypto');
const { DEFINITIVE } = require('./account-locks.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => Object.assign(new Error(message), { status: 409 });
const cents = value => {
    const number = Number(value),
        result = Math.round(number * 100);
    if (!Number.isFinite(number) || !Number.isSafeInteger(result) || Math.abs(number * 100 - result) > 1e-6)
        throw fail('Invalid demo contract amount. Real recovery remains paused.');
    return result;
};
function validate(spec) {
    if (spec?.contract !== undefined) {
        const contract = spec.contract;
        if (
            Object.keys(spec).some(key => !['triggerContractId', 'stake', 'contract'].includes(key)) ||
            !Number.isSafeInteger(spec.triggerContractId) ||
            spec.triggerContractId <= 0 ||
            typeof spec.stake !== 'number' ||
            cents(spec.stake) < 35 ||
            cents(spec.stake) > 100000000 ||
            !contract ||
            typeof contract !== 'object' ||
            Array.isArray(contract) ||
            Object.keys(contract).some(
                key =>
                    ![
                        'symbol',
                        'contract_type',
                        'duration',
                        'duration_unit',
                        'date_expiry',
                        'barrier',
                        'barrier2',
                        'selected_tick',
                    ].includes(key)
            ) ||
            !/^[A-Za-z0-9_.-]{1,80}$/.test(contract.symbol || '') ||
            !/^[A-Z][A-Z0-9_]{0,31}$/.test(contract.contract_type || '') ||
            ['MULTUP', 'MULTDOWN', 'ACCU'].includes(contract.contract_type)
        )
            throw fail('This bot contract cannot use an automatic demo pause. Real trading remains paused.');
        if (contract.date_expiry !== undefined) {
            if (
                contract.duration !== undefined ||
                contract.duration_unit !== undefined ||
                !Number.isSafeInteger(contract.date_expiry) ||
                contract.date_expiry * 1000 <= Date.now() ||
                contract.date_expiry * 1000 > Date.now() + 366 * 86400000
            )
                throw fail('Invalid demo contract expiry. Real trading remains paused.');
        } else {
            const units = { t: 2, s: 1, m: 60, h: 3600, d: 86400 };
            if (
                !Object.hasOwn(units, contract.duration_unit) ||
                !Number.isSafeInteger(contract.duration) ||
                contract.duration < 1 ||
                contract.duration * units[contract.duration_unit] > 366 * 86400
            )
                throw fail('A finite demo contract duration is required. Real trading remains paused.');
        }
        for (const key of ['barrier', 'barrier2'])
            if (contract[key] !== undefined && !/^[+-]?\d+(?:\.\d+)?$/.test(String(contract[key])))
                throw fail('Invalid demo contract barrier. Real trading remains paused.');
        if (
            contract.selected_tick !== undefined &&
            (!Number.isSafeInteger(contract.selected_tick) || contract.selected_tick < 1 || contract.selected_tick > 10)
        )
            throw fail('Invalid demo tick selection. Real trading remains paused.');
        return;
    }
    if (
        !spec ||
        typeof spec !== 'object' ||
        Array.isArray(spec) ||
        Object.keys(spec).some(
            key => !['triggerContractId', 'symbol', 'direction', 'barrier', 'duration', 'stake'].includes(key)
        ) ||
        !Number.isSafeInteger(spec.triggerContractId) ||
        spec.triggerContractId <= 0 ||
        !/^(R_\d+|1HZ\d+V)$/.test(spec.symbol || '') ||
        !['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER'].includes(spec.direction) ||
        (['DIGITOVER', 'DIGITUNDER'].includes(spec.direction) && !/^[0-9]$/.test(String(spec.barrier))) ||
        !Number.isInteger(spec.duration) ||
        spec.duration < 1 ||
        spec.duration > 5 ||
        typeof spec.stake !== 'number' ||
        cents(spec.stake) < 35 ||
        cents(spec.stake) > 100000000
    )
        throw fail('Invalid demo pause settings. Real recovery remains paused.');
}

// A separate, durable demo journal. No demo order is sent through a real broker,
// and the real engine's stake, loss streak and P/L never change here.
function createDemoPause({
    auth,
    storage,
    locks,
    brokerFactory,
    busy = () => false,
    onTrade = () => {},
    now = Date.now,
    wait = sleep,
}) {
    const running = new Map();
    const reservedDemo = new Map();
    const identity = realId => `DEMO_PAUSE_${createHash('sha256').update(realId).digest('hex').slice(0, 48)}`;
    const key = realId => `neto.digit-strategy.v1.${identity(realId)}`;
    const read = async realId => {
        await storage.load?.(key(realId));
        const text = storage.peek ? await storage.peek(key(realId)) : storage.getItem(key(realId));
        return text ? JSON.parse(text) : null;
    };
    const save = async (realId, state, progress) => {
        storage.setItem(key(realId), JSON.stringify(state));
        await storage.flush?.(key(realId));
        progress?.(publicState(state));
    };
    const publicState = state =>
        state
            ? {
                  triggerContractId: state.triggerContractId,
                  demoAccountId: state.demoAccountId,
                  status: state.status,
                  completed: state.completed,
                  wins: state.wins || 0,
                  pendingContractId: state.pending?.contractId,
                  trades: state.trades,
                  error: state.error || '',
              }
            : null;
    async function run(req, real, spec, { signal, parentLease, progress, sourceTool = 'analysis_tool' } = {}) {
        validate(spec);
        if (real.account_type !== 'real' || real.currency !== 'USD')
            throw fail('Demo pauses are only used for real USD trading.');
        if (running.has(real.account_id)) throw fail('This account already has a demo pause in progress.');
        const marker = {};
        marker.done = new Promise(resolve => {
            marker.finish = resolve;
        });
        running.set(real.account_id, marker);
        let state, demoLease, realLease, broker;
        let stopped = signal?.aborted || false;
        const stop = () => {
            stopped = true;
        };
        marker.stop = stop;
        signal?.addEventListener('abort', stop, { once: true });
        const check = async () => {
            await auth.verifySession?.(req);
            if (stopped || realLease?.lost || parentLease?.lost || demoLease?.lost)
                throw fail('Demo pause stopped. Real recovery remains paused.');
        };
        try {
            if (!parentLease) {
                if (await busy(real.account_id))
                    throw fail('Stop and settle the other real-account trading session first.');
                realLease = await locks.claim(real.account_id, { mode: 'analysis' });
                locks.hold(realLease, { onLost: stop, onStop: stop });
            }
            // Status reads may have cached an older revision from another
            // instance. Refresh only after obtaining the real account lease.
            await storage.reload?.(key(real.account_id));
            state = await read(real.account_id);
            const completedTriggers = state?.completionRule === 'first_win' ? state.completedTriggers || [] : [];
            if (completedTriggers.includes(spec.triggerContractId))
                return {
                    ...publicState(state),
                    triggerContractId: spec.triggerContractId,
                    completed: state.triggerContractId === spec.triggerContractId ? state.completed : 1,
                    wins: 1,
                    status: 'done',
                };
            if (state?.pending && state.triggerContractId !== spec.triggerContractId)
                throw fail('Resolve the previous demo pause before starting another. Real recovery remains paused.');
            const demo = await auth.demoAccount(req);
            if (demo.account_type !== 'demo' || demo.currency !== 'USD' || demo.account_id === real.account_id)
                throw fail('A separate USD demo account is required.');
            if (await busy(demo.account_id))
                throw fail('The demo account is already trading. Stop its other bot before continuing.');
            if (reservedDemo.has(demo.account_id))
                throw fail('The demo account is already serving another recovery pause.');
            reservedDemo.set(demo.account_id, marker);
            marker.demoAccountId = demo.account_id;
            if (!state || state.triggerContractId !== spec.triggerContractId)
                state = {
                    version: 1,
                    accountId: identity(real.account_id),
                    realAccountId: real.account_id,
                    triggerContractId: spec.triggerContractId,
                    demoAccountId: demo.account_id,
                    spec: { ...spec },
                    completed: 0,
                    wins: 0,
                    completionRule: 'first_win',
                    trades: [],
                    completedTriggers,
                    status: 'running',
                };
            if (state.demoAccountId !== demo.account_id)
                throw fail('The original demo account is unavailable. Real recovery remains paused.');
            // Two completed trades from an older deployment do not establish a win.
            // Preserve its settlements and pending order while migrating the completion rule.
            if (state.completionRule !== 'first_win') {
                state.wins = state.trades.some(trade => trade.profit > 0) ? 1 : 0;
                state.completedTriggers = [];
                state.completionRule = 'first_win';
            }
            if (state.pending && !state.pending.contractId)
                throw fail(
                    'Demo purchase is unconfirmed. Check demo account history before resuming; no duplicate order will be sent.'
                );
            await check();
            demoLease = await locks.claim(demo.account_id, {
                mode: 'analysis',
                reconcile: state.pending ? [state.pending.nonce] : [],
            });
            locks.hold(demoLease, { onLost: stop, onStop: stop });
            broker = await brokerFactory(await auth.connectionUrl(req, demo.account_id));
            state.status = 'running';
            state.error = '';
            const complete = () => {
                state.status = 'done';
                state.completedTriggers = [...new Set([...state.completedTriggers, spec.triggerContractId])].slice(
                    -1000
                );
            };
            if (state.wins >= 1 && !state.pending) complete();
            await save(real.account_id, state, progress);
            while (state.wins < 1 || state.pending) {
                if (!state.pending) {
                    await check();
                    const config = state.spec;
                    const balance = (await broker.send({ balance: 1 })).balance;
                    if (balance?.currency !== 'USD' || cents(balance.balance) < cents(config.stake))
                        throw fail('Insufficient demo balance. Real recovery remains paused.');
                    const parameters = config.contract
                        ? {
                              ...config.contract,
                              amount: config.stake,
                              basis: 'stake',
                              currency: 'USD',
                          }
                        : {
                              amount: config.stake,
                              basis: 'stake',
                              currency: 'USD',
                              duration: config.duration,
                              duration_unit: 't',
                              symbol: config.symbol,
                              contract_type: config.direction,
                              ...(['DIGITOVER', 'DIGITUNDER'].includes(config.direction)
                                  ? { barrier: String(config.barrier) }
                                  : {}),
                          };
                    const proposal = (await broker.send({ proposal: 1, ...parameters })).proposal;
                    if (
                        !proposal ||
                        cents(proposal.ask_price) !== cents(config.stake) ||
                        cents(proposal.payout) < cents(config.stake)
                    )
                        throw fail('Invalid demo quote. Real recovery remains paused.');
                    await check();
                    state.pending = {
                        nonce: randomUUID(),
                        stake: cents(config.stake),
                        payout: cents(proposal.payout),
                        at: now(),
                    };
                    await save(real.account_id, state, progress); // Durable intent precedes every demo purchase.
                    try {
                        await locks.protect(demoLease, state.pending.nonce);
                    } catch (error) {
                        state.pending = undefined;
                        await save(real.account_id, state, progress);
                        throw error;
                    }
                    try {
                        // Intent commits and shared protection may outlive logout,
                        // expiry or lease loss. Recheck immediately before sending.
                        await check();
                    } catch (error) {
                        await locks.cancel(demoLease, state.pending.nonce);
                        state.pending = undefined;
                        await save(real.account_id, state, progress);
                        throw error;
                    }
                    let response;
                    try {
                        response = await broker.send({
                            buy: 1,
                            price: config.stake,
                            parameters,
                            passthrough: { neto_order_id: state.pending.nonce },
                        });
                    } catch (error) {
                        if (DEFINITIVE.has(error.error?.code || error.code)) {
                            await locks.cancel(demoLease, state.pending.nonce);
                            state.pending = undefined;
                            await save(real.account_id, state, progress);
                        }
                        throw error;
                    }
                    const id = Number(response.buy?.contract_id);
                    if (!Number.isSafeInteger(id) || id <= 0)
                        throw fail('Demo purchase outcome is unconfirmed. Real recovery remains paused.');
                    state.pending.contractId = id;
                    await save(real.account_id, state, progress);
                    await locks.acknowledge(demoLease, state.pending.nonce, id);
                    try {
                        onTrade(demo, sourceTool, response.buy);
                    } catch {}
                }
                // STOP blocks subsequent demo orders; an already purchased contract still settles.
                const pending = state.pending;
                const config = state.spec.contract;
                const durationSeconds = config
                    ? config.date_expiry
                        ? 0
                        : config.duration * { t: 2, s: 1, m: 60, h: 3600, d: 86400 }[config.duration_unit]
                    : state.spec.duration * 2;
                const deadline = Math.max(
                    now() + 90000,
                    config?.date_expiry
                        ? config.date_expiry * 1000 + 90000
                        : pending.at + durationSeconds * 1000 + 90000
                );
                let contract;
                do {
                    contract = (await broker.send({ proposal_open_contract: 1, contract_id: pending.contractId }))
                        .proposal_open_contract;
                    if (Number(contract?.contract_id) !== pending.contractId)
                        throw fail('Demo settlement did not match its purchase.');
                    if ([1, true].includes(contract.is_sold)) break;
                    // Imported bots may use long expiries. A stop/revocation must
                    // release the worker while preserving its confirmed demo order
                    // for reconciliation, rather than polling until that expiry.
                    if (config) await check();
                    if (now() > deadline) throw fail('Demo contract has not settled. Real recovery remains paused.');
                    await wait(500);
                } while (true);
                const profit = cents(contract.profit);
                if (profit < -pending.stake || profit > pending.payout - pending.stake)
                    throw fail('Demo settlement is outside the purchased contract bounds.');
                state.trades.push({ contractId: pending.contractId, profit, stake: pending.stake, at: now() });
                state.trades = state.trades.slice(-100);
                state.completed++;
                if (profit > 0) state.wins = 1;
                state.pending = undefined;
                if (state.wins >= 1) complete();
                await save(real.account_id, state, progress);
                await locks.acknowledge(demoLease, pending.nonce, pending.contractId, true);
                await locks.settled(demo.account_id, pending.contractId);
                try {
                    onTrade(demo, sourceTool, contract);
                } catch {}
                if (stopped) throw fail('Demo pause stopped. Real recovery remains paused.');
            }
            return publicState(state);
        } catch (error) {
            if (state?.triggerContractId === spec.triggerContractId) {
                state.status = stopped ? 'stopped' : 'blocked';
                state.error = error.status ? error.message : 'Demo pause interrupted. Real recovery remains paused.';
                await save(real.account_id, state, progress).catch(() => {});
            }
            throw error.status ? error : fail('Demo pause interrupted. Real recovery remains paused.');
        } finally {
            signal?.removeEventListener('abort', stop);
            broker?.disconnect();
            if (demoLease) await locks.release(demoLease).catch(() => {});
            if (realLease) await locks.release(realLease).catch(() => {});
            if (running.get(real.account_id) === marker) running.delete(real.account_id);
            if (reservedDemo.get(marker.demoAccountId) === marker) reservedDemo.delete(marker.demoAccountId);
            marker.finish();
        }
    }
    return {
        run,
        status: async (realId, trigger) => {
            const state = await read(realId);
            return state?.triggerContractId === trigger ? publicState(state) : null;
        },
        busy: id => running.has(id) || reservedDemo.has(id),
        stop: id => (running.get(id) || reservedDemo.get(id))?.stop(),
        stopAll: () => {
            for (const marker of running.values()) marker.stop();
        },
        close: async () => {
            const jobs = [...running.values()];
            for (const marker of jobs) marker.stop();
            await Promise.allSettled(jobs.map(marker => marker.done));
        },
    };
}
module.exports = { createDemoPause };
