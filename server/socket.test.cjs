const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Client = require('ws');
const { attachSockets } = require('./socket.cjs');

async function fixture(t, expired = false) {
    const targets = [],
        upstreams = [],
        connections = [],
        trades = [];
    class Upstream extends EventTarget {
        constructor(url) {
            super();
            this.readyState = 0;
            this.bufferedAmount = 0;
            targets.push(url);
            upstreams.push(this);
            setImmediate(() => {
                this.readyState = 1;
                this.dispatchEvent(new Event('open'));
            });
        }
        send(value) {
            this.dispatchEvent(new MessageEvent('message', { data: value }));
        }
        close() {
            this.readyState = 3;
        }
    }
    const server = http.createServer();
    const sockets = attachSockets(
        server,
        {
            publicOrigin: 'http://neto.example',
            sessionExpires: () => Date.now() + (expired ? -100 : 60000),
            connectionUrl: async (req, id) => {
                if (req.headers.cookie !== 'session=owned' || id !== 'DOT100')
                    throw Object.assign(new Error('Denied'), { status: 403 });
                return 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=test-only';
            },
        },
        undefined,
        {
            createUpstream: url => new Upstream(url),
            onConnection: (...args) => connections.push(args),
            onTrade: (...args) => trades.push(args),
        }
    );
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const socket of sockets.clients) socket.terminate();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        sockets.close();
    });
    const connect = (query = '', origin = 'http://neto.example', cookie = '') =>
        new Client(`ws://127.0.0.1:${server.address().port}/api/socket${query}`, {
            origin,
            headers: { Cookie: cookie },
        });
    return { connect, targets, upstreams, connections, trades };
}
const opened = client =>
    new Promise((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
    });
const rejected = client => new Promise(resolve => client.once('error', error => resolve(error.message)));

test('socket bridge refuses foreign origins before opening any upstream', async t => {
    const { connect, targets } = await fixture(t);
    assert.match(await rejected(connect('', 'http://attacker.example')), /403/);
    assert.equal(targets.length, 0);
});
test('account socket requires ownership in the server session', async t => {
    const { connect, targets } = await fixture(t);
    assert.match(await rejected(connect('?account_id=DOT100')), /403/);
    assert.equal(targets.length, 0);
});
test('public market socket is fixed to Deriv and forwards messages', async t => {
    const { connect, targets } = await fixture(t);
    const client = connect();
    await opened(client);
    const message = new Promise(resolve => client.once('message', value => resolve(JSON.parse(value))));
    client.send(JSON.stringify({ ticks: 'R_100', req_id: 7 }));
    assert.deepEqual(await message, { ticks: 'R_100', req_id: 7 });
    assert.deepEqual(targets, ['wss://api.derivws.com/trading/v1/options/ws/public']);
    client.close();
});
test('owned account connects using a server-issued OTP and forwards trading requests', async t => {
    const { connect, targets } = await fixture(t);
    const client = connect('?account_id=DOT100', 'http://neto.example', 'session=owned');
    await opened(client);
    const message = new Promise(resolve => client.once('message', value => resolve(JSON.parse(value))));
    const request = { proposal: 1, amount: 1, underlying_symbol: 'R_100', contract_type: 'DIGITEVEN' };
    client.send(JSON.stringify(request));
    assert.deepEqual(await message, request);
    assert.ok(targets[0].startsWith('wss://api.derivws.com/trading/v1/options/ws/demo?otp='));
    client.close();
});
test('expired sessions cannot complete a socket upgrade', async t => {
    const { connect } = await fixture(t, true);
    assert.match(await rejected(connect('?account_id=DOT100', 'http://neto.example', 'session=owned')), /401/);
});

test('owned socket analytics observe only provider trades and remove disconnected accounts', async t => {
    const { connect, upstreams, connections, trades } = await fixture(t);
    const client = connect('?account_id=DOT100', 'http://neto.example', 'session=owned');
    await opened(client);
    assert.equal(connections.length, 1);
    assert.equal(connections[0][0], 'DOT100');
    assert.equal(connections[0][2], true);
    const packet = { buy: { contract_id: 123, buy_price: 0.35 } };
    upstreams[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(trades, [['DOT100', packet.buy]]);
    const closed = new Promise(resolve => client.once('close', resolve));
    client.close();
    await closed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connections.at(-1)[2], false);
});

test('background Builder stream ignores other tools and only reports settlements for its own receipts', async t => {
    const { connect, upstreams, trades } = await fixture(t);
    const client = connect('?account_id=DOT100', 'http://neto.example', 'session=owned');
    await opened(client);
    const emit = packet => upstreams[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) }));
    // HIT AND RUN recovery settles on the same account-wide subscription.
    emit({ proposal_open_contract: { contract_id: 987, buy_price: 14.39, is_sold: 1, profit: 12.66 } });
    assert.equal(trades.length, 0);
    emit({ buy: { contract_id: 123, buy_price: 0.35 } });
    emit({ proposal_open_contract: { contract_id: 123, buy_price: 0.35, is_sold: 0, profit: -0.35 } });
    const settlement = { contract_id: 123, buy_price: 0.35, is_sold: 1, profit: 0.12 };
    emit({ proposal_open_contract: settlement });
    assert.equal(trades.length, 2);
    assert.deepEqual(trades[1], ['DOT100', settlement]);
    // A new browser connection can observe a known Builder purchase's settlement.
    const other = connect('?account_id=DOT100', 'http://neto.example', 'session=owned');
    await opened(other);
    upstreams[1].dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify({ proposal_open_contract: settlement }) })
    );
    assert.equal(trades.length, 3);
    client.close();
    other.close();
});
