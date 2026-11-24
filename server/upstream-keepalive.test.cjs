const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startUpstreamKeepalive } = require('./upstream-keepalive.cjs');
function setup() {
    let tick,
        interval,
        cancelled = false;
    const sent = [];
    const socket = { readyState: 1, send: text => sent.push(JSON.parse(text)) };
    const keepalive = startUpstreamKeepalive(socket, {
        schedule: (callback, ms) => {
            tick = callback;
            interval = ms;
            return 1;
        },
        cancel: () => {
            cancelled = true;
        },
    });
    return { socket, sent, keepalive, tick: () => tick(), interval: () => interval, cancelled: () => cancelled };
}
test('sends only a non-trading ping every 25 seconds on the provider connection', () => {
    const f = setup();
    assert.equal(f.interval(), 25000);
    f.tick();
    assert.deepEqual(f.sent, [{ ping: 1 }]);
});
test('consumes only its own unnumbered pong, preserving client ping responses and trade packets', () => {
    const f = setup();
    assert.equal(f.keepalive.consume({ msg_type: 'ping', ping: 'pong' }), false);
    f.tick();
    assert.equal(f.keepalive.consume({ msg_type: 'buy', buy: { contract_id: 1 } }), false);
    assert.equal(f.keepalive.consume({ msg_type: 'ping', ping: 'pong', req_id: 10 }), false);
    assert.equal(f.keepalive.consume({ msg_type: 'ping', ping: 'pong' }), true);
    assert.equal(f.keepalive.consume({ msg_type: 'ping', ping: 'pong' }), false);
});
test('does not ping a closed socket and stops the timer when the bridge closes', () => {
    const f = setup();
    f.socket.readyState = 3;
    f.tick();
    assert.equal(f.sent.length, 0);
    f.keepalive.stop();
    f.socket.readyState = 1;
    f.tick();
    assert.equal(f.cancelled(), true);
    assert.equal(f.sent.length, 0);
});
test('a synchronous send failure does not crash the server timer', () => {
    const f = setup();
    f.socket.send = () => {
        throw new Error('socket closed');
    };
    assert.doesNotThrow(() => f.tick());
});

test('closes a silent provider once and cancels a deadline on its matching pong', () => {
    let tick, deadline, expired = 0;
    const socket = { readyState: 1, send() {} };
    const keepalive = startUpstreamKeepalive(socket, {
        schedule: callback => { tick = callback; },
        cancel() {},
        setDeadline: (callback, ms) => {
            assert.equal(ms, 10000);
            deadline = callback;
            return 1;
        },
        clearDeadline: () => { deadline = undefined; },
        onTimeout: () => { expired++; },
    });
    tick();
    assert.ok(deadline);
    assert.equal(keepalive.consume({ msg_type: 'ping', ping: 'pong', req_id: 42 }), false);
    assert.ok(deadline);
    assert.equal(keepalive.consume({ msg_type: 'ping', ping: 'pong' }), true);
    assert.equal(deadline, undefined);
    tick();
    deadline();
    assert.equal(expired, 1);
    tick();
    assert.equal(deadline, undefined);
});
