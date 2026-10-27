// Keep long recovery waits visible without producing a journal row for every tick.
export function startXmlRecoveryProgress(message: () => string, write: (text: string) => void, active: () => boolean) {
    const started = Date.now();
    let stopped = false,
        lastWritten = -Infinity,
        lastPhase = '';
    const publish = () => {
        if (stopped || !active()) return;
        const text = message();
        const phase = text.split(' · ')[0];
        const elapsed = Date.now() - lastWritten;
        const importantTransition = phase !== lastPhase && /^(Recovery entry ready|Recovery order ready)/.test(phase);
        if (elapsed < 15000 && !importantTransition && (phase === lastPhase || elapsed < 2000)) return;
        lastWritten = Date.now();
        lastPhase = phase;
        try {
            write(`XML recovery: ${text} · ${Math.floor((Date.now() - started) / 1000)}s elapsed`);
        } catch {
            /* Logging cannot interrupt trading protection. */
        }
    };
    const stop = () => {
        stopped = true;
        clearInterval(timer);
    };
    const timer = setInterval(() => {
        if (!active()) stop();
        else publish();
    }, 1000);
    publish();
    return { update: publish, stop };
}
