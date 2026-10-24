const { test } = require('node:test');
const assert = require('node:assert/strict');
const { watchSessionExpiry } = require('./session-expiry.cjs');

test('running connections follow renewed deadlines and still stop at actual expiry', () => {
    let clock = 0,
        expires = 1000,
        expired = 0,
        scheduled,
        cancelled;
    const stop = watchSessionExpiry(
        () => expires,
        () => expired++,
        {
            now: () => clock,
            schedule: (callback, ms) => {
                scheduled = { callback, ms };
                return 42;
            },
            cancel: id => {
                cancelled = id;
            },
        }
    );
    assert.equal(scheduled.ms, 1000);
    expires = 3000;
    clock = 1000;
    scheduled.callback();
    assert.equal(expired, 0);
    assert.equal(scheduled.ms, 2000);
    clock = 3000;
    scheduled.callback();
    assert.equal(expired, 1);
    stop();
    assert.equal(cancelled, 42);
});
test('invalidated sessions expire and cancellation prevents callbacks', () => {
    let callback,
        expired = 0,
        invalid = false;
    const stop = watchSessionExpiry(
        () => {
            if (invalid) throw new Error('revoked');
            return 1000;
        },
        () => expired++,
        {
            now: () => 0,
            schedule: next => {
                callback = next;
                return 42;
            },
            cancel: () => {},
        }
    );
    invalid = true;
    callback();
    assert.equal(expired, 1);
    stop();
    callback();
    assert.equal(expired, 1);
});
