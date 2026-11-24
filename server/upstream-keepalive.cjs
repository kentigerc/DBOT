// Application-level Deriv pings are separate from browser WebSocket ping frames.
function startUpstreamKeepalive(
    upstream,
    { schedule = setInterval, cancel = clearInterval, setDeadline = setTimeout, clearDeadline = clearTimeout, onTimeout = () => {} } = {}
) {
    let stopped = false;
    let deadline;
    const timer = schedule(() => {
        if (stopped || deadline !== undefined || upstream.readyState !== 1) return;
        try {
            upstream.send(JSON.stringify({ ping: 1 }));
            deadline = setDeadline(() => {
                keepalive.stop();
                onTimeout();
            }, 10000);
            deadline?.unref?.();
        } catch {
            keepalive.stop();
            onTimeout();
        }
    }, 25000);
    timer?.unref?.();
    const keepalive = {
        consume(packet) {
            if (deadline === undefined || packet?.req_id != null || packet?.msg_type !== 'ping' || packet?.ping !== 'pong')
                return false;
            clearDeadline(deadline);
            deadline = undefined;
            return true;
        },
        stop() {
            stopped = true;
            cancel(timer);
            clearDeadline(deadline);
            deadline = undefined;
        },
    };
    return keepalive;
}
module.exports = { startUpstreamKeepalive };
