// Offline benchmark: injected fake brokers and loopback HTTP only. Never contacts Deriv or Render.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const seconds = Number(args.seconds || 20);
const marketCount = Number(args.markets || 20);
const users = (args.users || '1,5,10,20').split(',').map(Number);
if (
    !Number.isInteger(seconds) ||
    seconds < 5 ||
    seconds > 60 ||
    !Number.isInteger(marketCount) ||
    marketCount < 1 ||
    marketCount > 60 ||
    users.some(n => !Number.isInteger(n) || n < 1 || n > 50)
)
    throw new Error('Use 1–50 users, 1–60 markets, 5–60 seconds.');
if (!args.child) {
    const results = [];
    for (const count of users) {
        const child = spawnSync(
            process.execPath,
            [
                '--max-old-space-size=256',
                __filename,
                '--child=1',
                `--users=${count}`,
                `--markets=${marketCount}`,
                `--seconds=${seconds}`,
            ],
            { encoding: 'utf8', timeout: (seconds + 45) * 1000 }
        );
        if (child.status !== 0) throw new Error(child.stderr || child.stdout || 'Benchmark child failed');
        const result = JSON.parse(child.stdout);
        results.push(result);
        process.stdout.write(JSON.stringify(result) + '\n');
    }
    const report = {
        at: new Date().toISOString(),
        node: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        cgroupCpu: fs.existsSync('/sys/fs/cgroup/cpu.max')
            ? fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim()
            : 'unavailable',
        cgroupMemoryBytes: fs.existsSync('/sys/fs/cgroup/memory.max')
            ? fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
            : 'unavailable',
        caveats: [
            'Local offline simulation using the Even/Odd server strategy, not a measured Render capacity limit.',
            'HTTP load generator and fake brokers run inside the measured server process; their overhead is included.',
            'No real OAuth, TLS, WebSocket network, PostgreSQL analytics, static assets or browser UI load.',
            'Real engine, loopback HTTP status polling, live feed fanout, fake buys/settlements and synchronous file journals.',
            '256 MiB V8 old-space cap is not a 512 MiB process or container RAM limit.',
            'CPU % uses one core = 100%; Render 0.5 CPU is approximately 50% of one core; scheduler/disk differences remain.',
        ],
        results,
    };
    if (args.output) fs.writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');
    process.exit(0);
}
const { createAnalysisService, fileStorage } = require('../server/analysis.cjs');
const { DEFAULT_SETTINGS } = require('../.server-build/strategy');
const count = users[0],
    symbols = Array.from({ length: marketCount }, (_, i) => `SIM_${i}`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'neto-load-'));
const brokers = new Set();
let orders = 0,
    settlements = 0,
    requests = 0,
    failures = 0,
    ticks = 0,
    peakRss = process.memoryUsage().rss;
