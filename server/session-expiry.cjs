// Re-read the authorization deadline: a browser refresh can renew the same session.
function watchSessionExpiry(
    getExpires,
    onExpired,
    { now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}
) {
    let timer;
    let stopped = false;
    const check = () => {
        if (stopped) return;
        let remaining;
        try {
            remaining = getExpires() - now();
        } catch {
            remaining = 0;
        }
        if (!Number.isFinite(remaining) || remaining <= 0) {
            stopped = true;
            onExpired();
            return;
        }
        timer = schedule(check, Math.min(remaining, 2147483647));
        timer.unref?.();
    };
    check();
    return () => {
        stopped = true;
        cancel(timer);
    };
}
module.exports = { watchSessionExpiry };
