// Application-level Deriv pings are separate from browser WebSocket ping frames.
function startUpstreamKeepalive(upstream, { schedule = setInterval, cancel = clearInterval } = {}) {
    let stopped = false;
    let pending = false;
    const timer = schedule(() => {
        if (stopped || upstream.readyState !== 1) return;
        try {
            upstream.send(JSON.stringify({ ping: 1 }));
            pending = true;
        } catch {
            // The existing socket close/error handler owns connection shutdown.
        }
    }, 25000);
    timer.unref?.();
    return {
        consume(packet) {
            if (!pending || packet?.req_id != null || packet?.msg_type !== 'ping' || packet?.ping !== 'pong')
                return false;
            pending = false;
            return true;
        },
        stop() {
            stopped = true;
            cancel(timer);
        },
    };
}
module.exports = { startUpstreamKeepalive };