const latencies = [];
let sequence = 0;
class FakeBroker {
    connection = new EventTarget();
    listeners = new Set();
    latest = {};
    closed = false;
    constructor(id) {
        this.id = id;
        brokers.add(this);
    }
    onMessage() {
        return {
            subscribe: fn => {
                this.listeners.add(fn);
                return { unsubscribe: () => this.listeners.delete(fn) };
            },
        };
    }
    emit(data) {
        for (const fn of this.listeners) fn({ data });
    }
    async send(body) {
        if (body.portfolio) return { portfolio: { contracts: [] } };
        if (body.balance) return { balance: { balance: 10000, currency: 'USD' } };
        if (body.active_symbols)
            return {
                active_symbols: symbols.map(symbol => ({
                    symbol,
                    display_name: `Volatility ${symbol}`,
                    market: 'synthetic_index',
                    exchange_is_open: 1,
                })),
            };
        if (body.contracts_for)
            return {
                contracts_for: {
                    available: ['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'DIGITDIFF'].map(contract_type => ({
                        contract_type,
                        expiry_type: 'tick',
                        min_contract_duration: '1t',
                        max_contract_duration: '5t',
                    })),
                },
            };
        if (body.ticks_history) {
            const digits = Array.from({ length: 1000 }, (_, i) => (i % 20 < 13 ? (i % 5) * 2 : (i % 5) * 2 + 1));
            return {
                pip_size: 2,
                history: { prices: digits.map(d => 100 + d / 100), times: digits.map((_, i) => epoch - 1000 + i) },
            };
        }
        if (body.proposal) return { proposal: { ask_price: body.amount, payout: Math.round(body.amount * 190) / 100 } };
        if (body.buy) {
            orders++;
            const p = body.parameters;
            this.latest = {
                contract_id: ++sequence,
                underlying: p.symbol,
                contract_type: p.contract_type,
                barrier: p.barrier,
                currency: 'USD',
                buy_price: body.price,
                payout: Math.round(body.price * 190) / 100,
                tick_count: p.duration,
                is_sold: 0,
                entry_tick: 100.24,
            };
            return { buy: { contract_id: sequence, buy_price: body.price, payout: this.latest.payout } };
        }
        if (body.proposal_open_contract) {
            if (!this.latest.is_sold) {
                const won = this.latest.contract_id % 4 !== 0;
                this.latest = {
                    ...this.latest,
                    is_sold: 1,
                    profit: won
                        ? Math.round((this.latest.payout - this.latest.buy_price) * 100) / 100
                        : -this.latest.buy_price,
                    exit_tick: 100.28,
                };
                settlements++;
            }
            return { proposal_open_contract: this.latest };
        }
        return {};
    }
    disconnect() {
        this.closed = true;
        this.listeners.clear();
        brokers.delete(this);
    }
}
let epoch = Math.floor(Date.now() / 1000);
const saved = fileStorage(temp);
const auth = {
    publicOrigin: 'http://localhost',
    sessionExpires: () => Date.now() + 3600000,
    authorizeAccount: async (req, id) => {
        if (!/^SIMUSER_\d+$/.test(id)) throw new Error('Simulation account only');
        return { account_id: id, currency: 'USD', account_type: 'demo', status: 'active' };
    },
    connectionUrl: async (req, id) => id,
    requireTerms() {},
};
const service = createAnalysisService(auth, { storage: saved, brokerFactory: async id => new FakeBroker(id) });
const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/analysis')) return service.handle(req, res);
    res.writeHead(200);
    res.end('Simulation health OK');
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const ids = Array.from({ length: count }, (_, i) => `SIMUSER_${i}`);
    const call = async (id, body) => {
        const start = performance.now();
        try {
            const res = await fetch(`${base}/api/analysis?account_id=${id}`, {
                headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
                ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
            });
            await res.json();
            if (!res.ok) failures++;
        } catch {
            failures++;
        }
        latencies.push(performance.now() - start);
        requests++;
    };
    const settings = {
        ...DEFAULT_SETTINGS,
        strategy: 'even-odd',
        duration: 2,
        multiplier: 2.1,
        takeProfit: 0,
        stopLoss: 1000,
        maxLosses: 100,
        maxStake: 100,
    };
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const cpu = process.cpuUsage(),
        start = performance.now();
    await Promise.all(ids.map(id => call(id, { action: 'start', settings })));
    await Promise.all([...service.sessions.values()].map(session => session.task));
    const feed = setInterval(() => {
        epoch++;
        const pattern = [2, 4, 1, 2, 4, 8, 1, 3, 2, 2, 4, 8];
        for (const broker of brokers)
            for (let i = 0; i < symbols.length; i++) {
                broker.emit({
                    tick: {
                        symbol: symbols[i],
                        quote: 100 + pattern[(epoch + i) % pattern.length] / 100,
                        pip_size: 2,
                        epoch,
                    },
                });
                ticks++;
            }
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 1000);
    let rounds = 0;
    const until = performance.now() + seconds * 1000;
    while (performance.now() < until) {
        await Promise.all(ids.map(id => call(id)));
        rounds++;
        await pause(Math.max(0, 1000 - ((performance.now() - start) % 1000)));
    }
    clearInterval(feed);
    const ms = performance.now() - start,
        used = process.cpuUsage(cpu);
    lag.disable();
    latencies.sort((a, b) => a - b);
    const snapshots = [...service.sessions.values()].map(session => session.engine.getSnapshot());
    const percentile = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    const result = {
        users: count,
        marketsPerUser: marketCount,
        elapsedSeconds: +(ms / 1000).toFixed(2),
        activeBots: snapshots.filter(s => s.active).length,
        loadedFeeds: snapshots.reduce((n, s) => n + s.markets.length, 0),
        ticks,
        mockOrders: orders,
        mockSettlements: settlements,
        requests,
        httpFailures: failures,
        pollRounds: rounds,
        httpP95Ms: +percentile(latencies, 0.95).toFixed(2),
        httpMaxMs: +Math.max(...latencies).toFixed(2),
        eventLoopP99Ms: +(lag.percentile(99) / 1e6).toFixed(2),
        cpuOneCorePercent: +(((used.user + used.system) / 1000 / ms) * 100).toFixed(2),
        peakRssMiB: +(Math.max(peakRss, process.memoryUsage().rss) / 1048576).toFixed(2),
        stoppedPhases: snapshots.filter(s => !s.active).map(s => s.error || s.phase),
        journalFiles: fs.readdirSync(temp).length,
    };
    service.stopAll();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
    process.stdout.write(JSON.stringify(result));
})().catch(error => {
    service.stopAll();
    server.closeAllConnections();
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
    console.error(error);
    process.exitCode = 1;
});
