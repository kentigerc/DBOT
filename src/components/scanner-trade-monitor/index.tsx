import { useEffect, useState, useSyncExternalStore } from 'react';
import { observer } from 'mobx-react-lite';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { useStore } from '@/hooks/useStore';
import { lastDigit } from '@/pages/digit-analysis/digits';
import { risingScannerDigits, scannerExitGuard } from '@/utils/scanner-exit-guard';
import { getScannerWatch, setScannerWatch, subscribeScannerWatch } from '@/utils/scanner-watch';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';

type Tick = { quote: number; epoch: number; pip_size: number; symbol?: string; underlying_symbol?: string };
const ScannerTradeMonitor = observer(() => {
    const { run_panel } = useStore();
    const target = useSyncExternalStore(subscribeScannerWatch, getScannerWatch);
    const running = run_panel.is_running;
    const workspaceName = (window as unknown as { Blockly?: { xmlValues?: { file_name?: string } } }).Blockly?.xmlValues
        ?.file_name;
    const [workspaceSymbol, setWorkspaceSymbol] = useState('');
    useEffect(() => {
        if (!running) {
            setWorkspaceSymbol('');
            return;
        }
        const workspace = (
            window as unknown as {
                Blockly?: {
                    derivWorkspace?: {
                        getAllBlocks: () => {
                            type: string;
                            data?: string;
                            getFieldValue: (name: string) => string | null;
                        }[];
                        addChangeListener: (listener: () => void) => void;
                        removeChangeListener: (listener: () => void) => void;
                    };
                };
            }
        ).Blockly?.derivWorkspace;
        const read = () => {
            const blocks = workspace?.getAllBlocks() || [];
            const symbol =
                blocks.find(block => block.type === 'trade_definition_market')?.getFieldValue('SYMBOL_LIST') || '';
            setWorkspaceSymbol(symbol);
            const sources = blocks.map(block => block.data);
            const over = sources.includes('netoacademy:hosted-bot:over-punisher.xml');
            const under = sources.includes('netoacademy:hosted-bot:under-punisher.xml');
            const side = over && !under ? 'over' : under && !over ? 'under' : undefined;
            if (side && /^(R_\d+|1HZ\d+V)$/.test(symbol)) {
                if (!target || target.side !== side)
                    setScannerWatch({
                        symbol,
                        side,
                        sampleSize: target?.sampleSize || 1000,
                        name: side === 'over' ? 'Over Punisher' : 'Under Punisher',
                    });
            } else if (!side && target && workspaceName && workspaceName !== target.name) {
                setScannerWatch(null);
            }
        };
        read();
        workspace?.addChangeListener(read);
        return () => workspace?.removeChangeListener(read);
    }, [target, running, workspaceName]);
    useEffect(() => {
        if (!target || !running) return;
        let disposed = false;
        let exhausted = false;
        let api: Awaited<ReturnType<typeof generateDerivApiInstance>> | undefined;
        let listener: { unsubscribe: () => void } | undefined;
        let attempt = 0;
        let ready = false;
        let lastEpoch = 0;
        let lastUpdate = Date.now();
        let connectingSince = Date.now();
        let recoveryStarted: number | undefined;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let digits: number[] = [];
        const fresh = (epoch: number) => Date.now() / 1000 - epoch <= 6 && epoch <= Date.now() / 1000 + 2;
        const detach = () => {
            attempt++;
            listener?.unsubscribe();
            listener = undefined;
            api?.disconnect();
            api = undefined;
        };
        const evaluate = () => {
            if (disposed || !fresh(lastEpoch)) return;
            lastUpdate = Date.now();
            recoveryStarted = undefined;
            if (xmlScannerCycle.getSnapshot().phase === 'switching') return;
            // Check the saved percentage guard before releasing a paused purchase.
            if (target.baselineCounts) {
                const counts = Array<number>(10).fill(0);
                digits.forEach(digit => counts[digit]++);
                if (risingScannerDigits(target.baselineCounts, counts, target.side, target.sampleSize).length >= 2)
                    scannerExitGuard.trigger();
            }
            xmlScannerCycle.market(target.symbol, digits, lastEpoch);
        };
        const reconnect = (reason: string) => {
            if (disposed || exhausted || retry !== undefined) return;
            xmlScannerCycle.pauseMarket(target.symbol);
            recoveryStarted ??= Date.now();
            ready = false;
            detach();
            if (Date.now() - recoveryStarted >= 20000) {
                exhausted = true;
                xmlScannerCycle.stop(
                    `Live monitoring could not reconnect within 20 seconds (${target.symbol}; ${reason}). New purchases stopped.`
                );
                return;
            }
            retry = setTimeout(() => {
                retry = undefined;
                void connect();
            }, 1000);
        };
        const connect = async () => {
            connectingSince = Date.now();
            ready = false;
            const current = ++attempt;
            const active = () => !disposed && !exhausted && current === attempt;
            const queued: Tick[] = [];
            try {
                const connection = await generateDerivApiInstance({ publicOnly: true });
                if (!active()) {
                    connection.disconnect();
                    return;
                }
                api = connection;
                connection.connection.addEventListener('close', (event: CloseEvent) => {
                    if (active()) reconnect(`socket ${event.code}; ${document.hidden ? 'background' : 'visible'} tab`);
                });
                connection.connection.addEventListener('error', () => {
                    if (active()) reconnect('connection error');
                });
                const accept = (tick: Tick) => {
                    if (!active() || tick.epoch <= lastEpoch) return;
                    const digit = lastDigit(tick.quote, tick.pip_size);
                    if (digit === null || !Number.isFinite(tick.epoch) || !fresh(tick.epoch)) {
                        reconnect('invalid or stale market tick');
                        return;
                    }
                    if (lastEpoch && tick.epoch - lastEpoch > 6) {
                        reconnect('missed market ticks');
                        return;
                    }
                    lastEpoch = tick.epoch;
                    digits = [...digits, digit].slice(-target.sampleSize);
                    evaluate();
                };
                listener = connection.onMessage().subscribe(({ data }: { data: { tick?: Tick; error?: unknown } }) => {
                    if (!active()) return;
                    if (data.error) {
                        reconnect('subscription error');
                        return;
                    }
                    if (!data.tick) return;
                    const symbol = data.tick.symbol || data.tick.underlying_symbol;
                    if (symbol && symbol !== target.symbol) return;
                    if (!ready) queued.push(data.tick);
                    else accept(data.tick);
                });
                const history = await connection.send({
                    ticks_history: target.symbol,
                    style: 'ticks',
                    end: 'latest',
                    count: target.sampleSize,
                    subscribe: 1,
                });
                if (!active()) return;
                if (!Array.isArray(history.history?.prices) || !Number.isInteger(history.pip_size))
                    throw new Error('Missing history');
                digits = (history.history.prices as number[])
                    .map(price => lastDigit(price, history.pip_size))
                    .filter((digit): digit is number => digit !== null)
                    .slice(-target.sampleSize);
                const times = history.history.times as number[] | undefined;
                lastEpoch = times?.[times.length - 1] || 0;
                if (digits.length !== target.sampleSize || !Number.isFinite(lastEpoch) || !fresh(lastEpoch))
                    throw new Error('Incomplete or stale history');
                ready = true;
                evaluate();
                queued.forEach(accept);
            } catch {
                if (active()) reconnect('market history unavailable');
            }
        };
        const checkFreshness = () => {
            if (disposed || exhausted) return;
            if (recoveryStarted !== undefined && Date.now() - recoveryStarted >= 20000) {
                exhausted = true;
                clearTimeout(retry);
                retry = undefined;
                detach();
                xmlScannerCycle.stop(
                    `Live monitoring could not reconnect within 20 seconds (${target.symbol}). New purchases stopped.`
                );
                return;
            }
            if (Date.now() - (ready ? lastUpdate : connectingSince) > 5000) reconnect('market data delayed');
        };
        void connect();
        const freshness = setInterval(checkFreshness, 1000);
        window.addEventListener('focus', checkFreshness);
        document.addEventListener('visibilitychange', checkFreshness);
        return () => {
            disposed = true;
            clearInterval(freshness);
            clearTimeout(retry);
            window.removeEventListener('focus', checkFreshness);
            document.removeEventListener('visibilitychange', checkFreshness);
            detach();
        };
    }, [target, running]);
    useEffect(() => {
        // Auto changes the live engine market without restarting XML. Its own
        // purchase gate and scanner link are authoritative during that handoff.
        if (
            !xmlScannerCycle.getSnapshot().enabled &&
            target &&
            running &&
            workspaceSymbol &&
            workspaceSymbol !== target.symbol
        )
            xmlScannerCycle.stop('The bot market was changed after the scanner match. Start a fresh scan.');
    }, [target, running, workspaceSymbol]);
    // Monitoring and automatic protection continue without any floating warning UI.
    return null;
});
export default ScannerTradeMonitor;
